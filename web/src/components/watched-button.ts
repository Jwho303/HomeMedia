import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Extra menu item passed in from a parent (e.g. "Re-probe", "Identify manually…").
 *  Appears below the standard Mark watched/unwatched items, separated by a
 *  divider. (0.1.5.1 / 0.1.5.2) */
export interface WatchedButtonExtraItem {
  label: string;
  /** When true, the row is greyed out and click is a no-op. Used during a job. */
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Multi-purpose kebab/check button overlaid on poster cards and episode tiles.
 *
 * Two visual states (driven by the `watched` property):
 *   - watched=false → dark semi-transparent kebab (⋮)
 *   - watched=true  → solid green circle with a black checkmark
 *
 * Click toggles a small popover with two actions: "Mark as watched" and
 * "Mark as unwatched". The component is purely a UI; selecting an action
 * fires a `watched-change` CustomEvent with `detail.watched: boolean` and
 * the parent is responsible for calling the API + refreshing data.
 *
 * Click events are stopped at the button boundary so opening the menu
 * doesn't also navigate into the card behind it.
 *
 * The popover is rendered with `position: fixed` and pinned to the button's
 * computed viewport coordinates. This dodges the parent card's
 * `overflow: hidden` (which would otherwise clip the menu inside the poster
 * frame) and lets us flip the menu's horizontal alignment when the button
 * sits close to the right edge of the viewport.
 */
@customElement('watched-button')
export class WatchedButton extends LitElement {
  static override styles = css`
    :host {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 4;
    }

    .btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.1s ease, transform 0.1s ease;
    }
    .btn.kebab {
      background: var(--scrim-soft);
      color: var(--on-scrim);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .btn.kebab:hover { background: var(--scrim-strong); transform: scale(1.06); }
    .btn.check {
      background: var(--watched);
      color: var(--on-watched);
    }
    .btn.check:hover { transform: scale(1.06); filter: brightness(1.15); }
    .btn svg { width: 14px; height: 14px; display: block; }

    /* Menu styles intentionally not declared here — the menu is rendered
     *  into document.body as a light-DOM portal (see openPortal()) so that
     *  CSS filter/transform ancestors on the host card can't create a
     *  stacking context that clips a fixed-position descendant. */
  `;

  @property({ type: Boolean }) watched = false;
  /** Optional label adjustment — e.g. for series we say "show", for movies "movie".
   *  Defaults to "this" which reads naturally enough in the menu items. */
  @property({ type: String }) kind: 'movie' | 'series' | 'episode' | 'item' = 'item';
  /** Optional extra items to append below "Mark as watched / unwatched", separated
   *  by a divider. Used by poster-strip / season-strip to surface "Re-probe" and
   *  "Identify manually…" without rendering a second kebab next to this one. */
  @property({ attribute: false }) extraItems: WatchedButtonExtraItem[] = [];

  /** Set when the portal menu is mounted on document.body. We can't keep this
   *  in Lit's render tree because the host card frequently has a CSS filter
   *  or transform ancestor (hover brightness, scale on hover, fullscreen
   *  player) — those create a containing block that traps fixed-position
   *  descendants. The menu sidesteps that by living outside the shadow DOM. */
  private menuEl: HTMLDivElement | null = null;

  private outsideClickListener = (e: MouseEvent): void => {
    if (!this.menuEl) return;
    const path = e.composedPath();
    // Click inside the host (button) OR inside the menu portal → keep open.
    if (path.includes(this) || path.includes(this.menuEl)) return;
    this.closeMenu();
  };

