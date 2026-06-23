/**
 * 0.2.0 (Layer 1, D7) — D-pad / remote / keyboard focus navigation.
 *
 * Attaches a single global `keydown` handler that serves desktop arrow keys,
 * TV remote D-pads, and game-controller D-pads through one model: on Xbox Edge
 * and the PlayStation browser the D-pad emits ArrowUp/Down/Left/Right and the
 * confirm button emits Enter, so a keyboard handler transparently covers all
 * three (D7). No Gamepad API is touched here — that's glyphs only (Layer 2).
 *
 * The player and grids stay platform-unaware (D2): this controller *attaches
 * around* the app, discovering focusable elements by walking the DOM (piercing
 * shadow roots, since the Lit components render into shadow DOM) and moving
 * focus geometrically — nearest-neighbour in the pressed direction. It applies
 * `.hm-focus` to the active element for the focus ring and calls
 * `scrollIntoView` so off-screen rows come into view.
 *
 * `attach()` is a no-op unless `inputMode === 'dpad'`, so desktop pointer and
 * touch builds carry zero behavioural change.
 */

import { goBack, homeHref } from '../router.js';

/** Elements we treat as focusable navigation targets. The list is deliberately
 *  broad and component-agnostic (D2): host custom-elements that act as buttons
 *  (`media-tile`), native interactives, and anything explicitly opted in with
 *  `[data-nav]` or a non-negative `tabindex`. */
