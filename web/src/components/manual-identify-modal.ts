import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import {
  apiManualIdentifySearch,
  apiManualIdentifyItem,
  apiManualIdentifyEpisode,
  apiUncategorizedIdentify,
  ShareOfflineError,
  type UncategorizedIdentifyBody,
} from '../api.js';
import type {
  Episode,
  LibraryItem,
  ManualIdentifyCandidate,
  ManualIdentifyEpisodeBody,
  ManualIdentifyItemBody,
} from '../types.js';

export type ManualIdentifyTarget =
  | { kind: 'item'; id: number; row: LibraryItem }
  | { kind: 'episode'; id: number; row: Episode; seriesTitle: string | null }
  // Path-keyed rescue of an uncategorized (needs_review) file. There is no
  // integer row id and no known type — the user picks movie or series, and the
  // optional S/E input applies when they choose a series.
  | { kind: 'uncategorized'; path: string };

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Modal that surfaces the existing CLI rescue tooling as a web dialog.
 * Mounted once at `<app-shell>` level (sibling of the views) so a single
 * instance is reused across every kebab affordance.
 *
 * Inputs (set by the parent before calling `open()`):
 *  - `target` — what is being identified. `kind: 'item'` covers movie/series
 *    tile + series-detail header; `kind: 'episode'` covers episode-row.
 *
 * Outputs:
 *  - `applied` CustomEvent — fired after the API succeeds. Detail carries the
 *    updated row(s). The shell listens for this and dispatches
 *    `library-invalidated` so views refetch.
 *  - `cancelled` CustomEvent — fired when the user dismisses without applying.
 */
