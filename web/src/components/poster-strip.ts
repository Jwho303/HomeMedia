import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { navigate } from '../router.js';
import {
  formatTimeRemaining,
  isNew,
  type HomeCardItem,
} from './home-chunks.js';
import './watched-button.js';

/**
 * Wrapping grid of 2:3 poster cards used by `<home-view>`.
 *
 * Library posters wrap onto multiple rows rather than scroll horizontally —
 * the page is meant to be browsed top-to-bottom, scroll-free per chunk.
 * (Episode strips inside `<season-strip>` still scroll horizontally with a
 * paged dot navigator.) The `anchorIndex` property is accepted for API
 * compatibility but no longer drives any DOM behavior here.
 */
@customElement('poster-strip')
export class PosterStrip extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --hm-card-w: 125px;
      --hm-card-poster-h: 187.5px;
      --hm-card-gap: 10px;
      --hm-card-meta-h: 36px;
      --hm-accent: var(--accent);
    }

    .strip-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0 4px 8px;
    }
    .strip-header .heading {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .strip-header .subtitle {
      color: var(--text-secondary);
      font-size: 12px;
    }

    .strip {
      padding: 4px 4px 10px;
    }

    /* Library posters wrap onto multiple rows instead of scrolling horizontally.
     *  Episode strips still scroll — see <season-strip>. */
    .row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: var(--hm-card-gap);
      align-items: flex-start;
    }

    .card {
      width: var(--hm-card-w);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .poster {
      position: relative;
      width: var(--hm-card-w);
      height: var(--hm-card-poster-h);
      background: var(--surface-elevated);
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border-strong);
    }
    /* 0.2.0 — D-pad focus highlight. The focus-nav controller adds .hm-focus to
     *  the whole card; we light up the poster box (accent border + ring + a
     *  slight lift) so it reads as "this poster is selected" from across the
     *  room — distinct from the small kebab hover. */
    .card.hm-focus { outline: none; }
    .card.hm-focus .poster {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent), var(--shadow-accent);
      transform: scale(1.04);
    }
    .card.hm-focus .title { color: var(--accent); }
    .card img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    /* Placeholder shown when an item has no posterUrl (or the image failed to
     *  load). Designed to read as a poster — same dimensions, deliberate
     *  layout, NOT just a dark void with text shoved in. */
    .card .placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
      padding: 10px 8px 12px;
      box-sizing: border-box;
      background: linear-gradient(160deg, var(--surface-pressed) 0%, var(--surface-elevated) 60%, var(--surface) 100%);
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.25;
      text-align: center;
    }
    .card .placeholder .ph-icon {
      align-self: center;
      margin-bottom: auto;
      margin-top: 14px;
      width: 38px;
      height: 38px;
      color: var(--text-tertiary);
    }
    .card .placeholder .ph-icon svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .card .placeholder .ph-type {
      align-self: center;
      font-size: 9px;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
    .card .placeholder .ph-title {
      color: var(--text-primary);
      font-weight: 600;
      font-size: 11px;
      line-height: 1.25;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card.watched .poster img,
    .card.watched .poster .placeholder { opacity: 0.5; }
    .card.watched .title { color: var(--text-tertiary); }
    .card.watched .meta { color: var(--text-disabled); }

    .card:hover .poster { border-color: var(--accent); }
    .card:hover img { filter: brightness(1.1); }

    .meta-block {
      display: flex;
      flex-direction: column;
      gap: 2px;
      height: var(--hm-card-meta-h);
      overflow: hidden;
      padding: 0 1px;
    }
    .title {
      font-size: 12px;
      color: var(--text-primary);
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Old .check overlay removed in favor of <watched-button>. */

    .new-badge {
      position: absolute;
      top: 6px;
      left: 6px;
      font-size: 9px;
      color: var(--on-accent);
      background: var(--accent);
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      letter-spacing: 1px;
      font-weight: 700;
      text-transform: uppercase;
      line-height: 1;
      box-shadow: var(--shadow-accent);
    }

    /* IMDb rating pill — gold star + bare /10 number, top-left. When the
     * NEW badge is also showing it stacks below the rating; the helper
     * class .has-rating bumps .new-badge down. (0.1.8) */
    .rating-pill {
      position: absolute;
      top: 6px;
      left: 6px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 11px;
      font-weight: 600;
      color: #111;
      background: linear-gradient(180deg, #ffe27a 0%, #f5c518 100%);
      padding: 2px 6px 2px 5px;
      border-radius: var(--radius-xs);
      line-height: 1;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }
    .rating-pill .star {
      width: 10px;
      height: 10px;
      fill: #111;
      flex-shrink: 0;
    }
    /* When both rating + NEW are visible, push NEW down so the rating gets
     * the prime corner. */
    .new-badge.below-rating {
      top: 28px;
    }

    .duration-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      font-size: 10px;
      color: var(--on-scrim);
      background: var(--scrim-strong);
      padding: 1px 5px;
      border-radius: var(--radius-xs);
      font-variant-numeric: tabular-nums;
    }

    .progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 3px;
      background: var(--accent);
      box-shadow: var(--shadow-accent);
    }

    .empty {
      padding: 16px 4px;
      color: var(--text-tertiary);
      font-size: 13px;
    }

  `;

  @property({ type: String }) heading = '';
  @property({ type: String }) subtitle = '';
  @property({ attribute: false }) items: HomeCardItem[] = [];
  /** Index into `items` to anchor at the LEFT edge on mount. */
  @property({ type: Number }) anchorIndex = 0;
  /** Continue Watching cards override the meta line; set when this strip renders that chunk. */
  @property({ type: Boolean }) continueMode = false;
  /** Used to suppress NEW badges when this strip lives inside Continue. */
  @property({ type: Number }) now = Date.now();

  /** Set of poster URLs that failed to load. Tracked by URL so swapping
   *  `.items` (Movies→Series tab change) doesn't carry the broken-state
   *  forward onto whatever new item happens to land in the same slot. */
  @state() private brokenPosters = new Set<string>();

  /** True while any scan-flavored job (refresh / re-probe / per-item) is running.
   *  Bound by parent so we can disable kebab actions during contention. */
  @property({ type: Boolean }) jobActive = false;

  override updated(changed: Map<string, unknown>): void {
    // Keep the broken-poster set scoped to URLs the strip is currently rendering.
    // Without this, switching tabs (Movies → Series) would leak failure flags
    // forward — even though the new items have different URLs, a sibling URL
    // could have failed and the set would grow without bound.
    if (changed.has('items')) {
      const live = new Set<string>();
      for (const i of this.items) {
        if (i.posterUrl && this.brokenPosters.has(i.posterUrl)) live.add(i.posterUrl);
      }
      if (live.size !== this.brokenPosters.size) this.brokenPosters = live;
    }
  }

  private onClick(item: HomeCardItem): void {
    navigate(item.href);
  }

  private onWatchedChange(item: HomeCardItem, e: CustomEvent<{ watched: boolean }>): void {
    // Forward upward with the full item context so <home-view> can call the
    // right API (item-level vs path-level) and refresh.
    this.dispatchEvent(
      new CustomEvent('item-watched-change', {
        detail: { item, watched: e.detail.watched },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 0.1.5.1 — fires `reprobe-item-trigger` with the item id; <app-shell>
   *  POSTs and observes the SSE channel. */
  private dispatchReprobeItem(item: HomeCardItem): void {
    this.dispatchEvent(
      new CustomEvent('reprobe-item-trigger', {
        detail: { id: item.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 0.1.5.2 — opens the manual-identify modal for this item. <home-view>
   *  catches the event, looks up the full LibraryItem in its cached library,
   *  and re-dispatches `manual-identify-request` with the row to <app-shell>. */
  private dispatchManualIdentifyItem(item: HomeCardItem): void {
    this.dispatchEvent(
      new CustomEvent('manual-identify-item-request', {
        detail: { id: item.id, type: item.type },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Eject a misclassified movie back to the Uncategorized view. <home-view>
   *  catches this, confirms, calls the eject API, and navigates to the list. */
  private dispatchEjectItem(item: HomeCardItem): void {
    this.dispatchEvent(
      new CustomEvent('eject-item-request', {
        detail: { id: item.id, title: item.title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Re-import a series: drop its local data and rescan so its files are
   *  re-identified from scratch (e.g. a show whose episodes were mis-placed,
   *  like absolute-numbered anime). <home-view> confirms, ejects, then triggers
   *  a smart refresh. */
  private dispatchReimportItem(item: HomeCardItem): void {
    this.dispatchEvent(
      new CustomEvent('reimport-series-request', {
        detail: { id: item.id, title: item.title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): unknown {
    return html`
      <div class="strip-header">
        <span class="heading">${this.heading}</span>
        <span class="subtitle">${this.subtitle}</span>
      </div>
      <div class="strip">
        ${this.items.length === 0
          ? html`<div class="empty">No items</div>`
          : html`<div class="row">${this.items.map((item) => this.renderCard(item))}</div>`}
      </div>
    `;
  }

  private renderCard(item: HomeCardItem): unknown {
    const cls = item.watched ? 'card watched' : 'card';
    const inProgress =
      !item.watched && item.position > 0 && item.duration > 0 && item.position < item.duration * 0.95;
    const ratio = inProgress ? Math.max(0, Math.min(1, item.position / item.duration)) : 0;

    const showNew = !this.continueMode && isNew(item, this.now);
    const meta = this.metaLine(item, inProgress);
    const durationBadge = this.durationBadge(item, inProgress);
    const ratingLabel = formatImdbRating(item.imdbRating);
    const newClass = ratingLabel ? 'new-badge below-rating' : 'new-badge';

    return html`
      <div
        class=${cls}
        data-nav="1"
        @click=${(): void => this.onClick(item)}
        title=${item.title}
      >
        <div class="poster">
          ${item.posterUrl && !this.brokenPosters.has(item.posterUrl)
            ? html`<img
                src=${item.posterUrl}
                alt=${item.title}
                loading="lazy"
                @error=${(): void => this.markBrokenPoster(item.posterUrl!)}
              />`
            : renderPlaceholder(item)}
          ${ratingLabel ? renderRatingPill(ratingLabel) : null}
          ${showNew ? html`<span class=${newClass}>NEW</span>` : null}
          <watched-button
            .watched=${item.watched}
            .kind=${item.type}
            .extraItems=${[
              { label: 'Re-probe', disabled: this.jobActive, onClick: (): void => this.dispatchReprobeItem(item) },
              { label: 'Identify manually…', disabled: this.jobActive, onClick: (): void => this.dispatchManualIdentifyItem(item) },
              // Movies only: escape hatch for a file wrongly gated as a movie
              // (e.g. a series episode). Returns it to the Uncategorized view.
              ...(item.type === 'movie'
                ? [{ label: 'Not a movie? Move to Uncategorized', disabled: this.jobActive, onClick: (): void => this.dispatchEjectItem(item) }]
                : []),
              // Series only: drop local data and rescan to re-identify episodes
              // from scratch (fixes mis-placed episodes, e.g. absolute-numbered
              // anime that landed in the wrong seasons).
              ...(item.type === 'series'
                ? [{ label: 'Re-import (rescan files)', disabled: this.jobActive, onClick: (): void => this.dispatchReimportItem(item) }]
                : []),
            ]}
            @click=${(e: Event): void => e.stopPropagation()}
            @watched-change=${(e: CustomEvent<{ watched: boolean }>): void => this.onWatchedChange(item, e)}
          ></watched-button>
          ${durationBadge ? html`<span class="duration-badge">${durationBadge}</span>` : null}
          ${inProgress ? html`<div class="progress" style=${`width: ${ratio * 100}%`}></div>` : null}
        </div>
        <div class="meta-block">
          <div class="title">${item.title}</div>
          ${meta ? html`<div class="meta">${meta}</div>` : null}
        </div>
      </div>
    `;
  }

  private metaLine(item: HomeCardItem, inProgress: boolean): string | null {
    if (this.continueMode) {
      const remaining = formatTimeRemaining(item) ?? '';
      const label = item.resumeLabel ? `${item.resumeLabel} — ${remaining}` : remaining;
      return label || null;
    }
    if (inProgress) {
      return formatTimeRemaining(item);
    }
    if (item.year && item.genres.length > 0) return `${item.year} · ${item.genres[0]}`;
    if (item.year) return String(item.year);
    if (item.genres.length > 0) return item.genres[0]!;
    if (item.runtimeSeconds && item.runtimeSeconds > 0) return formatRuntimeShort(item.runtimeSeconds);
    return null;
  }

  private durationBadge(item: HomeCardItem, inProgress: boolean): string | null {
    if (inProgress || this.continueMode) return null;
    if (item.runtimeSeconds && item.runtimeSeconds > 0 && !item.year && item.genres.length === 0) {
      // already shown in meta
      return null;
    }
    return null;
  }

  /** Mark a poster URL as broken so future renders show the placeholder.
   *  Stored in component state so Lit drives the swap — the previous
   *  imperative DOM mutation leaked across re-renders when items changed. */
  private markBrokenPoster(url: string): void {
    if (this.brokenPosters.has(url)) return;
    const next = new Set(this.brokenPosters);
    next.add(url);
    this.brokenPosters = next;
  }
}

/** Format an IMDb /10 rating for the pill. One decimal except at the 10.0
 *  ceiling (where "10" reads better than "10.0"). Returns null when there's
 *  nothing to render so the caller can skip the pill entirely. (0.1.8) */
export function formatImdbRating(rating: number | null | undefined): string | null {
  if (rating == null) return null;
  if (!Number.isFinite(rating) || rating <= 0) return null;
  if (rating >= 10) return '10';
  return rating.toFixed(1);
}

/** Render the gold IMDb rating pill. Pass the pre-formatted label so callers
 *  can early-out on null without going through the template. (0.1.8) */
function renderRatingPill(label: string): unknown {
  return html`<span class="rating-pill" aria-label=${`IMDb rating ${label} of 10`}>
    <svg class="star" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 L14.85 8.63 L22 9.27 L16.5 14.14 L18.18 21.02 L12 17.27 L5.82 21.02 L7.5 14.14 L2 9.27 L9.15 8.63 Z"></path>
    </svg>
    ${label}
  </span>`;
}

/** Lit-html template form of the placeholder, used when posterUrl is null
 *  or marked as broken. */
function renderPlaceholder(item: { title: string; type: 'movie' | 'series' }): unknown {
  return html`
    <div class="placeholder">
      <div class="ph-icon">
        ${item.type === 'series' ? iconSeriesSvg() : iconMovieSvg()}
      </div>
      <div class="ph-type">${item.type === 'series' ? 'Series' : 'Movie'}</div>
      <div class="ph-title">${item.title}</div>
    </div>
  `;
}

/** Movie clapperboard — the universal "this is a movie" shape. */
function iconMovieSvg(): unknown {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
    <path d="M3 8 L21 8 L21 19 A1.5 1.5 0 0 1 19.5 20.5 L4.5 20.5 A1.5 1.5 0 0 1 3 19 Z"></path>
    <path d="M3 8 L5.5 3.5 L9 3.5 L6.5 8 Z" fill="currentColor" fill-opacity="0.3"></path>
    <path d="M7.5 8 L10 3.5 L13.5 3.5 L11 8 Z" fill="currentColor" fill-opacity="0.3"></path>
    <path d="M12 8 L14.5 3.5 L18 3.5 L15.5 8 Z" fill="currentColor" fill-opacity="0.3"></path>
    <path d="M16.5 8 L19 3.5 L21 3.5 L21 8 Z" fill="currentColor" fill-opacity="0.3"></path>
  </svg>`;
}

/** TV with antennae — reads as "series" without ambiguity. */
function iconSeriesSvg(): unknown {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="8" width="19" height="12" rx="1.5"></rect>
    <line x1="7" y1="3" x2="11" y2="8"></line>
    <line x1="17" y1="3" x2="13" y2="8"></line>
  </svg>`;
}

function formatRuntimeShort(seconds: number): string {
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