  /** Close on scroll/resize: the fixed-position coordinates computed at
   *  open time would otherwise drift. */
  private dismissOnReflow = (): void => {
    this.closeMenu();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.outsideClickListener, true);
    window.addEventListener('scroll', this.dismissOnReflow, true);
    window.addEventListener('resize', this.dismissOnReflow);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.outsideClickListener, true);
    window.removeEventListener('scroll', this.dismissOnReflow, true);
    window.removeEventListener('resize', this.dismissOnReflow);
    this.closeMenu();
  }

  private toggle(e: Event): void {
    e.stopPropagation();
    if (this.menuEl) this.closeMenu();
    else this.openMenu();
  }

  private openMenu(): void {
    if (this.menuEl) return;
    const root = this.renderRoot as ShadowRoot;
    const btn = root.querySelector<HTMLElement>('.btn');
    if (!btn) return;

    const menu = document.createElement('div');
    menu.setAttribute('data-watched-button-menu', '');
    Object.assign(menu.style, {
      position: 'fixed',
      background: 'var(--surface-elevated, #161616)',
      border: '1px solid var(--border-strong, #262626)',
      borderRadius: 'var(--radius-lg, 10px)',
      boxShadow: 'var(--shadow-popover, 0 16px 36px rgba(0, 0, 0, 0.7))',
      minWidth: '160px',
      padding: '4px 0',
      zIndex: '2147483647',
    } as CSSStyleDeclaration);
    // Both items always enabled — partially-played items aren't "watched" but
    // still benefit from "Mark as unwatched" to wipe their resume position.
    // The backend calls are idempotent, so no harm if the user picks a no-op.
    menu.appendChild(this.makeMenuButton('Mark as watched', false, () => this.select(true)));
    menu.appendChild(this.makeMenuButton('Mark as unwatched', false, () => this.select(false)));

    // 0.1.5.1 / 0.1.5.2 — caller-supplied items (Re-probe, Identify manually…)
    // appear below a divider. Keeping them in this menu — instead of a second
    // adjacent kebab — means there's only one ⋮ on each card.
    if (this.extraItems.length > 0) {
      menu.appendChild(this.makeDivider());
      for (const item of this.extraItems) {
        menu.appendChild(
          this.makeMenuButton(item.label, item.disabled === true, () => {
            this.closeMenu();
            item.onClick();
          }),
        );
      }
    }

    document.body.appendChild(menu);
    this.menuEl = menu;
    this.positionMenu();
    // If the host moves while open (rare — we close on scroll/resize), at
    // least keep position correct on the same paint frame.
    requestAnimationFrame(() => this.positionMenu());
  }

  private makeMenuButton(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    Object.assign(b.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      background: 'transparent',
      border: 'none',
      color: disabled ? 'var(--text-disabled, #404040)' : 'var(--text-secondary, #a0a0a0)',
      padding: '8px 12px',
      fontSize: '12px',
      cursor: disabled ? 'default' : 'pointer',
      whiteSpace: 'nowrap',
      fontFamily: 'inherit',
    } as CSSStyleDeclaration);
    if (!disabled) {
      b.addEventListener('mouseenter', () => {
        b.style.background = 'var(--surface-pressed, #262626)';
        b.style.color = 'var(--text-primary, #ffffff)';
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = 'transparent';
        b.style.color = 'var(--text-secondary, #a0a0a0)';
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
    }
    return b;
  }

  private makeDivider(): HTMLDivElement {
    const d = document.createElement('div');
    Object.assign(d.style, {
      height: '1px',
      background: 'var(--border-strong, #262626)',
      margin: '4px 0',
    } as CSSStyleDeclaration);
    return d;
  }

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
  }

  private positionMenu(): void {
    if (!this.menuEl) return;
    const root = this.renderRoot as ShadowRoot;
    const btn = root.querySelector<HTMLElement>('.btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const MENU_W = this.menuEl.offsetWidth || 180;
    const MENU_H = this.menuEl.offsetHeight || 80;
    const GUTTER = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: right-aligned to the button (menu grows leftward from the kebab).
    let left = rect.right - MENU_W;
    if (left < GUTTER) left = Math.min(rect.left, vw - MENU_W - GUTTER);
    if (left < GUTTER) left = GUTTER;

    // Default: drop below; flip above when there's no room.
    let top = rect.bottom + 4;
    if (top + MENU_H > vh - GUTTER) {
      const above = rect.top - MENU_H - 4;
      if (above >= GUTTER) top = above;
      else top = Math.max(GUTTER, vh - MENU_H - GUTTER);
    }
    this.menuEl.style.top = `${top}px`;
    this.menuEl.style.left = `${left}px`;
  }

  private select(watched: boolean): void {
    this.closeMenu();
    this.dispatchEvent(
      new CustomEvent('watched-change', {
        detail: { watched },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): unknown {
    const cls = this.watched ? 'btn check' : 'btn kebab';
    return html`
      <button
        class=${cls}
        title=${this.watched ? 'Watched' : 'Options'}
        @click=${(e: Event): void => this.toggle(e)}
      >
        ${this.watched
          ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="5 12 10 17 19 7"></polyline>
            </svg>`
          : html`<svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.6"></circle>
              <circle cx="12" cy="12" r="1.6"></circle>
              <circle cx="12" cy="19" r="1.6"></circle>
            </svg>`}
      </button>
    `;
  }
}