const FOCUSABLE_SELECTOR = [
  'media-tile',
  'a[href]',
  'button:not([disabled])',
  '[role="button"]:not([disabled])',
  '[data-nav]',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const FOCUS_CLASS = 'hm-focus';

interface Candidate {
  el: HTMLElement;
  rect: DOMRect;
}

type Direction = 'up' | 'down' | 'left' | 'right';

export interface FocusNavOptions {
  /** Root to attach the keydown listener to. Defaults to `document`. */
  root?: Document | HTMLElement;
  /** Override the input-mode read; defaults to `window.__hm.diag.inputMode`. */
  inputMode?: string;
}

export class FocusNavController {
  private readonly root: Document | HTMLElement;
  private readonly inputMode: string;
  private attached = false;
  private current: HTMLElement | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private menuClosedHandler: ((e: Event) => void) | null = null;
  /** The card whose options menu is open — focus returns here on close. */
  private menuOwner: HTMLElement | null = null;

  constructor(opts: FocusNavOptions = {}) {
    this.root = opts.root ?? document;
    this.inputMode =
      opts.inputMode ??
      (() => {
        const hm = (window as unknown as { __hm?: { diag?: { inputMode?: string } } }).__hm;
        return hm?.diag?.inputMode ?? 'pointer';
      })();
  }

  /** Attach the global keydown handler. No-op unless inputMode === 'dpad'. */
  attach(): void {
    if (this.attached) return;
    if (this.inputMode !== 'dpad') return; // pointer/touch → no nav layer
    this.attached = true;
    this.keydownHandler = (e: KeyboardEvent): void => this.onKeydown(e);
    this.root.addEventListener('keydown', this.keydownHandler as EventListener, true);
    // When a menu closes by any means (outside click, action picked), restore
    // focus to the owning card so the user isn't stranded.
    this.menuClosedHandler = (): void => {
      if (this.menuOwner) {
        const owner = this.menuOwner;
        this.menuOwner = null;
        this.current = null;
        this.setFocus(owner);
      }
    };
    this.root.addEventListener('menu-closed', this.menuClosedHandler as EventListener);
    // Seed focus on the first candidate so the user sees a ring immediately.
    // Deferred a tick so the first view has rendered.
    setTimeout(() => {
      if (!this.current) this.focusFirst();
    }, 0);
  }

  /** Detach: removes the keydown listener and clears the focus ring. After
   *  this there is no leaked handler (acceptance criterion). */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (this.keydownHandler) {
      this.root.removeEventListener('keydown', this.keydownHandler as EventListener, true);
      this.keydownHandler = null;
    }
    if (this.menuClosedHandler) {
      this.root.removeEventListener('menu-closed', this.menuClosedHandler as EventListener);
      this.menuClosedHandler = null;
    }
    this.clearFocus();
  }

  isAttached(): boolean {
    return this.attached;
  }

  getCurrent(): HTMLElement | null {
    return this.current;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent): void {
    // When the player is on screen it owns the directional keys: ArrowLeft/
    // Right seek ±5s, Space toggles play, and the player handles its own
    // Escape (popover → exit-fullscreen). Stealing them here would break couch
    // playback. So while a <media-player> is mounted we yield everything except
    // a top-level Back press (which the player ignores once not fullscreen) —
    // letting the player's own keydown handler run (D2: player stays unaware of
    // the nav layer; the nav layer just declines to interfere).
    if (this.playerActive()) return;

    const menuOpen = this.openMenuPortal() !== null;

    // Menu / Options button → open the focused card's kebab (or close it if
    // already open). On Xbox the Menu (☰) button and on PlayStation the Options
    // button arrive as keyboard events; we accept the standard `ContextMenu`
    // key plus the common console codes. The kebab itself isn't a focus target
    // (its card owns the subtree), so this is the only way to reach it by D-pad.
    if (this.isMenuKey(e)) {
      if (menuOpen) this.closeOpenMenu();
      else this.openFocusedCardMenu();
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case 'ArrowUp':
        this.move('up');
        e.preventDefault();
        break;
      case 'ArrowDown':
        this.move('down');
        e.preventDefault();
        break;
      case 'ArrowLeft':
        this.move('left');
        e.preventDefault();
        break;
      case 'ArrowRight':
        this.move('right');
        e.preventDefault();
        break;
      case 'Enter':
        this.activate();
        e.preventDefault();
        break;
      case 'Escape':
      case 'Backspace':
      case 'GoBack': // some TV remotes emit this synthetic key
      case 'BrowserBack':
        // While a menu is open, Back closes it (and returns focus to the card)
        // instead of navigating away.
        if (menuOpen) {
          this.closeOpenMenu();
        } else {
          // Hardware Back → existing goBack(), falling home if no in-app history.
          goBack(homeHref());
        }
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  /** Recognise the "more options" button — Y (Xbox) / △ (PlayStation), the
   *  conventional per-item context-action face button (NOT the global Menu/
   *  Options button). Face-button → key mapping is less standardised than the
   *  D-pad/Ⓐ/Ⓑ, so we accept the desktop stand-in 'y' plus the codes console
   *  browsers are known to emit for the top face button, and keep ContextMenu
   *  as a fallback for remotes that only have a menu key. */
  private isMenuKey(e: KeyboardEvent): boolean {
    return (
      e.key === 'y' ||
      e.key === 'Y' ||
      e.key === 'Triangle' || // some console browsers name △ literally
      e.code === 'ContextMenu' ||
      e.key === 'ContextMenu' ||
      e.keyCode === 93
    );
  }

  /** The open watched-button menu portal, if any (rendered on document.body). */
  private openMenuPortal(): HTMLElement | null {
    return this.searchRoot().querySelector?.('[data-nav-menu]') ?? null;
  }

  /** Open the kebab/options menu of the currently-focused card. Finds the
   *  <watched-button> inside the focused card and calls its public openMenu(),
   *  then parks focus on the first menu item (the collect() trap takes over). */
  private openFocusedCardMenu(): void {
    if (!this.current) return;
    const wb = this.current.querySelector('watched-button') as
      | (HTMLElement & { openMenu?: () => void })
      | null;
    if (!wb || typeof wb.openMenu !== 'function') return;
    // Remember the card so we can restore focus when the menu closes.
    this.menuOwner = this.current;
    wb.openMenu();
    // Focus the first menu item once the portal has mounted.
    setTimeout(() => {
      const portal = this.openMenuPortal();
      const first = portal?.querySelector('[data-nav]') as HTMLElement | null;
      if (first) this.setFocus(first);
    }, 0);
  }

  /** Close the open menu. Focus is restored to the owning card by the
   *  `menu-closed` handler (so outside-click, action-pick, and Back all funnel
   *  through one restore path). */
  private closeOpenMenu(): void {
    const wb = this.menuOwner?.querySelector('watched-button') as
      | (HTMLElement & { closeMenu?: () => void })
      | null;
    if (wb && typeof wb.closeMenu === 'function') {
      wb.closeMenu(); // dispatches menu-closed → menuClosedHandler restores focus
      return;
    }
    // Fallback: no owner tracked (e.g. opened by mouse) — just remove the portal.
    const portal = this.openMenuPortal();
    if (portal) portal.remove();
  }

  /** True while a `<media-player>` is mounted — the player owns the keys then.
   *  Cheap DOM presence check; the player view is a full-screen takeover, so
   *  its mere presence means "we're watching", not "we're browsing". */
  private playerActive(): boolean {
    return !!this.searchRoot().querySelector('media-player');
  }

  /** The node we run querySelector against: the root itself when it's a
   *  Document, else its ownerDocument so we sweep the whole page. Uses
   *  `nodeType === 9` (DOCUMENT_NODE) rather than `instanceof Document` —
   *  happy-dom's document is not an instance of the global Document ctor. */
  private searchRoot(): Document | HTMLElement {
    if ((this.root as Node).nodeType === 9 /* DOCUMENT_NODE */) {
      return this.root as Document;
    }
    return (this.root as HTMLElement).ownerDocument ?? (this.root as HTMLElement);
  }

  /** Collect every visible focusable element in document order, piercing the
   *  shadow roots the Lit components render into. */
  private collect(): Candidate[] {
    // Focus trap: while an options menu is open, only its items are navigable
    // (arrows stay within the menu, can't escape to the grid behind it).
    const menu = this.openMenuPortal();
    if (menu) {
      const items: Candidate[] = [];
      menu.querySelectorAll('[data-nav]').forEach((el) => {
        const he = el as HTMLElement;
        if (this.isVisible(he)) items.push({ el: he, rect: he.getBoundingClientRect() });
      });
      if (items.length > 0) return items;
    }

    const out: Candidate[] = [];
    const startRoot: Document | ShadowRoot | HTMLElement = this.searchRoot();
    const walk = (node: Document | ShadowRoot | HTMLElement): void => {
      // Match against this root's own tree.
      const matches = (node as ParentNode).querySelectorAll?.(FOCUSABLE_SELECTOR);
      if (matches) {
        matches.forEach((el) => {
          const he = el as HTMLElement;
          if (this.isVisible(he)) {
            out.push({ el: he, rect: he.getBoundingClientRect() });
          }
        });
      }
      // Recurse into shadow roots of every element under this root.
      const all = (node as ParentNode).querySelectorAll?.('*');
      all?.forEach((el) => {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      });
    };
    walk(startRoot);
    // De-dupe (an element can match in multiple passes) preserving order.
    const seen = new Set<HTMLElement>();
    let list = out.filter((c) => (seen.has(c.el) ? false : (seen.add(c.el), true)));

    // Coalesce nested targets: a poster card is marked [data-nav] but contains
    // its own focusables (the kebab/watched button). The user wants to land on
    // the CARD and have its border light up — not tab into the kebba inside it.
    // So drop any candidate that is contained within another [data-nav]
    // candidate; the outer nav group owns its subtree. (Elements not inside any
    // data-nav group — header buttons, search — are unaffected.)
    const navGroups = list.filter((c) => c.el.hasAttribute('data-nav')).map((c) => c.el);
    if (navGroups.length > 0) {
      list = list.filter((c) => {
        // Keep the group itself; drop anything nested inside a (different) group.
        for (let i = 0; i < navGroups.length; i++) {
          const g = navGroups[i]!;
          if (g !== c.el && this.contains(g, c.el)) return false;
        }
        return true;
      });
    }
    return list;
  }

  /** Shadow-DOM-piercing `contains`: walks `child`'s ancestor chain, hopping
   *  across shadow boundaries via host, to see if `ancestor` encloses it. */
  private contains(ancestor: HTMLElement, child: HTMLElement): boolean {
    let node: Node | null = child;
    while (node) {
      if (node === ancestor) return true;
      const parent: Node | null = node.parentNode;
      if (parent) {
        node = parent;
      } else {
        // Crossed a shadow root — continue from its host.
        const root = node.getRootNode() as ShadowRoot | null;
        node = root && root.host ? (root.host as Node) : null;
      }
    }
    return false;
  }

  private isVisible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  private centre(rect: DOMRect): { x: number; y: number } {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** Move focus to the geometrically nearest candidate in `dir`. */
  private move(dir: Direction): void {
    const candidates = this.collect();
    if (candidates.length === 0) return;

    if (!this.current || !this.isStillPresent(this.current, candidates)) {
      // No anchor yet — focus the first candidate.
      this.setFocus(candidates[0]!.el);
      return;
    }

    const fromRect = this.current.getBoundingClientRect();
    const from = this.centre(fromRect);

    let best: Candidate | null = null;
    let bestScore = Infinity;

    for (const c of candidates) {
      if (c.el === this.current) continue;
      const to = this.centre(c.rect);
      const dx = to.x - from.x;
      const dy = to.y - from.y;

      // Must lie in the pressed direction (primary axis), with a small
      // tolerance so a near-aligned neighbour still qualifies.
      if (!this.inDirection(dir, dx, dy)) continue;

      // Score = distance along the primary axis + an off-axis penalty so the
      // controller prefers the element most directly in line. The penalty is
      // weighted heavier than the primary distance to avoid diagonal jumps.
      const primary = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      const offAxis = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = primary + offAxis * 2;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) this.setFocus(best.el);
  }

  private inDirection(dir: Direction, dx: number, dy: number): boolean {
    // A small dead-zone (in px) keeps a perfectly-aligned neighbour from being
    // rejected by sub-pixel rounding.
    const EPS = 1;
    switch (dir) {
      case 'right':
        return dx > EPS && Math.abs(dx) >= Math.abs(dy);
      case 'left':
        return dx < -EPS && Math.abs(dx) >= Math.abs(dy);
      case 'down':
        return dy > EPS && Math.abs(dy) >= Math.abs(dx);
      case 'up':
        return dy < -EPS && Math.abs(dy) >= Math.abs(dx);
      default:
        return false;
    }
  }

  private isStillPresent(el: HTMLElement, candidates: Candidate[]): boolean {
    return candidates.some((c) => c.el === el);
  }

  private focusFirst(): void {
    const candidates = this.collect();
    if (candidates.length > 0) this.setFocus(candidates[0]!.el);
  }

  private setFocus(el: HTMLElement): void {
    this.clearFocus();
    this.current = el;
    el.classList.add(FOCUS_CLASS);
    // Roving tabindex so native focus tracks the visual ring (helps screen
    // readers + lets Enter target the right element on engines that route
    // activation through document.activeElement).
    el.setAttribute('tabindex', '0');
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* some custom elements aren't natively focusable; the ring still shows */
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private clearFocus(): void {
    if (this.current) {
      this.current.classList.remove(FOCUS_CLASS);
      this.current = null;
    }
  }

  /** Enter → dispatch the same activation a pointer click would. */
  private activate(): void {
    if (!this.current) {
      this.focusFirst();
      return;
    }
    const el = this.current;
    // A real click() fires the component's existing @click handler — navigate(),
    // play, etc. — so the player/grids need no nav-specific wiring (D2).
    el.click();
  }
}

/** Convenience singleton accessor — the app-shell attaches one controller for
 *  the whole document. */
let singleton: FocusNavController | null = null;

export function getFocusNav(opts: FocusNavOptions = {}): FocusNavController {
  if (!singleton) singleton = new FocusNavController(opts);
  return singleton;
}

/** Test seam — drop the singleton so each test starts clean. */
export function __resetFocusNavForTests(): void {
  singleton?.detach();
  singleton = null;
}
