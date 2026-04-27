import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { navigate, playHref } from '../router.js';
import type { Episode } from '../types.js';
import { snapToAnchor } from './strip-scroll.js';
import './watched-button.js';
import type { WatchedButtonExtraItem } from './watched-button.js';

// ---------- pure helpers (exported for unit tests) ----------

export type HeroMode = 'resume' | 'next' | 'allWatched';

export interface HeroPick {
  hero: Episode | null;
  mode: HeroMode;
}

const RESUME_THRESHOLD = 0.9;

/**
 * Pick the season's hero episode following the deterministic rule (0.1.3.1 D4):
 *  1. Highest-numbered episode with active progress (0 < pos/dur < 0.9 and not watched)
 *  2. Otherwise first unwatched episode in season order
 *  3. Otherwise (all watched) → no hero, render uniform minis
 */
export function pickHero(eps: Episode[]): HeroPick {
  for (let i = eps.length - 1; i >= 0; i--) {
    const e = eps[i]!;
    if (
      e.duration > 0 &&
      e.position > 0 &&
      e.position / e.duration < RESUME_THRESHOLD &&
      !e.watched
    ) {
      return { hero: e, mode: 'resume' };
    }
  }
  for (const e of eps) {
    if (!e.watched) return { hero: e, mode: 'next' };
  }
  return { hero: null, mode: 'allWatched' };
}

export interface PartitionResult {
  before: Episode[];
  after: Episode[];
}

/** Split a season's episodes around the hero (preserving order). */
export function partition(eps: Episode[], hero: Episode | null): PartitionResult {
  if (!hero) return { before: [], after: [] };
  const idx = eps.findIndex((e) => e.path === hero.path);
  if (idx < 0) return { before: [], after: [...eps] };
  return { before: eps.slice(0, idx), after: eps.slice(idx + 1) };
}

