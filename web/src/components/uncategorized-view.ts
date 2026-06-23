import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiUncategorizedList, ShareOfflineError, type UncategorizedItem } from '../api.js';
import { navigate, playHref, homeHref } from '../router.js';
import { setHomeToggle } from './home-view.js';
import type { ManualIdentifyTarget } from './manual-identify-modal.js';

/**
 * Uncategorized library view — a flat, opt-in "remainders" list of every file
 * on disk that the scanner couldn't gate into Movies or Series (every alive
 * `needs_review` row). Deliberately un-prettified: filename + raw reason, with
 * a Play action (works today, no identity required) and an Identify action that
 * rescues the file into Movies/Series via a manual override.
 *
 * Reached only through Settings. Its own header shows the three-way nav
 * (Movies · Series · Uncategorized); clicking Movies/Series leaves and the
 * Uncategorized chip vanishes (transient reveal, per spec §5.4).
 */
@customElement('uncategorized-view')
export class UncategorizedView extends LitElement {
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
    .toggle {
      display: inline-flex;
      background: var(--surface-elevated);
      border-radius: var(--radius-pill);
      overflow: hidden;
      border: 1px solid var(--border-strong);
      padding: 2px;
      gap: 2px;
    }
    .toggle button {
      background: transparent;
      color: var(--text-secondary);
      border: none;
      padding: 5px 14px;
      font-size: 13px;
      cursor: pointer;
      border-radius: var(--radius-pill);
    }
    .toggle button:hover { color: var(--text-primary); }
    .toggle button.active {
      background: var(--surface-pressed);
      color: var(--text-primary);
      font-weight: 600;
    }

    .body {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px 16px 64px;
    }
    .intro {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .loading, .empty, .error {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-secondary);
    }
    .error {
      background: var(--surface-elevated);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--error);
    }

    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      padding: 10px 12px;
    }
    .meta {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .name {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .reason {
      font-size: 11px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    button.action {
      background: var(--surface);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: 13px;
      padding: 6px 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.action:hover { border-color: var(--accent); }
  `;

  @state() private items: UncategorizedItem[] | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;

  private libraryInvalidatedListener = (): void => {
    void this.load();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    // A successful rescue removes the row optimistically; this refetch keeps the
    // list authoritative (e.g. if another tab rescued something).
    document.addEventListener('library-invalidated', this.libraryInvalidatedListener);
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('library-invalidated', this.libraryInvalidatedListener);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.items = await apiUncategorizedList();
    } catch (err) {
      if (err instanceof ShareOfflineError) {
        this.error = 'Unavailable — share is offline.';
      } else {
        this.error = (err as Error).message ?? 'Failed to load uncategorized files.';
      }
    } finally {
      this.loading = false;
    }
  }

  /** Leave for the home grid on the chosen tab. The Uncategorized chip only
   *  exists on this route, so navigating away makes it vanish (transient
   *  reveal, spec §5.4). */
  private goHome(tab: 'movies' | 'series'): void {
    setHomeToggle(tab);
    navigate(homeHref());
  }

  private onPlay(path: string): void {
    navigate(playHref(path));
  }

  private onIdentify(path: string): void {
    const target: ManualIdentifyTarget = { kind: 'uncategorized', path };
    this.dispatchEvent(
      new CustomEvent('manual-identify-request', {
        detail: target,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): unknown {
    return html`
      <div class="header">
        <div class="toggle">
          <button @click=${(): void => this.goHome('movies')}>Movies</button>
          <button @click=${(): void => this.goHome('series')}>Series</button>
          <button class="active">Uncategorized</button>
        </div>
      </div>
      <div class="body">
        <p class="intro">
          Files on disk that aren't in Movies or Series — usually identification
          misses or extras/specials. Every file here is playable; use
          <strong>Identify</strong> to assign one to a movie or show so it joins
          the normal library and survives future scans.
        </p>
        ${this.renderBody()}
      </div>
    `;
  }

  private renderBody(): unknown {
    if (this.error) return html`<div class="error">${this.error}</div>`;
    if (this.loading && this.items == null) {
      return html`<div class="loading">Loading…</div>`;
    }
    const items = this.items ?? [];
    if (items.length === 0) {
      return html`<div class="empty">Nothing uncategorized — every file is in Movies or Series.</div>`;
    }
    return html`
      <div class="list">
        ${items.map((it) => this.renderRow(it))}
      </div>
    `;
  }

  private renderRow(it: UncategorizedItem): unknown {
    return html`
      <div class="row">
        <div class="meta">
          <span class="name" title=${it.path}>${basename(it.path)}</span>
          <span class="reason">${it.reason}</span>
        </div>
        <div class="actions">
          <button class="action" @click=${(): void => this.onPlay(it.path)}>Play</button>
          <button class="action" @click=${(): void => this.onIdentify(it.path)}>Identify</button>
        </div>
      </div>
    `;
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
