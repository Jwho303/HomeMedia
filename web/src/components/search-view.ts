import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiLibrary, ShareOfflineError } from '../api.js';
import { goBack, homeHref, navigate, playHref, seriesHref } from '../router.js';
import type { Library, LibraryItem } from '../types.js';
import { formatImdbRating } from './poster-strip.js';

/**
 * 0.1.5.1 — `#/search` view. Owns its own `<input>`, debounces the query,
 * and renders a flat grid of matching tiles.
 *
 * The query is mirrored into the hash (?q=...) so:
 *  - a refresh / back button restores the query
 *  - the home header's inline search input can pre-fill it via Enter
 *
 * Filter is a case-insensitive title contains-match against the full library
 * (includeStale = true so renamed/disappeared items remain searchable).
 */
@customElement('search-view')
export class SearchView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text-primary);
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
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
    .search-input {
      flex: 1;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font: inherit;
      font-size: 14px;
      padding: 8px 12px;
    }
    .search-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .search-input::placeholder { color: var(--text-tertiary); }
    .body { padding: 16px; }
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
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 16px;
    }
    .tile {
      cursor: pointer;
      background: transparent;
      border: 0;
      padding: 0;
      color: inherit;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .frame {
      position: relative;
      aspect-ratio: 2 / 3;
      background: var(--surface-elevated);
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid var(--border-strong);
      transition: transform 0.1s ease, border-color 0.1s ease;
    }
    .tile:hover .frame { transform: scale(1.03); border-color: var(--accent); }
    .frame img,
    .frame .placeholder {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .frame .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-disabled);
      font-size: 11px;
      padding: 8px;
      text-align: center;
    }
    .badge {
      position: absolute;
      top: 6px;
      right: 6px;
      background: var(--scrim-strong);
      color: var(--on-scrim);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    /* IMDb rating pill — matches the poster-strip styling. (0.1.8) */
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
    .meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0 2px;
    }
    .title {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .year { font-size: 11px; color: var(--text-secondary); }

    /* 0.1.10 — dimmed tile for soft-deleted rows surfaced via includeStale. */
    .tile.stale .frame { opacity: 0.55; filter: grayscale(0.4); }
    .tile.stale .title,
    .tile.stale .year { color: var(--text-tertiary); }
    .stale-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: var(--scrim-strong);
      color: var(--on-scrim);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      letter-spacing: 0.3px;
    }
  `;

  @state() private query: string = '';
  @state() private library: Library | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hashListener = (): void => {
    const q = SearchView.readQueryFromHash();
    if (q !== this.query) this.query = q;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.query = SearchView.readQueryFromHash();
    window.addEventListener('hashchange', this.hashListener);
    void this.load();
    requestAnimationFrame(() => this.focusInput());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.hashListener);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private focusInput(): void {
    const root = this.renderRoot as ShadowRoot;
    const input = root.querySelector<HTMLInputElement>('.search-input');
    input?.focus();
  }

  static readQueryFromHash(): string {
    const hash = window.location.hash;
    const idx = hash.indexOf('?');
    if (idx < 0) return '';
    const params = new URLSearchParams(hash.slice(idx + 1));
    return params.get('q') ?? '';
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.library = await apiLibrary({ includeStale: true });
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

  private onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.query = v;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const newHash = v.trim()
        ? `#/search?q=${encodeURIComponent(v.trim())}`
        : '#/search';
      // Use replace so back button doesn't accumulate one entry per keystroke.
      window.history.replaceState(null, '', newHash);
    }, 200);
  }

  private filtered(): LibraryItem[] {
    if (!this.library) return [];
    const q = this.query.trim().toLowerCase();
    if (!q) return [];
    const all = [...this.library.movies, ...this.library.series];
    return all
      .filter((i) => (i.title ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  }

  private onTileClick(item: LibraryItem): void {
    // 0.1.10 — soft-deleted rows are listed for searchability but their
    // playable file isn't on disk; navigating to the player would 404 the
    // stream route. Series rows still navigate to detail (so the user can
    // see what episodes existed); movies are non-clickable until restored.
    if (item.deletedAt != null && item.type === 'movie') return;
    if (item.type === 'series') {
      navigate(seriesHref(item.id));
    } else {
      navigate(playHref(item.path));
    }
  }

  override render(): unknown {
    const results = this.filtered();
    return html`
      <div class="header">
        <button
          class="icon-btn"
          title="Back"
          @click=${(): void => goBack(homeHref())}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <input
          class="search-input"
          type="search"
          placeholder="Search your library"
          .value=${this.query}
          @input=${(e: Event): void => this.onInput(e)}
        />
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : null}
      <div class="body">${this.renderResults(results)}</div>
    `;
  }

  private renderResults(results: LibraryItem[]): unknown {
    if (this.loading && !this.library) {
      return html`<div class="empty">Loading…</div>`;
    }
    if (!this.query.trim()) {
      return html`<div class="empty">Start typing to search.</div>`;
    }
    if (results.length === 0) {
      return html`<div class="empty">No matches for "${this.query}".</div>`;
    }
    return html`
      <div class="grid">
        ${results.map((item) => this.renderTile(item))}
      </div>
    `;
  }

  private renderTile(item: LibraryItem): unknown {
    const title = item.title ?? item.path;
    const ratingLabel = formatImdbRating(item.imdbRating);
    const stale = item.deletedAt != null;
    return html`
      <button
        class=${stale ? 'tile stale' : 'tile'}
        @click=${(): void => this.onTileClick(item)}
      >
        <div class="frame">
          ${item.posterUrl
            ? html`<img src=${item.posterUrl} alt=${title} loading="lazy" />`
            : html`<div class="placeholder">${title}</div>`}
          ${ratingLabel
            ? html`<span class="rating-pill" aria-label=${`IMDb rating ${ratingLabel} of 10`}>
                <svg class="star" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2 L14.85 8.63 L22 9.27 L16.5 14.14 L18.18 21.02 L12 17.27 L5.82 21.02 L7.5 14.14 L2 9.27 L9.15 8.63 Z"></path>
                </svg>
                ${ratingLabel}
              </span>`
            : null}
          <span class="badge">${item.type}</span>
          ${stale ? html`<span class="stale-badge">not on disk</span>` : null}
        </div>
        <div class="meta">
          <div class="title" title=${title}>${title}</div>
          ${item.year ? html`<div class="year">${item.year}</div>` : null}
        </div>
      </button>
    `;
  }
}
