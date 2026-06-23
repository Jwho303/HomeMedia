import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  apiContinue,
  apiItemSetWatched,
  apiLibrary,
  apiManualIdentifyEject,
  ShareOfflineError,
} from '../api.js';
import { navigate, uncategorizedHref } from '../router.js';
import type { ContinueRow, Library, ShareStatus } from '../types.js';
import {
  computeChunks,
  continueChunks,
  libraryItemToCard,
  type Chunk,
  type SortMode,
} from './home-chunks.js';
import {
  SHARE_STATUS_EVENT,
  getLastKnownShareStatus,
} from './share-banner.js';
import { getConnectionState } from '../connection-store.js';
import './home-header.js';
import './poster-strip.js';
import type { LibraryToggle } from './home-header.js';
import { cacheLibrary } from './series-detail.js';
import {
  getScanProgress,
  subscribeScanProgress,
  type ScanProgressState,
} from '../scan-progress-store.js';

@customElement('home-view')
export class HomeView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text-primary);
    }

    .body {
      padding: 16px 16px 64px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    .empty,
    .error {
      padding: 24px 16px;
      color: var(--text-secondary);
      text-align: center;
    }
    .error {
      background: var(--surface-elevated);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--error);
      margin: 16px;
    }
    .summary {
      padding: 8px 14px;
      background: var(--surface-elevated);
      border: 1px solid var(--accent-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      margin: 12px 16px;
      font-size: 13px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .summary .dismiss { color: var(--text-secondary); padding-left: 12px; }
    .summary:hover { border-color: var(--accent); }
  `;

  @state() private library: Library | null = null;
  @state() private continueRows: ContinueRow[] = [];
  @state() private toggle: LibraryToggle = readPersistedToggle();
  @state() private sortMode: SortMode = 'dateAdded';
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private online = true;
  @state() private now = Date.now();
  @state() private scan: ScanProgressState = getScanProgress();

  private shareListener = (e: Event): void => {
    const detail = (e as CustomEvent<ShareStatus>).detail;
    this.online = detail.online;
  };

  private visibilityListener = (): void => {
    if (document.visibilityState === 'visible') {
      void this.loadContinue();
      this.now = Date.now();
    }
  };

  private scanListener = (s: ScanProgressState): void => {
    const wasActive = this.scan.active;
    this.scan = s;
    // When a scan completes, refetch library so newly-added items appear.
    // Also surface the result summary so the user can tell whether the scan
    // actually found things (vs. a no-op or whether items landed in needs_review).
    if (wasActive && !s.active && s.errorMessage == null) {
      void this.load();
      if (s.result) this.summary = formatScanSummary(s.result);
    }
    if (s.errorMessage) this.error = s.errorMessage;
  };

  @state() private summary: string | null = null;

  private unsubscribeScan: (() => void) | null = null;

  /** 0.1.5.2 — when a manual-identify Apply succeeds, `<app-shell>` dispatches
   *  this event so views with cached library data can refetch and pick up the
   *  new identity. */
  private libraryInvalidatedListener = (): void => {
    void this.load();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener(SHARE_STATUS_EVENT, this.shareListener);
    document.addEventListener('visibilitychange', this.visibilityListener);
    document.addEventListener('library-invalidated', this.libraryInvalidatedListener);
    this.unsubscribeScan = subscribeScanProgress(this.scanListener);
    const last = getLastKnownShareStatus();
    if (last) this.online = last.online;
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(SHARE_STATUS_EVENT, this.shareListener);
    document.removeEventListener('visibilitychange', this.visibilityListener);
    document.removeEventListener('library-invalidated', this.libraryInvalidatedListener);
    this.unsubscribeScan?.();
    this.unsubscribeScan = null;
  }

  private async load(): Promise<void> {
    // 0.1.11 — when the server is unreachable, skip the fetch. <reconnect-overlay>
    // owns the user-facing state; on recovery the store fires `library-invalidated`
    // (which we listen for above) so this method runs again with a live server.
    if (getConnectionState()?.kind === 'unreachable') return;
    this.loading = true;
    this.error = null;
    this.now = Date.now();
    try {
      // 0.1.10 — home view shows alive rows only. Soft-deleted rows are
      // surfaced exclusively in the search view (which still passes
      // includeStale=true). Including them on the home grid was the
      // visible bug from the post-0.1.10 hard refresh: the user saw rows
      // they had already deleted from disk, and clicking them 404'd.
      const [lib, cont] = await Promise.all([
        apiLibrary(),
        apiContinue().catch(() => [] as ContinueRow[]),
      ]);
      this.library = lib;
      this.continueRows = cont;
      cacheLibrary(lib);
    } catch (err) {
      if (err instanceof ShareOfflineError) {
        this.error = 'Library unavailable — share is offline.';
      } else {
        this.error = (err as Error).message ?? 'Failed to load library.';
      }
    } finally {
      this.loading = false;
    }
  }

  private async loadContinue(): Promise<void> {
    if (getConnectionState()?.kind === 'unreachable') return;
    try {
      this.continueRows = await apiContinue();
    } catch {
      // Continue Watching is non-critical; ignore failures.
    }
  }

  private onRefresh(e: CustomEvent<{ full: boolean }>): void {
    // Bubble up to <app-shell>, which owns the EventSource.
    this.dispatchEvent(
      new CustomEvent('refresh-trigger', {
        detail: { full: e.detail.full },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onReprobeLibrary(): void {
    const ok = window.confirm(
      'Re-probe every file in the library? This can take a few minutes on slow shares; you only need to do this once after upgrading.',
    );
    if (!ok) return;
    this.dispatchEvent(
      new CustomEvent('reprobe-library-trigger', { bubbles: true, composed: true }),
    );
  }

  private onToggle(e: CustomEvent<LibraryToggle>): void {
    this.toggle = e.detail;
    persistToggle(e.detail);
  }

  private onSort(e: CustomEvent<SortMode>): void {
    this.sortMode = e.detail;
  }

  private onSearch(e: CustomEvent<string>): void {
    const q = (e.detail ?? '').trim();
    if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
    else navigate('#/search');
  }

  private buildChunks(): Chunk[] {
    if (!this.library) return [];
    const wantType: 'movie' | 'series' = this.toggle === 'movies' ? 'movie' : 'series';
    const all = [...this.library.movies, ...this.library.series];
    const filtered = all.filter((i) => i.type === wantType);
    const cards = filtered.map(libraryItemToCard);
    const continueFiltered = this.continueRows.filter((r) => r.type === wantType);
    const chunks: Chunk[] = [];
    chunks.push(...continueChunks(continueFiltered));
    chunks.push(...computeChunks(cards, this.sortMode, { now: this.now }));
    return chunks;
  }

  override render(): unknown {
    return html`
      <home-header
        .toggle=${this.toggle}
        .sortMode=${this.sortMode}
        .online=${this.online}
        .jobActive=${this.scan.active}
        .scanI=${this.scan.i}
        .scanN=${this.scan.n}
        .scanCurrentFile=${this.scan.currentFile}
        .scanPhase=${this.scan.phase}
        @toggle-change=${(e: CustomEvent<LibraryToggle>): void => this.onToggle(e)}
        @sort-change=${(e: CustomEvent<SortMode>): void => this.onSort(e)}
        @search=${(e: CustomEvent<string>): void => this.onSearch(e)}
        @refresh=${(e: CustomEvent<{ full: boolean }>): void => this.onRefresh(e)}
        @reprobe-library=${(): void => this.onReprobeLibrary()}
      ></home-header>
      ${this.error ? html`<div class="error">${this.error}</div>` : null}
      ${this.summary
        ? html`<div class="summary" @click=${(): void => { this.summary = null; }}>${this.summary} <span class="dismiss">×</span></div>`
        : null}
      ${this.renderBody()}
    `;
  }

  private renderBody(): unknown {
    if (this.loading && !this.library) {
      return html`<div class="empty">Loading…</div>`;
    }
    if (!this.library) {
      return null;
    }
    const chunks = this.buildChunks();
    if (chunks.length === 0) {
      return html`<div class="empty">
        Nothing here yet. Click the refresh button to scan.
      </div>`;
    }
    return html`
      <div
        class="body"
        @item-watched-change=${(e: CustomEvent<{ item: { id: number }; watched: boolean }>): void => void this.onItemWatched(e)}
        @manual-identify-item-request=${(e: CustomEvent<{ id: number; type: 'movie' | 'series' }>): void => this.onManualIdentifyItemRequest(e)}
        @eject-item-request=${(e: CustomEvent<{ id: number; title: string }>): void => void this.onEjectItem(e)}
        @reimport-series-request=${(e: CustomEvent<{ id: number; title: string }>): void => void this.onReimportSeries(e)}
      >
        ${chunks.map(
          (c) => html`
            <poster-strip
              .heading=${c.heading}
              .subtitle=${c.subtitle}
              .items=${c.items}
              .anchorIndex=${c.anchorIndex}
              .continueMode=${c.type === 'continue'}
              .now=${this.now}
              .jobActive=${this.scan.active}
            ></poster-strip>
          `,
        )}
      </div>
    `;
  }

  /** 0.1.5.2 — poster-strip dispatches `manual-identify-item-request` with
   *  just `{ id, type }`. Look up the full LibraryItem in our cached library
   *  and re-dispatch as `manual-identify-request` for `<app-shell>` to mount
   *  the modal. */
  private onManualIdentifyItemRequest(
    e: CustomEvent<{ id: number; type: 'movie' | 'series' }>,
  ): void {
    if (!this.library) return;
    const pool = e.detail.type === 'movie' ? this.library.movies : this.library.series;
    const row = pool.find((i) => i.id === e.detail.id);
    if (!row) return;
    this.dispatchEvent(
      new CustomEvent('manual-identify-request', {
        detail: { kind: 'item', id: row.id, row },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Eject a misclassified movie back to the Uncategorized view, then take the
   *  user there to re-identify it. The file leaves Movies and reappears in the
   *  uncategorized list. */
  private async onEjectItem(e: CustomEvent<{ id: number; title: string }>): Promise<void> {
    const ok = window.confirm(
      `Move "${e.detail.title}" out of Movies and back to Uncategorized? ` +
        `Use this if it isn't really a movie (e.g. it's a TV episode). ` +
        `You can then re-identify it from the Uncategorized list.`,
    );
    if (!ok) return;
    try {
      await apiManualIdentifyEject(e.detail.id);
      await this.load();
      // Other views (and the uncategorized list) refetch on this.
      document.dispatchEvent(new CustomEvent('library-invalidated'));
      navigate(uncategorizedHref());
    } catch (err) {
      this.error = (err as Error).message ?? 'Failed to move item to Uncategorized.';
    }
  }

  /** Re-import a series: drop its local data (eject → all episode files return
   *  to needs_review) and immediately kick off a smart refresh so the scanner
   *  re-identifies them from scratch. Fixes mis-placed episodes such as
   *  absolute-numbered anime that landed in the wrong seasons. */
  private async onReimportSeries(e: CustomEvent<{ id: number; title: string }>): Promise<void> {
    const ok = window.confirm(
      `Re-import "${e.detail.title}"? This drops its current episodes and rescans ` +
        `the files to re-identify them. Use this if episodes are in the wrong ` +
        `seasons (e.g. anime numbered straight through). Your video files are not touched.`,
    );
    if (!ok) return;
    try {
      await apiManualIdentifyEject(e.detail.id);
      await this.load();
      document.dispatchEvent(new CustomEvent('library-invalidated'));
      // Hand off to <app-shell> (owns the scan EventSource) for a smart refresh
      // that re-attaches the freed files with progress shown in the usual UI.
      this.dispatchEvent(
        new CustomEvent('refresh-trigger', {
          detail: { full: false },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      this.error = (err as Error).message ?? 'Failed to re-import series.';
    }
  }

  private async onItemWatched(
    e: CustomEvent<{ item: { id: number }; watched: boolean }>,
  ): Promise<void> {
    try {
      await apiItemSetWatched(e.detail.item.id, e.detail.watched);
      const [lib, cont] = await Promise.all([
        apiLibrary(),
        apiContinue().catch(() => [] as ContinueRow[]),
      ]);
      this.library = lib;
      this.continueRows = cont;
    } catch (err) {
      this.error = (err as Error).message ?? 'Failed to update watched state.';
    }
  }
}

/** Compose a short user-facing summary from the ScanResult `done` payload.
 *  Always returns a string — a no-op refresh shows "Refresh complete — no
 *  changes" so the user gets visible confirmation that the click did
 *  something. Returns null only when the result payload doesn't look like
 *  a ScanResult (e.g. a re-probe job, which has its own probed/fresh/failed
 *  shape). */
function formatScanSummary(r: Record<string, unknown>): string | null {
  const num = (k: string): number => {
    const v = r[k];
    return typeof v === 'number' ? v : 0;
  };
  const added = num('added');
  const updated = num('updated');
  const needsReview = num('needsReview');
  const probed = num('probed');
  const errors = num('errors');
  const scanned = num('scanned');
  // 0.1.10 — soft-delete reconcile counters.
  const disappeared = num('disappeared');
  const resurrected = num('resurrected');
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (resurrected > 0) parts.push(`+${resurrected} restored`);
  if (disappeared > 0) parts.push(`−${disappeared} hidden`);
  if (needsReview > 0) parts.push(`${needsReview} need review`);
  if (probed > 0) parts.push(`${probed} probed`);
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (parts.length > 0) return parts.join(' · ');
  // Nothing changed — but the refresh DID run (we have a `scanned` count).
  // Show explicit confirmation so the user doesn't think the button is broken.
  if (scanned > 0) return `Scanned ${scanned} file${scanned === 1 ? '' : 's'} — no changes`;
  // Re-probe jobs (fresh/failed/skipped/probed shape, no `scanned` field) —
  // let the dedicated re-probe summary path render those, not this helper.
  return null;
}

/** sessionStorage key for the active Movies/Series tab — survives in-app
 *  back navigation that re-mounts <home-view>, doesn't survive a tab close. */
const TOGGLE_STORAGE_KEY = 'homemedia:home-toggle';

function readPersistedToggle(): LibraryToggle {
  try {
    const v = window.sessionStorage.getItem(TOGGLE_STORAGE_KEY);
    if (v === 'movies' || v === 'series') return v;
  } catch {
    // sessionStorage not available — fall through to default.
  }
  return 'movies';
}

function persistToggle(value: LibraryToggle): void {
  try {
    window.sessionStorage.setItem(TOGGLE_STORAGE_KEY, value);
  } catch {
    // ignore storage failures
  }
}

/** Persist the desired Movies/Series tab from outside <home-view> (e.g. the
 *  Uncategorized view's nav) so navigating home lands on the right tab. */
export function setHomeToggle(value: LibraryToggle): void {
  persistToggle(value);
}