/** "58m" / "1h 3m" / null when the input is null. */
export function formatRuntime(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Header status string per spec, e.g. "In progress · 7 / 15 watched". */
export function formatStatus(eps: Episode[]): string {
  const total = eps.length;
  const watched = eps.reduce((n, e) => n + (e.watched ? 1 : 0), 0);
  if (total === 0) return 'No episodes';
  if (watched === 0) return `Not started · 0 / ${total} watched`;
  if (watched === total) return `Watched · ${total} / ${total} watched`;
  return `In progress · ${watched} / ${total} watched`;
}

/** Pick the runtime to show on the duration badge: live duration first, then expected. */
export function pickBadgeRuntime(ep: Episode): number | null {
  if (ep.duration > 0) return ep.duration;
  return ep.runtimeSeconds;
}

/** Two-digit episode number for caption prefixes ("4" → "04"). */
export function padEp(num: number): string {
  return String(num).padStart(2, '0');
}

/**
 * How many half-viewport "pages" the strip's scroll range divides into.
 *
 * Sub-viewport stepping (one click ≈ half the visible width) gives a much
 * finer-grained pager than one-page-per-viewport: a strip needing two
 * viewport-widths of scroll renders ~5 dots instead of 2, so each click is
 * a smaller jump and the dot trail reads as scroll progress.
 *
 * Returns 0 when there's no overflow at all (so the pager hides itself).
 * Capped at `maxPages` so a 50-episode strip doesn't render 50 dots — the
 * pager would dominate the row.
 */
export function computePageCount(
  scrollWidth: number,
  clientWidth: number,
  maxPages = 16,
): number {
  if (clientWidth <= 0 || scrollWidth <= clientWidth + 1) return 0;
  const step = clientWidth / 2;
  // Steps needed = ceil(extra-scroll / half-viewport) + 1 anchor for the start.
  const extra = scrollWidth - clientWidth;
  const steps = Math.max(2, Math.ceil(extra / step) + 1);
  return Math.min(maxPages, steps);
}

/** Map a scrollLeft value to its page index, clamped to [0, pageCount-1].
 *  Mirrors the half-viewport step used by `computePageCount`.
 *
 *  `maxScroll` (= scrollWidth - clientWidth) is needed because the final dot's
 *  nominal position can exceed maxScroll when the trailing chunk is shorter
 *  than half a viewport. Without this, scrolling to the end rounds down to
 *  the second-to-last dot. */
export function pageFromScroll(
  scrollLeft: number,
  clientWidth: number,
  pageCount: number,
  maxScroll = Infinity,
): number {
  if (pageCount <= 0 || clientWidth <= 0) return 0;
  // At end of scroll → always light the last dot. 1px slack covers sub-pixel
  // rounding from native smooth-scroll / trackpad inertia.
  if (Number.isFinite(maxScroll) && scrollLeft >= maxScroll - 1) {
    return pageCount - 1;
  }
  const step = clientWidth / 2;
  const raw = Math.round(scrollLeft / step);
  return Math.min(pageCount - 1, Math.max(0, raw));
}

// ---------- component ----------

@customElement('season-strip')
export class SeasonStrip extends LitElement {
  static override styles = css`
    :host {
      display: block;
      /* Thumbnail dimensions (16:9). */
      --hm-mini-w: 200px;
      --hm-mini-h: 112.5px;
      --hm-gap: 12px;
      /* Per-cell text strip (two-line caption) sitting under each thumbnail. */
      --hm-meta-h: 40px;
      /* Full cell = thumb + meta. Two stacked minis equal one hero card. */
      --hm-mini-cell-h: calc(var(--hm-mini-h) + var(--hm-meta-h));
      --hm-hero-w: calc(var(--hm-mini-w) * 2 + var(--hm-gap));
      --hm-hero-cell-h: calc(var(--hm-mini-cell-h) * 2 + var(--hm-gap));
      /* The hero's thumb expands to fill the rest of its cell. */
      --hm-hero-thumb-h: calc(var(--hm-hero-cell-h) - var(--hm-meta-h));
      --hm-accent: var(--accent);
    }

    .season-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0 4px 10px;
      font-size: 14px;
    }
    .season-header .num {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .season-header .status { color: var(--text-secondary); font-size: 13px; }

    .strip {
      overflow-x: auto;
      overflow-y: hidden;
      scroll-behavior: auto;
      /* Hide the native scrollbar — replaced by the dot pager below. */
      scrollbar-width: none;
      padding: 4px 4px 10px;
    }
    .strip::-webkit-scrollbar { display: none; }

    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 6px 4px 0;
      user-select: none;
    }
    .pager.hidden { display: none; }
    .pager-btn {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      width: 28px;
      height: 24px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .pager-btn:hover:not(:disabled) {
      border-color: var(--accent);
      color: var(--text-primary);
    }
    .pager-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .pager-btn svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    .dots {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--surface-pressed);
      border: none;
      padding: 0;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
    }
    .dot:hover { background: var(--text-tertiary); }
    .dot.active {
      background: var(--accent);
      transform: scale(1.25);
      box-shadow: var(--shadow-accent);
    }

    .row {
      display: flex;
      flex-direction: row;
      gap: var(--hm-gap);
      align-items: flex-start;
      width: max-content;
      min-height: var(--hm-hero-cell-h);
    }

    .grid {
      display: grid;
      grid-auto-flow: column;
      grid-template-rows: var(--hm-mini-cell-h) var(--hm-mini-cell-h);
      gap: var(--hm-gap);
    }

    .mini {
      width: var(--hm-mini-w);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mini .thumb-wrap {
      position: relative;
      width: var(--hm-mini-w);
      height: var(--hm-mini-h);
      background: var(--surface-elevated);
      border-radius: var(--radius-xs);
      overflow: hidden;
      border: 1px solid var(--border-strong);
    }
    .mini img,
    .mini .placeholder {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .mini .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-disabled);
      font-size: 28px;
      font-weight: 600;
    }
    .mini .caption {
      font-size: 12px;
      color: var(--text-primary);
      line-height: 1.3;
      padding: 0 1px;
      /* Two-line clamp; reserves the room either way (long titles wrap, short ones leave whitespace). */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      height: calc(1.3em * 2);
    }
    .mini .caption .ep-num {
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
      margin-right: 4px;
    }

    .mini.watched .thumb-wrap img,
    .mini.watched .thumb-wrap .placeholder { opacity: 0.5; }
    .mini.watched .caption { color: var(--text-tertiary); }
    .mini.watched .caption .ep-num { color: var(--text-disabled); }

    .mini:hover .thumb-wrap { border-color: var(--accent); }
    .mini:hover img,
    .mini:hover .placeholder { filter: brightness(1.15); }
    .mini.watched:hover .thumb-wrap img,
    .mini.watched:hover .thumb-wrap .placeholder { opacity: 0.7; }
    .mini:hover .caption { color: var(--text-primary); }

    /* Old static check overlay removed in favor of <watched-button>. */

    .duration-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      font-size: 11px;
      color: var(--on-scrim);
      background: var(--scrim-strong);
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      letter-spacing: 0.5px;
      font-variant-numeric: tabular-nums;
    }

    .hero {
      width: var(--hm-hero-w);
      height: var(--hm-hero-cell-h);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hero .thumb-wrap {
      position: relative;
      width: var(--hm-hero-w);
      height: var(--hm-hero-thumb-h);
      flex: 0 0 auto;
      background: var(--surface-elevated);
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 2px solid var(--accent);
      box-shadow: var(--shadow-accent);
      transition: filter 0.12s ease;
    }
    .hero:hover .thumb-wrap { filter: brightness(1.08); }
    .hero:hover .play-overlay .circle { background: var(--scrim-soft); }
    .hero img,
    .hero .placeholder {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .hero.watched img,
    .hero.watched .placeholder { opacity: 0.5; }
    .hero.watched .caption { color: var(--text-tertiary); }
    .hero .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-disabled);
      font-size: 56px;
      font-weight: 600;
    }
    .hero .accent-label {
      position: absolute;
      top: 10px;
      left: 10px;
      font-size: 11px;
      color: var(--on-accent);
      background: var(--accent);
      padding: 3px 10px;
      border-radius: var(--radius-xs);
      text-transform: uppercase;
      letter-spacing: 1.2px;
      font-weight: 700;
      box-shadow: var(--shadow-accent);
    }
    .hero .play-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .hero .play-overlay .circle {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--scrim-soft);
      border: 2px solid rgba(255, 255, 255, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hero .play-overlay .triangle {
      width: 0;
      height: 0;
      border-left: 16px solid var(--on-scrim);
      border-top: 11px solid transparent;
      border-bottom: 11px solid transparent;
      margin-left: 5px;
    }
    .hero .progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 4px;
      background: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .hero .caption {
      font-size: 15px;
      color: var(--text-primary);
      font-weight: 600;
      line-height: 1.3;
      padding: 0 2px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      height: calc(1.3em * 2);
    }
    .hero .caption .ep-num {
      color: var(--text-secondary);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      margin-right: 6px;
    }
  `;

  @property({ type: Number }) seasonNumber = 1;
  @property({ attribute: false }) episodes: Episode[] = [];
  @property({ type: Boolean }) isCurrent = false;
  /** True while any scan-flavored job runs — disables the per-episode
   *  Re-probe action so concurrent calls don't 409. */
  @property({ type: Boolean }) jobActive = false;

  /** Pager state — number of viewport-width pages, and which page is active.
   *  Recomputed whenever the strip's scroll geometry changes (mount, resize,
   *  episode list change). Active page tracks user scrolls too. */
  @state() private pageCount = 0;
  @state() private currentPage = 0;

  private hasMounted = false;
  private lastHeroPath: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  override firstUpdated(): void {
    const { hero } = pickHero(this.episodes);
    this.lastHeroPath = hero ? hero.path : null;
    requestAnimationFrame(() => {
      this.snapToHero(false);
      this.recomputePager();
    });
    this.hasMounted = true;
    this.attachScrollListeners();
  }

  override updated(changed: Map<string, unknown>): void {
    if (!this.hasMounted) return;
    if (changed.has('episodes')) {
      const { hero } = pickHero(this.episodes);
      const newPath = hero ? hero.path : null;
      if (newPath !== this.lastHeroPath) {
        this.lastHeroPath = newPath;
        requestAnimationFrame(() => this.snapToHero(true));
      }
      // Episode list changed → strip width almost certainly changed too.
      requestAnimationFrame(() => this.recomputePager());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Wire up scroll + resize listeners that drive `currentPage` / `pageCount`. */
  private attachScrollListeners(): void {
    const root = this.renderRoot as ShadowRoot;
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!strip) return;
    strip.addEventListener('scroll', () => this.syncCurrentPage(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.recomputePager());
      this.resizeObserver.observe(strip);
    }
  }

  private recomputePager(): void {
    const root = this.renderRoot as ShadowRoot;
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!strip) return;
    const pages = computePageCount(strip.scrollWidth, strip.clientWidth);
    this.pageCount = pages;
    this.syncCurrentPage();
  }

  private syncCurrentPage(): void {
    const root = this.renderRoot as ShadowRoot;
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!strip) return;
    const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
    this.currentPage = pageFromScroll(
      strip.scrollLeft,
      strip.clientWidth,
      this.pageCount,
      maxScroll,
    );
  }

  private goToPage(page: number, smooth = true): void {
    const root = this.renderRoot as ShadowRoot;
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!strip) return;
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    // Each step shifts by half a viewport — finer-grained than one-page-per-step.
    const step = strip.clientWidth / 2;
    const target = Math.min(max, Math.max(0, page * step));
    if (smooth && typeof strip.scrollTo === 'function') {
      strip.scrollTo({ left: target, behavior: 'smooth' });
    } else {
      strip.scrollLeft = target;
    }
  }

  private onPrevPage(): void {
    this.goToPage(Math.max(0, this.currentPage - 1));
  }

  private onNextPage(): void {
    this.goToPage(Math.min(this.pageCount - 1, this.currentPage + 1));
  }

  private snapToHero(smooth: boolean): void {
    const root = this.renderRoot as ShadowRoot;
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!strip) return;
    const heroEl = root.querySelector<HTMLElement>('.hero');
    snapToAnchor(strip, heroEl, 'center', smooth);
    // Native smooth-scroll fires its own scroll events that update the page.
    // Instant snaps would otherwise leave the dot stale until next interaction.
    if (!smooth) requestAnimationFrame(() => this.syncCurrentPage());
  }

  override render(): unknown {
    const eps = this.episodes;
    const { hero, mode } = pickHero(eps);
    const { before, after } = partition(eps, hero);
    const showPager = this.pageCount > 1;

    return html`
      <div class="season-header">
        <span class="num">Season ${this.seasonNumber}</span>
        <span class="status">${formatStatus(eps)}</span>
      </div>
      <div class="strip">
        <div class="row">
          ${before.length ? this.renderGrid(before) : null}
          ${hero ? this.renderHero(hero, mode) : null}
          ${mode === 'allWatched' ? this.renderGrid(eps) : null}
          ${after.length ? this.renderGrid(after) : null}
        </div>
      </div>
      <div class=${showPager ? 'pager' : 'pager hidden'}>
        <button
          class="pager-btn"
          ?disabled=${this.currentPage === 0}
          title="Scroll left"
          @click=${(): void => this.onPrevPage()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="dots">
          ${Array.from({ length: this.pageCount }, (_, i) => html`
            <button
              class=${i === this.currentPage ? 'dot active' : 'dot'}
              title=${`Page ${i + 1} of ${this.pageCount}`}
              @click=${(): void => this.goToPage(i)}
            ></button>
          `)}
        </div>
        <button
          class="pager-btn"
          ?disabled=${this.currentPage >= this.pageCount - 1}
          title="Scroll right"
          @click=${(): void => this.onNextPage()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    `;
  }

  private renderGrid(eps: Episode[]): unknown {
    return html`
      <div class="grid">
        ${eps.map((ep) => this.renderMini(ep))}
      </div>
    `;
  }

  private renderMini(ep: Episode): unknown {
    const badge = formatRuntime(pickBadgeRuntime(ep));
    const cls = ep.watched ? 'mini watched' : 'mini';
    return html`
      <div
        class=${cls}
        @click=${(): void => navigate(playHref(ep.path))}
        title=${ep.title ?? ''}
      >
        <div class="thumb-wrap">
          ${ep.stillUrl
            ? html`<img src=${ep.stillUrl} alt="" loading="lazy" />`
            : html`<div class="placeholder">E${ep.episode}</div>`}
          <watched-button
            .watched=${ep.watched}
            .kind=${'episode'}
            .extraItems=${this.episodeExtraItems(ep)}
            @click=${(e: Event): void => e.stopPropagation()}
            @watched-change=${(e: CustomEvent<{ watched: boolean }>): void => this.onEpisodeWatchedChange(ep, e)}
          ></watched-button>
          ${badge ? html`<span class="duration-badge">${badge}</span>` : null}
        </div>
        <div class="caption">
          <span class="ep-num">${padEp(ep.episode)} -</span>${ep.title ?? ''}
        </div>
      </div>
    `;
  }

  private renderHero(ep: Episode, mode: HeroMode): unknown {
    const labelText =
      mode === 'resume'
        ? `CONTINUE · S${ep.season} · E${ep.episode}`
        : `UP NEXT · S${ep.season} · E${ep.episode}`;
    const badge = formatRuntime(pickBadgeRuntime(ep));
    const ratio =
      mode === 'resume' && ep.duration > 0
        ? Math.max(0, Math.min(1, ep.position / ep.duration))
        : 0;
    const cls = ep.watched ? 'hero watched' : 'hero';
    return html`
      <div
        class=${cls}
        @click=${(): void => navigate(playHref(ep.path))}
        title=${ep.title ?? ''}
      >
        <div class="thumb-wrap">
          ${ep.stillUrl
            ? html`<img src=${ep.stillUrl} alt="" />`
            : html`<div class="placeholder">E${ep.episode}</div>`}
          <span class="accent-label">${labelText}</span>
          <div class="play-overlay"><div class="circle"><div class="triangle"></div></div></div>
          <watched-button
            .watched=${ep.watched}
            .kind=${'episode'}
            .extraItems=${this.episodeExtraItems(ep)}
            @click=${(e: Event): void => e.stopPropagation()}
            @watched-change=${(e: CustomEvent<{ watched: boolean }>): void => this.onEpisodeWatchedChange(ep, e)}
          ></watched-button>
          ${badge ? html`<span class="duration-badge">${badge}</span>` : null}
          ${mode === 'resume'
            ? html`<div class="progress" style=${`width: ${ratio * 100}%`}></div>`
            : null}
        </div>
        <div class="caption">
          <span class="ep-num">${padEp(ep.episode)} -</span>${ep.title ?? ep.path}
        </div>
      </div>
    `;
  }

  /** 0.1.5.1 / 0.1.5.2 — extras for the per-episode <watched-button> menu.
   *  Surfaces "Re-probe episode" and "Identify manually…" alongside the
   *  built-in Mark watched/unwatched items so there's only one ⋮ per tile. */
  private episodeExtraItems(ep: Episode): WatchedButtonExtraItem[] {
    return [
      {
        label: 'Re-probe episode',
        disabled: this.jobActive,
        onClick: (): void => this.dispatchReprobeEpisode(ep),
      },
      {
        label: 'Identify manually…',
        disabled: this.jobActive,
        onClick: (): void => this.dispatchManualIdentifyEpisode(ep),
      },
    ];
  }

  private dispatchReprobeEpisode(ep: Episode): void {
    this.dispatchEvent(
      new CustomEvent('reprobe-episode-trigger', {
        detail: { id: ep.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 0.1.5.2 — open the manual-identify modal targeting this episode. The
   *  parent series-detail catches it, attaches the seriesTitle, and re-
   *  dispatches `manual-identify-request` upward to <app-shell>. */
  private dispatchManualIdentifyEpisode(ep: Episode): void {
    this.dispatchEvent(
      new CustomEvent('manual-identify-episode-request', {
        detail: { id: ep.id, episode: ep },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onEpisodeWatchedChange(
    ep: Episode,
    e: CustomEvent<{ watched: boolean }>,
  ): void {
    this.dispatchEvent(
      new CustomEvent('episode-watched-change', {
        detail: { path: ep.path, watched: e.detail.watched },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