@customElement('manual-identify-modal')
export class ManualIdentifyModal extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: none;
    }
    :host([open]) { display: block; }

    .backdrop {
      position: absolute;
      inset: 0;
      background: var(--scrim-strong);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }

    .panel {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(560px, 92vw);
      max-height: 86vh;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .header .title {
      font-size: 15px;
      font-weight: 600;
    }
    .close {
      background: transparent;
      border: 0;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
      padding: 2px 6px;
    }
    .close:hover { color: var(--text-primary); }

    .body {
      padding: 14px 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-secondary);
    }

    .current {
      display: flex;
      gap: 12px;
      padding: 10px 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .current .poster {
      width: 48px;
      height: 72px;
      flex: 0 0 auto;
      background: var(--bg);
      border-radius: var(--radius-sm);
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-disabled);
      font-size: 18px;
    }
    .current .poster img { width: 100%; height: 100%; object-fit: cover; }
    .current .meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .current .meta .name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .current .meta .ids {
      font-size: 11px;
      color: var(--text-secondary);
    }

    input[type='text'] {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
    }
    input[type='text']:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    input[type='text']::placeholder { color: var(--text-tertiary); }

    .results {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 320px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 4px;
      background: var(--surface);
    }
    .result {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-primary);
      text-align: left;
      font: inherit;
    }
    .result:hover { background: var(--surface-pressed); }
    .result[aria-selected='true'] {
      background: var(--accent-subtle);
      border-color: var(--accent);
    }
    .result .thumb {
      width: 36px;
      height: 54px;
      flex: 0 0 auto;
      background: var(--bg);
      border-radius: var(--radius-xs);
      overflow: hidden;
      color: var(--text-disabled);
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .result .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .result .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .result .info .label {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .result .info .sub {
      font-size: 11px;
      color: var(--text-secondary);
    }
    .result .badge {
      font-size: 10px;
      text-transform: uppercase;
      color: var(--accent);
      letter-spacing: 0.4px;
      font-weight: 700;
    }

    .empty {
      padding: 18px 8px;
      color: var(--text-tertiary);
      text-align: center;
      font-size: 12px;
    }

    .hint {
      font-size: 11px;
      color: var(--text-tertiary);
    }

    .error {
      background: var(--surface);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--error);
      padding: 8px 10px;
      font-size: 12px;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: var(--surface);
    }

    button.action {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: var(--radius-md);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    button.action.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-accent);
      box-shadow: var(--shadow-accent);
      font-weight: 600;
    }
    button.action:hover { border-color: var(--accent); color: var(--text-primary); }
    button.action.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--on-accent); }
    button.action[disabled] { opacity: 0.45; cursor: default; box-shadow: none; }
  `;

  /** Reflect open state for [open] attribute selector + tests. */
  @property({ type: Boolean, reflect: true }) open = false;

  @property({ attribute: false }) target: ManualIdentifyTarget | null = null;

  @state() private query = '';
  @state() private candidates: ManualIdentifyCandidate[] = [];
  @state() private selected: ManualIdentifyCandidate | null = null;
  @state() private link = '';
  @state() private seInput = '';
  @state() private searching = false;
  @state() private applying = false;
  @state() private error: string | null = null;

  @query('.search-input') private searchInputEl!: HTMLInputElement;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private aborter: AbortController | null = null;
  private keyHandler = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.cancel();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.keyHandler, true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.keyHandler, true);
    this.cancelInFlight();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      if (this.open) this.onOpened();
      else this.onClosed();
    }
  }

  /** Reset state for a new target and seed the search input with a sensible
   *  starting query (current title, falling back to the path basename). */
  private onOpened(): void {
    this.error = null;
    this.candidates = [];
    this.selected = null;
    this.link = '';
    this.seInput = '';
    this.applying = false;
    const seed = this.initialQuery();
    this.query = seed;
    // Run the first search after the input has rendered with the seed value
    // so a focus + select behaves naturally.
    requestAnimationFrame(() => {
      this.searchInputEl?.focus();
      this.searchInputEl?.select();
      if (seed.trim().length > 0) void this.runSearch(seed);
    });
  }

  private onClosed(): void {
    this.cancelInFlight();
  }

  private initialQuery(): string {
    const t = this.target;
    if (!t) return '';
    if (t.kind === 'item') {
      return t.row.title ?? basename(t.row.path);
    }
    if (t.kind === 'uncategorized') {
      // No identity yet — seed from the filename so the first search is useful.
      return basename(t.path);
    }
    // Episode: prefer the parent series title; fall back to the file name.
    return t.seriesTitle ?? basename(t.row.path);
  }

  private cancelInFlight(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.aborter) {
      this.aborter.abort();
      this.aborter = null;
    }
  }

  private onQueryInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.query = v;
    this.scheduleSearch(v);
  }

  private scheduleSearch(q: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (q.trim().length === 0) {
      this.candidates = [];
      this.cancelInFlight();
      return;
    }
    this.debounceTimer = setTimeout(() => void this.runSearch(q), SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(q: string): Promise<void> {
    if (this.aborter) this.aborter.abort();
    const aborter = new AbortController();
    this.aborter = aborter;
    this.searching = true;
    this.error = null;
    try {
      const opts: { type?: 'movie' | 'series'; signal: AbortSignal } = { signal: aborter.signal };
      if (this.target?.kind === 'item') {
        opts.type = this.target.row.type;
      } else if (this.target?.kind === 'episode') {
        opts.type = 'series';
      }
      const candidates = await apiManualIdentifySearch(q.trim(), opts);
      // Drop the result if a newer search has already started.
      if (this.aborter !== aborter) return;
      this.candidates = candidates;
      // Auto-select if the picked candidate disappears from the new list.
      if (this.selected && !candidates.some((c) => c.tmdbId === this.selected!.tmdbId)) {
        this.selected = null;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (err instanceof ShareOfflineError) {
        this.error = 'Search unavailable — share is offline.';
      } else {
        this.error = (err as Error).message ?? 'Search failed.';
      }
    } finally {
      if (this.aborter === aborter) {
        this.aborter = null;
        this.searching = false;
      }
    }
  }

  private onSelect(c: ManualIdentifyCandidate): void {
    this.selected = c;
    this.link = '';
  }

  private onLinkInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.link = v;
    if (v.trim().length > 0) this.selected = null;
  }

  private onSeInput(e: Event): void {
    this.seInput = (e.target as HTMLInputElement).value;
  }

  private canApply(): boolean {
    if (this.applying) return false;
    if (this.selected) return true;
    return this.link.trim().length > 0;
  }

  private async onApply(): Promise<void> {
    if (!this.target || !this.canApply()) return;
    this.applying = true;
    this.error = null;
    try {
      if (this.target.kind === 'item') {
        const body = this.buildItemBody();
        if (!body) {
          this.applying = false;
          return;
        }
        const r = await apiManualIdentifyItem(this.target.id, body);
        this.dispatchEvent(
          new CustomEvent('applied', {
            detail: { kind: 'item', item: r.item },
            bubbles: true,
            composed: true,
          }),
        );
      } else if (this.target.kind === 'uncategorized') {
        const body = this.buildUncategorizedBody(this.target.path);
        if (!body) {
          this.applying = false;
          return;
        }
        const r = await apiUncategorizedIdentify(body);
        this.dispatchEvent(
          new CustomEvent('applied', {
            detail: { kind: 'uncategorized', path: this.target.path, item: r.item, episode: r.episode },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        const body = this.buildEpisodeBody();
        if (!body) {
          this.applying = false;
          return;
        }
        const r = await apiManualIdentifyEpisode(this.target.id, body);
        this.dispatchEvent(
          new CustomEvent('applied', {
            detail: { kind: 'episode', episode: r.episode, item: r.item },
            bubbles: true,
            composed: true,
          }),
        );
      }
      this.open = false;
    } catch (err) {
      if (err instanceof ShareOfflineError) {
        this.error = 'Apply failed — share is offline.';
      } else {
        this.error = (err as Error).message ?? 'Apply failed.';
      }
      this.applying = false;
    }
  }

  private buildItemBody(): ManualIdentifyItemBody | null {
    if (this.selected) {
      return { tmdbId: this.selected.tmdbId, type: this.selected.type };
    }
    if (this.link.trim().length > 0) {
      return { link: this.link.trim() };
    }
    return null;
  }

  private buildEpisodeBody(): ManualIdentifyEpisodeBody | null {
    const trimmedSe = this.seInput.trim();
    if (this.selected) {
      const body: ManualIdentifyEpisodeBody = {
        tmdbId: this.selected.tmdbId,
        type: this.selected.type,
      };
      if (trimmedSe.length > 0) body.seInput = trimmedSe;
      return body;
    }
    if (this.link.trim().length > 0) {
      const body: ManualIdentifyEpisodeBody = { link: this.link.trim() };
      if (trimmedSe.length > 0) body.seInput = trimmedSe;
      return body;
    }
    return null;
  }

  private buildUncategorizedBody(path: string): UncategorizedIdentifyBody | null {
    const trimmedSe = this.seInput.trim();
    if (this.selected) {
      const body: UncategorizedIdentifyBody = {
        path,
        tmdbId: this.selected.tmdbId,
        type: this.selected.type,
      };
      if (trimmedSe.length > 0) body.seInput = trimmedSe;
      return body;
    }
    if (this.link.trim().length > 0) {
      const body: UncategorizedIdentifyBody = { path, link: this.link.trim() };
      if (trimmedSe.length > 0) body.seInput = trimmedSe;
      return body;
    }
    return null;
  }

  private cancel(): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('cancelled', { bubbles: true, composed: true }),
    );
  }

  private onBackdropClick(): void {
    this.cancel();
  }

  override render(): unknown {
    if (!this.open || !this.target) return nothing;
    const t = this.target;
    return html`
      <div class="backdrop" @click=${(): void => this.onBackdropClick()}></div>
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="manual-identify-title">
        <div class="header">
          <div class="title" id="manual-identify-title">Identify manually</div>
          <button class="close" title="Close" @click=${(): void => this.cancel()}>×</button>
        </div>
        <div class="body">
          ${this.renderCurrent(t)}
          ${this.renderSearch()}
          ${t.kind === 'episode' || t.kind === 'uncategorized' ? this.renderSeInput() : null}
          ${this.renderResults()}
          ${this.renderLink()}
          ${this.error ? html`<div class="error">${this.error}</div>` : null}
        </div>
        <div class="footer">
          <button class="action" @click=${(): void => this.cancel()}>Cancel</button>
          <button
            class="action primary"
            ?disabled=${!this.canApply()}
            @click=${(): void => void this.onApply()}
          >${this.applying ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
    `;
  }

  private renderCurrent(t: ManualIdentifyTarget): unknown {
    if (t.kind === 'uncategorized') {
      return html`
        <div>
          <div class="section-label">Uncategorized file</div>
          <div class="current">
            <div class="poster">🎬</div>
            <div class="meta">
              <div class="name">${basename(t.path)}</div>
              <div class="ids">Not yet in Movies or Series</div>
            </div>
          </div>
        </div>
      `;
    }
    if (t.kind === 'item') {
      const i = t.row;
      const ids: string[] = [];
      if (i.tmdbId != null) ids.push(`TMDB: ${i.tmdbId}`);
      ids.push(i.type);
      return html`
        <div>
          <div class="section-label">Currently identified as</div>
          <div class="current">
            <div class="poster">${i.posterUrl ? html`<img src=${i.posterUrl} alt="" />` : '🎬'}</div>
            <div class="meta">
              <div class="name">${i.title ?? basename(i.path)}${i.year ? ` (${i.year})` : ''}</div>
              <div class="ids">${ids.join(' · ')}</div>
            </div>
          </div>
        </div>
      `;
    }
    const ep = t.row;
    return html`
      <div>
        <div class="section-label">Currently identified as</div>
        <div class="current">
          <div class="poster">${ep.stillUrl ? html`<img src=${ep.stillUrl} alt="" />` : '🎬'}</div>
          <div class="meta">
            <div class="name">${t.seriesTitle ?? basename(ep.path)} · S${ep.season} · E${ep.episode}</div>
            <div class="ids">${ep.title ?? '—'}</div>
          </div>
        </div>
      </div>
    `;
  }

  private renderSearch(): unknown {
    return html`
      <div>
        <div class="section-label">Search</div>
        <input
          class="search-input"
          type="text"
          .value=${this.query}
          placeholder="Type a title, optionally with (year)…"
          @input=${(e: Event): void => this.onQueryInput(e)}
        />
      </div>
    `;
  }

  private renderSeInput(): unknown {
    return html`
      <div>
        <div class="section-label">Episode (optional)</div>
        <input
          type="text"
          .value=${this.seInput}
          placeholder="S04E01, 4x1, 220, or leave blank to keep current"
          @input=${(e: Event): void => this.onSeInput(e)}
        />
        <div class="hint">For a series, enter the episode (e.g. "S03E01" or "3x1"), or a single absolute number (e.g. "220") for shows numbered straight through all seasons. Leave blank for a movie or to auto-detect from the filename.</div>
      </div>
    `;
  }

  private renderResults(): unknown {
    if (this.searching && this.candidates.length === 0) {
      return html`<div class="empty">Searching…</div>`;
    }
    if (this.candidates.length === 0) {
      const hintText =
        this.target?.kind === 'episode'
          ? 'No matches yet. To re-identify the whole series, open the series kebab instead.'
          : 'No matches yet. Try a different title or paste a TMDB / IMDb link below.';
      return html`<div class="empty">${hintText}</div>`;
    }
    return html`
      <div>
        <div class="section-label">Results</div>
        <div class="results" role="listbox">
          ${this.candidates.map((c) => this.renderResultRow(c))}
        </div>
      </div>
    `;
  }

  private renderResultRow(c: ManualIdentifyCandidate): unknown {
    const isSelected = this.selected?.tmdbId === c.tmdbId;
    const subParts: string[] = [c.type];
    if (c.tmdbId != null) subParts.push(`TMDB: ${c.tmdbId}`);
    if (c.sources.length > 1) subParts.push(`${c.sources.length} sources agree`);
    return html`
      <button
        class="result"
        role="option"
        aria-selected=${isSelected ? 'true' : 'false'}
        @click=${(): void => this.onSelect(c)}
      >
        <div class="thumb">${c.posterUrl ? html`<img src=${c.posterUrl} alt="" />` : '🎬'}</div>
        <div class="info">
          <div class="label">${c.title}${c.year ? ` (${c.year})` : ''}</div>
          <div class="sub">${subParts.join(' · ')}</div>
        </div>
        ${isSelected ? html`<div class="badge">Picked</div>` : null}
      </button>
    `;
  }

  private renderLink(): unknown {
    return html`
      <div>
        <div class="section-label">Or paste a link</div>
        <input
          type="text"
          .value=${this.link}
          placeholder="tmdb:12345 · imdb:tt0123456 · or a TMDB / IMDb URL"
          @input=${(e: Event): void => this.onLinkInput(e)}
        />
      </div>
    `;
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
