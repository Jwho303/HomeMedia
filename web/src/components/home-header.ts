import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { SortMode } from './home-chunks.js';
import type { ScanPhase } from '../scan-progress-store.js';
import { navigate } from '../router.js';
import { iconBumperLeft, iconBumperRight } from './icons.js';

export type LibraryToggle = 'movies' | 'series';

/**
 * 0.1.5.1 — sticky header for `<home-view>`.
 *
 * Layout: `[search input] [Movies|Series] [Sort ▾] ............. [↻ | ⚙]`
 *
 *  - The search input is a real `<input type="search">` that navigates to
 *    `#/search?q=...` on Enter — it does not filter the home grid in place.
 *  - The action group is one visual unit: the smart-refresh `↻` and the
 *    settings gear `⚙` share a border with a vertical divider between them.
 *    The gear's menu hosts "Hard refresh" + "Re-probe library" for v1.
 *  - While a scan is active, the `↻` button widens to display the inline
 *    progress: `↻ 12/47 — Sunny.S04E01.mkv`. Truncates with ellipsis when
 *    the viewport is narrow.
 */
@customElement('home-header')
export class HomeHeader extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .spacer { flex: 1; }

    /* Search input — left edge of the row. */
    .search-input {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font: inherit;
      font-size: 13px;
      padding: 6px 10px;
      width: 200px;
      max-width: 32vw;
      flex-shrink: 0;
    }
    .search-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .search-input::placeholder { color: var(--text-tertiary); }

    .toggle {
      display: inline-flex;
      background: var(--surface-elevated);
      border-radius: var(--radius-pill);
      overflow: hidden;
      border: 1px solid var(--border-strong);
      flex-shrink: 0;
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
      transition: background 0.1s ease, color 0.1s ease;
    }
    .toggle button:hover { color: var(--text-primary); }
    .toggle button.active {
      background: var(--surface-pressed);
      color: var(--text-primary);
      font-weight: 600;
    }
    /* 0.2.0 — inline bumper glyph on the tabs (dpad mode). Sits beside the
     *  label so it reads "LB Movies" / "Series RB", like a console app. */
    .toggle button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .bumper-glyph {
      display: inline-block;
      width: 26px;
      height: 16px;
      flex: 0 0 auto;
    }

    .sort {
      position: relative;
      flex-shrink: 0;
    }
    .sort-button {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      padding: 6px 10px;
      font-size: 13px;
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .sort-button:hover { border-color: var(--accent); }

    .sort-menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-popover);
      padding: 4px 0;
      min-width: 200px;
      z-index: 10;
    }
    .sort-menu button {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .sort-menu button:hover:not(:disabled) { background: var(--surface-pressed); color: var(--text-primary); }
    .sort-menu button:disabled { color: var(--text-disabled); cursor: default; }
    .sort-menu button.active { color: var(--accent); font-weight: 600; }

    /* Action group: refresh button + gear button rendered as one unit with a
     *  vertical divider between them. Width grows during an active scan to
     *  accommodate the inline counter + filename.
     *
     *  IMPORTANT: do NOT use overflow:hidden here. The gear dropdown menu
     *  needs to escape this container's bottom edge. We rely on border-radius
     *  on the corner buttons themselves (.refresh-btn left, .sort > .action-btn
     *  right) to round the group's outer corners. (Reproduced bug pre-fix:
     *  dropdown was clipped invisibly, making it look like the gear button
     *  did nothing.) */
    .action-group {
      display: inline-flex;
      align-items: stretch;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      flex-shrink: 0;
      min-width: 0;
      max-width: 60vw;
    }
    .action-group .divider {
      width: 1px;
      background: var(--border-strong);
      flex-shrink: 0;
    }
    .action-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      min-height: 32px;
      box-sizing: border-box;
      font: inherit;
      font-size: 12px;
      min-width: 0;
    }
    /* Round only the outer corners so the buttons sit flush against the
     *  shared group border without overflow:hidden. */
    .action-group > .action-btn:first-child { border-radius: 5px 0 0 5px; }
    .action-group > .sort:last-child > .action-btn { border-radius: 0 5px 5px 0; }
    .action-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--surface-pressed); }
    .action-btn:disabled { opacity: 0.5; cursor: default; }
    .action-btn svg { width: 16px; height: 16px; flex-shrink: 0; }

    .refresh-btn .progress-text {
      font-variant-numeric: tabular-nums;
      color: var(--accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .refresh-btn.scanning svg {
      animation: spin 1.4s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;

  @property({ type: String }) toggle: LibraryToggle = 'movies';
  @property({ type: String }) sortMode: SortMode = 'dateAdded';
  @property({ type: Boolean }) refreshing = false;
  @property({ type: Boolean }) online = true;
  /** True while any scan-flavored job is running (refresh or re-probe). */
  @property({ type: Boolean }) jobActive = false;
  /** Inline progress display while scanning. */
  @property({ type: Number }) scanI = 0;
  @property({ type: Number }) scanN = 0;
  @property({ type: String }) scanCurrentFile: string | null = null;
  @property({ type: String }) scanPhase: ScanPhase = null;
  /** 0.2.0 — couch mode. When in dpad input, the Movies/Series tabs show
   *  shoulder-button (bumper) glyphs and the bumpers switch tabs (the D-pad is
   *  busy moving the grid selection). `glyphPlatform` themes the bumper labels
   *  (LB/RB vs L1/R1). */
  @property({ type: Boolean }) dpad = false;
  @property({ type: String }) glyphPlatform = 'generic';

  @state() private sortOpen = false;
  @state() private gearOpen = false;
  @state() private searchValue = '';

  private slashListener = (e: KeyboardEvent): void => {
    // Browser-style "/" keypress focuses the search input. Skip when the
    // user is already typing into a form field or a modifier is held.
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
    e.preventDefault();
    const root = this.renderRoot as ShadowRoot;
    const input = root.querySelector<HTMLInputElement>('.search-input');
    input?.focus();
  };

  /** 0.2.0 — bumper → tab switch. The D-pad moves the grid selection, so tabs
   *  need a different button: the shoulder bumpers. On Xbox Edge and the PS5
   *  browser the bumpers arrive as keyboard events; we accept the common
   *  codes (LB/L1 ≈ '[' / BracketLeft / PageUp, RB/R1 ≈ ']' / BracketRight /
   *  PageDown). LB → Movies, RB → Series. Only active in dpad mode, and never
   *  while typing in the search box. */
  private bumperListener = (e: KeyboardEvent): void => {
    if (!this.dpad || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

    const k = e.key;
    const code = e.code;
    const isLeft = k === '[' || code === 'BracketLeft' || k === 'PageUp';
    const isRight = k === ']' || code === 'BracketRight' || k === 'PageDown';
    if (!isLeft && !isRight) return;

    e.preventDefault();
    this.emitToggle(isLeft ? 'movies' : 'series');
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.slashListener);
    document.addEventListener('keydown', this.bumperListener);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.slashListener);
    document.removeEventListener('keydown', this.bumperListener);
  }

  private static SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
    { key: 'dateAdded', label: 'Date Added' },
    { key: 'releaseDate', label: 'Release Date' },
    { key: 'genre', label: 'Genre' },
    { key: 'name', label: 'Name' },
  ];

  private emitToggle(value: LibraryToggle): void {
    this.dispatchEvent(new CustomEvent('toggle-change', { detail: value, bubbles: true, composed: true }));
  }

  /** The bumper label for a side, themed by platform — also the title tooltip
   *  and the test hook (the SVG <text> doesn't serialize in happy-dom). */
  private bumperLabel(side: 'left' | 'right'): string {
    if (this.glyphPlatform === 'playstation') return side === 'left' ? 'L1' : 'R1';
    if (this.glyphPlatform === 'xbox') return side === 'left' ? 'LB' : 'RB';
    return side === 'left' ? 'L' : 'R';
  }

  private emitSort(value: SortMode): void {
    this.sortOpen = false;
    this.dispatchEvent(new CustomEvent('sort-change', { detail: value, bubbles: true, composed: true }));
  }

  private emitRefresh(full: boolean): void {
    this.dispatchEvent(
      new CustomEvent<{ full: boolean }>('refresh', {
        detail: { full },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitReprobeLibrary(): void {
    this.gearOpen = false;
    this.dispatchEvent(new CustomEvent('reprobe-library', { bubbles: true, composed: true }));
  }

  private onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.dispatchEvent(
        new CustomEvent<string>('search', {
          detail: this.searchValue,
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private onSearchInput(e: Event): void {
    this.searchValue = (e.target as HTMLInputElement).value;
  }

  private filenameOnly(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  private renderRefreshContent(): unknown {
    const icon = html`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
    `;
    if (!this.jobActive) return icon;
    const denom = this.scanN || '?';
    const progressText =
      this.scanCurrentFile != null
        ? `${this.scanI}/${denom} — ${this.filenameOnly(this.scanCurrentFile)}`
        : `${this.scanI}/${denom}`;
    return html`${icon}<span class="progress-text" title=${this.scanCurrentFile ?? ''}>${progressText}</span>`;
  }

  override render(): unknown {
    const sortLabel =
      HomeHeader.SORT_OPTIONS.find((o) => o.key === this.sortMode)?.label ?? 'Sort';
    const refreshTitle = !this.online
      ? 'Offline'
      : this.jobActive
        ? this.scanCurrentFile ?? 'Scanning…'
        : 'Refresh';
    return html`
      <div class="row">
        <input
          class="search-input"
          type="search"
          placeholder="Search"
          .value=${this.searchValue}
          @input=${(e: Event): void => this.onSearchInput(e)}
          @keydown=${(e: KeyboardEvent): void => this.onSearchKeydown(e)}
        />
        <div class="toggle">
          <button
            class=${this.toggle === 'movies' ? 'active' : ''}
            @click=${(): void => this.emitToggle('movies')}
          >${this.dpad
            ? html`<span
                class="bumper-glyph"
                data-bumper="left"
                title=${this.bumperLabel('left')}
                >${iconBumperLeft(this.glyphPlatform)}</span
              >`
            : null}Movies</button>
          <button
            class=${this.toggle === 'series' ? 'active' : ''}
            @click=${(): void => this.emitToggle('series')}
          >Series${this.dpad
            ? html`<span
                class="bumper-glyph"
                data-bumper="right"
                title=${this.bumperLabel('right')}
                >${iconBumperRight(this.glyphPlatform)}</span
              >`
            : null}</button>
        </div>
        <div class="sort">
          <button class="sort-button" @click=${(): void => { this.sortOpen = !this.sortOpen; }}>
            ${sortLabel} ▾
          </button>
          ${this.sortOpen
            ? html`<div class="sort-menu">
                ${HomeHeader.SORT_OPTIONS.map(
                  (o) => html`<button
                    class=${o.key === this.sortMode ? 'active' : ''}
                    @click=${(): void => this.emitSort(o.key)}
                  >${o.label}</button>`,
                )}
              </div>`
            : null}
        </div>
        <div class="spacer"></div>
        <div class="action-group">
          <button
            class=${this.jobActive ? 'action-btn refresh-btn scanning' : 'action-btn refresh-btn'}
            title=${refreshTitle}
            ?disabled=${this.jobActive || !this.online}
            @click=${(): void => this.emitRefresh(false)}
          >${this.renderRefreshContent()}</button>
          <div class="divider"></div>
          <div class="sort">
            <button
              class="action-btn"
              title="More"
              ?disabled=${!this.online}
              @click=${(): void => { this.gearOpen = !this.gearOpen; }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            ${this.gearOpen
              ? html`<div class="sort-menu">
                  <button
                    ?disabled=${this.jobActive || !this.online}
                    @click=${(): void => { this.gearOpen = false; this.emitRefresh(true); }}
                  >Hard refresh</button>
                  <button
                    ?disabled=${this.jobActive || !this.online}
                    @click=${(): void => this.emitReprobeLibrary()}
                  >Re-probe library</button>
                  <button
                    @click=${(): void => { this.gearOpen = false; navigate('#/uncategorized'); }}
                  >Uncategorized media</button>
                  <button
                    @click=${(): void => { this.gearOpen = false; navigate('#/settings'); }}
                  >Settings</button>
                </div>`
              : null}
          </div>
        </div>
      </div>
    `;
  }
}
