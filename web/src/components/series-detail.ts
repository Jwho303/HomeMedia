import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  apiItemSetWatched,
  apiPathSetWatched,
  apiSeries,
  ShareOfflineError,
} from '../api.js';
import { goBack, homeHref } from '../router.js';
import type { Episode, Library, LibraryItem, SeriesDetail } from '../types.js';
import './season-strip.js';
import './watched-button.js';
import { pickHero } from './season-strip.js';
import {
  getScanProgress,
  subscribeScanProgress,
  type ScanProgressState,
} from '../scan-progress-store.js';

@customElement('series-detail')
export class SeriesDetailView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text-primary);
      --hm-accent: var(--accent);
    }

    /* Sticky header — visual parity with <home-header>. */
    .header {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
    }
    .header-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-title {
      flex: 1;
      min-width: 0;
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 8px;
    }

    /* Icon button — matches <home-header> .icon-btn. */
    .icon-btn {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }
    .icon-btn:hover { border-color: var(--accent); color: var(--text-primary); }
    .icon-btn svg { width: 16px; height: 16px; }
    /* Used to preserve the centered title's layout when only one side has buttons. */
    .icon-spacer { width: 32px; flex-shrink: 0; visibility: hidden; }

    /* Wrap the in-header watched-button so its absolute positioning lands
     *  here instead of escaping to the page corner. */
    .header-watched {
      position: relative;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
    }
    .header-watched watched-button {
      position: absolute;
      top: 4px;
      right: 0;
    }

    /* 0.1.5.1 — gear menu in the series-detail header. */
    .gear {
      position: relative;
      flex-shrink: 0;
    }
    .gear-menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-popover);
      padding: 4px 0;
      min-width: 180px;
      z-index: 10;
    }
    .gear-menu button {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
      font: inherit;
    }
    .gear-menu button:hover:not(:disabled) { background: var(--surface-pressed); color: var(--text-primary); }
    .gear-menu button:disabled { color: var(--text-disabled); cursor: default; }

    .body { padding: 16px; }

    .seasons {
      display: flex;
      flex-direction: column;
      gap: 36px;
    }

    .error {
      padding: 12px;
      background: var(--surface-elevated);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--error);
      margin: 12px 16px;
    }
  `;

  @property({ type: Number }) seriesId!: number;
  @state() private detail: SeriesDetail | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private gearOpen = false;
  @state() private scan: ScanProgressState = getScanProgress();
  /** Tracks the snap-to-current-season step so it runs once per detail load. */
  private snappedForDetailId: number | null = null;
  private unsubscribeScan: (() => void) | null = null;

  /** 0.1.5.2 — refetch detail when a manual-identify Apply lands so a new
   *  series identity / corrected episode S/E renders without a route bounce. */
  private libraryInvalidatedListener = (): void => {
    void this.load();
  };

  private scanListener = (s: ScanProgressState): void => {
    const wasActive = this.scan.active;
    this.scan = s;
    // Refetch detail when a re-probe (or any scan) finishes — episode probe
    // blobs may have changed.
    if (wasActive && !s.active && s.errorMessage == null) {
      void this.load();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('library-invalidated', this.libraryInvalidatedListener);
    this.unsubscribeScan = subscribeScanProgress(this.scanListener);
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('library-invalidated', this.libraryInvalidatedListener);
    this.unsubscribeScan?.();
    this.unsubscribeScan = null;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('seriesId')) {
      this.snappedForDetailId = null;
      void this.load();
    }
    if (this.detail && this.snappedForDetailId !== this.detail.series.id) {
      this.snappedForDetailId = this.detail.series.id;
      // Wait one frame so each <season-strip>'s firstUpdated has run before we
      // try to vertically center the current one.
      requestAnimationFrame(() => this.snapToCurrentSeason());
    }
  }

  private async load(): Promise<void> {
    if (!this.seriesId) return;
    this.loading = true;
    this.error = null;
    try {
      const d = await apiSeries(this.seriesId);
      this.detail = d;
      cacheSeriesDetail(d);
    } catch (err) {
      if (err instanceof ShareOfflineError) {
        this.error = 'Series unavailable — share is offline.';
      } else {
        this.error = (err as Error).message ?? 'Failed to load series.';
      }
    } finally {
      this.loading = false;
    }
  }

  /** Looked up by media-player to know what episode (if any) plays next. */
  static getNextEpisodePath(
    detail: SeriesDetail,
    currentPath: string,
  ): string | null {
    const idx = detail.episodes.findIndex((e) => e.path === currentPath);
    if (idx < 0 || idx >= detail.episodes.length - 1) return null;
    const next = detail.episodes[idx + 1];
    return next ? next.path : null;
  }

  /** First season whose hero is a non-`allWatched` target; falls back to the first season. */
  static computeCurrentSeason(seasonGroups: Array<{ season: number; eps: Episode[] }>): number {
    if (seasonGroups.length === 0) return 1;
    for (const g of seasonGroups) {
      const { mode } = pickHero(g.eps);
      if (mode !== 'allWatched') return g.season;
    }
    return seasonGroups[0]!.season;
  }

  /** Group episodes by season, ascending. Public for testing. */
  static groupBySeason(eps: Episode[]): Array<{ season: number; eps: Episode[] }> {
    const map = new Map<number, Episode[]>();
    for (const e of eps) {
      const arr = map.get(e.season);
      if (arr) arr.push(e);
      else map.set(e.season, [e]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, eps]) => ({ season, eps }));
  }

  private snapToCurrentSeason(): void {
    if (!this.detail) return;
    const groups = SeriesDetailView.groupBySeason(this.detail.episodes);
    const current = SeriesDetailView.computeCurrentSeason(groups);
    const root = this.renderRoot as ShadowRoot;
    const target = root.querySelector<HTMLElement>(
      `season-strip[data-season="${current}"]`,
    );
    if (target?.scrollIntoView) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  override render(): unknown {
    const title = this.detail?.series.title ?? '';
    const allWatched =
      this.detail != null &&
      this.detail.episodes.length > 0 &&
      this.detail.episodes.every((e) => e.watched);
    return html`
      <div class="header">
        <div class="header-row">
          <button
            class="icon-btn"
            title="Back to library"
            @click=${(): void => goBack(homeHref())}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
          <div class="header-title" title=${title}>${title}</div>
          <div class="header-watched">
            ${this.detail
              ? html`<watched-button
                  .watched=${allWatched}
                  .kind=${'series'}
                  @watched-change=${(e: CustomEvent<{ watched: boolean }>): void => void this.onSeriesWatchedChange(e)}
                ></watched-button>`
              : html`<span class="icon-spacer"></span>`}
          </div>
          <div class="gear">
            <button
              class="icon-btn"
              title="More actions"
              @click=${(): void => { this.gearOpen = !this.gearOpen; }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            ${this.gearOpen
              ? html`<div class="gear-menu">
                  <button
                    ?disabled=${this.scan.active || this.detail == null}
                    @click=${(): void => this.onReprobeSeries()}
                  >Re-probe series</button>
                  <button
                    ?disabled=${this.scan.active || this.detail == null}
                    @click=${(): void => this.onManualIdentifySeries()}
                  >Identify manually…</button>
                </div>`
              : null}
          </div>
        </div>
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : null}
      ${this.loading && !this.detail ? html`<div class="body">Loading…</div>` : null}
      ${this.detail ? this.renderDetail(this.detail) : null}
    `;
  }

  private renderDetail(d: SeriesDetail): unknown {
    const groups = SeriesDetailView.groupBySeason(d.episodes);
    const current = SeriesDetailView.computeCurrentSeason(groups);
    return html`
      <div
        class="body"
        @episode-watched-change=${(e: CustomEvent<{ path: string; watched: boolean }>): void => void this.onEpisodeWatchedChange(e)}
        @manual-identify-episode-request=${(e: CustomEvent<{ id: number; episode: Episode }>): void => this.onManualIdentifyEpisodeRequest(e)}
      >
        <div class="seasons">
          ${groups.map(
            (g) => html`
              <season-strip
                data-season=${g.season}
                .seasonNumber=${g.season}
                .episodes=${g.eps}
                .isCurrent=${g.season === current}
                .jobActive=${this.scan.active}
              ></season-strip>
            `,
          )}
        </div>
      </div>
    `;
  }

  /** 0.1.5.2 — season-strip dispatches `manual-identify-episode-request` per
   *  episode kebab; we re-dispatch to <app-shell> with the parent series
   *  title attached so the modal header reads sensibly. */
  private onManualIdentifyEpisodeRequest(
    e: CustomEvent<{ id: number; episode: Episode }>,
  ): void {
    if (!this.detail) return;
    this.dispatchEvent(
      new CustomEvent('manual-identify-request', {
        detail: {
          kind: 'episode',
          id: e.detail.id,
          row: e.detail.episode,
          seriesTitle: this.detail.series.title,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async onEpisodeWatchedChange(
    e: CustomEvent<{ path: string; watched: boolean }>,
  ): Promise<void> {
    try {
      await apiPathSetWatched(e.detail.path, e.detail.watched);
      await this.load();
    } catch (err) {
      this.error = (err as Error).message ?? 'Failed to update.';
    }
  }

  /** 0.1.5.1 — Re-probe series: force-probes every episode under this series.
   *  Bubbles `reprobe-item-trigger` to <app-shell>. */
  private onReprobeSeries(): void {
    if (!this.detail) return;
    this.gearOpen = false;
    this.dispatchEvent(
      new CustomEvent('reprobe-item-trigger', {
        detail: { id: this.detail.series.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** 0.1.5.2 — open the manual-identify modal targeting the series row. */
  private onManualIdentifySeries(): void {
    if (!this.detail) return;
    this.gearOpen = false;
    this.dispatchEvent(
      new CustomEvent('manual-identify-request', {
        detail: { kind: 'item', id: this.detail.series.id, row: this.detail.series },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async onSeriesWatchedChange(
    e: CustomEvent<{ watched: boolean }>,
  ): Promise<void> {
    if (!this.detail) return;
    try {
      await apiItemSetWatched(this.detail.series.id, e.detail.watched);
      await this.load();
    } catch (err) {
      this.error = (err as Error).message ?? 'Failed to update.';
    }
  }
}

/** Module-scope cache of the most recently fetched series, used by media-player
 * to figure out next-episode autoplay without a second round-trip. */
const seriesCache = new Map<number, SeriesDetail>();
export function cacheSeriesDetail(detail: SeriesDetail): void {
  seriesCache.set(detail.series.id, detail);
}
export function getCachedSeriesContaining(
  episodePath: string,
): SeriesDetail | null {
  for (const detail of seriesCache.values()) {
    if (detail.episodes.some((e) => e.path === episodePath)) return detail;
  }
  return null;
}

/** Module-scope cache of movies (keyed by file path), populated when home-view
 *  loads /api/library. media-player reads it to render the movie title in the
 *  topbar instead of the raw filename. */
const movieCache = new Map<string, LibraryItem>();
/** Module-scope cache of series LibraryItems (keyed by directory path).
 *  media-player uses this to figure out which series a deep-linked episode
 *  belongs to, so it can fetch the series detail and unlock prev/next/grid. */
const seriesItemCache = new Map<string, LibraryItem>();

export function cacheLibrary(library: Library): void {
  for (const m of library.movies) {
    if (m.type === 'movie') movieCache.set(m.path, m);
  }
  for (const s of library.series) {
    if (s.type === 'series') seriesItemCache.set(s.path, s);
  }
}
export function getCachedMovie(path: string): LibraryItem | null {
  return movieCache.get(path) ?? null;
}

/** Normalize a path to forward slashes with no trailing slash, so a series
 *  directory cached as `Show/` can match an episode path `Show/S01/Foo.mkv`
 *  regardless of OS-style separators. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Find the cached series LibraryItem whose directory contains `episodePath`.
 *  Picks the longest matching prefix (handles a series whose path is a prefix
 *  of another series' path — unusual but possible with naming like
 *  `Show` and `Show 2`). */
export function findCachedSeriesItemByEpisodePath(
  episodePath: string,
): LibraryItem | null {
  const target = normalizePath(episodePath);
  let best: LibraryItem | null = null;
  let bestLen = -1;
  for (const item of seriesItemCache.values()) {
    const dir = normalizePath(item.path);
    if (dir.length === 0) continue;
    if (target === dir || target.startsWith(`${dir}/`)) {
      if (dir.length > bestLen) {
        best = item;
        bestLen = dir.length;
      }
    }
  }
  return best;
}
