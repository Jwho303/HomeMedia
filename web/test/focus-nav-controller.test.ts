import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FocusNavController } from '../src/nav/focus-nav-controller.js';

/**
 * 0.2.0 Phase 2 — focus navigation.
 *
 * happy-dom doesn't lay elements out, so getBoundingClientRect() returns
 * zeros. We stub it per-element with a synthetic grid so the nearest-neighbour
 * direction math is exercised deterministically.
 */

function makeTile(id: string, x: number, y: number, w = 100, h = 150): HTMLElement {
  const el = document.createElement('button');
  el.id = id;
  el.textContent = id;
  // Stub geometry + visibility.
  el.getBoundingClientRect = (): DOMRect =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y } as DOMRect);
  Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true });
  // happy-dom getComputedStyle returns visible by default; scrollIntoView noop.
  el.scrollIntoView = (): void => undefined;
  return el;
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('FocusNavController — attach lifecycle (D2 flag, not route)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attach() is a no-op when inputMode !== "dpad"', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const ctl = new FocusNavController({ inputMode: 'pointer' });
    ctl.attach();
    expect(ctl.isAttached()).toBe(false);
    expect(addSpy).not.toHaveBeenCalledWith('keydown', expect.anything(), true);
  });

  it('attach() installs a keydown listener in dpad mode', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const ctl = new FocusNavController({ inputMode: 'dpad' });
    ctl.attach();
    expect(ctl.isAttached()).toBe(true);
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.anything(), true);
    ctl.detach();
  });

  it('detach() removes the keydown listener (no leak)', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const ctl = new FocusNavController({ inputMode: 'dpad' });
    ctl.attach();
    ctl.detach();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.anything(), true);
    expect(ctl.isAttached()).toBe(false);
    // After detach, a keypress must not move focus.
    document.body.appendChild(makeTile('a', 0, 0));
    press('ArrowRight');
    expect(ctl.getCurrent()).toBeNull();
  });
});

describe('FocusNavController — nearest-neighbour direction math', () => {
  let ctl: FocusNavController;

  beforeEach(() => {
    document.body.innerHTML = '';
    ctl = new FocusNavController({ inputMode: 'dpad' });
  });
  afterEach(() => {
    ctl.detach();
  });

  it('ArrowRight moves to the geometrically nearest poster to the right', () => {
    // Row: a(0) b(120) c(240); plus a far one below to prove direction filter.
    const a = makeTile('a', 0, 0);
    const b = makeTile('b', 120, 0);
    const c = makeTile('c', 240, 0);
    const below = makeTile('below', 0, 200);
    document.body.append(a, b, c, below);
    ctl.attach();
    // Seed focus on `a` deterministically (avoid the async focusFirst timer).
    press('ArrowRight'); // no current → focuses first (a)
    expect(ctl.getCurrent()?.id).toBe('a');
    press('ArrowRight'); // a → nearest right is b
    expect(ctl.getCurrent()?.id).toBe('b');
    press('ArrowRight'); // b → c
    expect(ctl.getCurrent()?.id).toBe('c');
  });

  it('ArrowDown from the top row focuses the row below', () => {
    const top = makeTile('top', 0, 0);
    const bottom = makeTile('bottom', 0, 200);
    const bottomRight = makeTile('bottomRight', 300, 200);
    document.body.append(top, bottom, bottomRight);
    ctl.attach();
    press('ArrowDown'); // focuses first (top, document order)
    expect(ctl.getCurrent()?.id).toBe('top');
    press('ArrowDown'); // straight down → bottom (off-axis penalty rejects bottomRight)
    expect(ctl.getCurrent()?.id).toBe('bottom');
  });

  it('does not move past the edge (no candidate in direction)', () => {
    const a = makeTile('a', 0, 0);
    const b = makeTile('b', 120, 0);
    document.body.append(a, b);
    ctl.attach();
    press('ArrowRight'); // a
    press('ArrowRight'); // b
    expect(ctl.getCurrent()?.id).toBe('b');
    press('ArrowRight'); // nothing further right → stays on b
    expect(ctl.getCurrent()?.id).toBe('b');
    press('ArrowLeft'); // back to a
    expect(ctl.getCurrent()?.id).toBe('a');
  });

  it('applies the .hm-focus ring to the focused element (not :hover)', () => {
    const a = makeTile('a', 0, 0);
    document.body.append(a);
    ctl.attach();
    press('ArrowRight');
    expect(a.classList.contains('hm-focus')).toBe(true);
  });
});

describe('FocusNavController — nav groups own their subtree', () => {
  let ctl: FocusNavController;
  beforeEach(() => {
    document.body.innerHTML = '';
    ctl = new FocusNavController({ inputMode: 'dpad' });
  });
  afterEach(() => ctl.detach());

  function makeCard(id: string, x: number, y: number): HTMLElement {
    // A [data-nav] card with a nested kebab <button> inside it — like a poster.
    const card = document.createElement('div');
    card.id = id;
    card.setAttribute('data-nav', '1');
    card.getBoundingClientRect = (): DOMRect =>
      ({ left: x, top: y, width: 100, height: 150, right: x + 100, bottom: y + 150, x, y } as DOMRect);
    card.scrollIntoView = (): void => undefined;
    const kebab = document.createElement('button');
    kebab.className = 'kebab';
    kebab.getBoundingClientRect = (): DOMRect =>
      ({ left: x + 70, top: y, width: 24, height: 24, right: x + 94, bottom: y + 24, x: x + 70, y } as DOMRect);
    kebab.scrollIntoView = (): void => undefined;
    card.appendChild(kebab);
    return card;
  }

  it('focuses the CARD, not the kebab button nested inside it', () => {
    const a = makeCard('cardA', 0, 0);
    const b = makeCard('cardB', 120, 0);
    document.body.append(a, b);
    ctl.attach();
    press('ArrowRight'); // seed → first focusable
    expect(ctl.getCurrent()?.id).toBe('cardA'); // the card, not its kebab
    press('ArrowRight');
    expect(ctl.getCurrent()?.id).toBe('cardB');
    // The nested kebab is never an independent target.
    expect(ctl.getCurrent()?.tagName).toBe('DIV');
  });
});

describe('FocusNavController — Menu button opens the card kebab', () => {
  let ctl: FocusNavController;
  beforeEach(() => {
    document.body.innerHTML = '';
    ctl = new FocusNavController({ inputMode: 'dpad' });
  });
  afterEach(() => ctl.detach());

  // A card with a mock <watched-button> that opens/closes a [data-nav-menu]
  // portal on document.body, mirroring the real component's contract.
  function makeCardWithMenu(id: string, x: number): HTMLElement {
    const card = document.createElement('div');
    card.id = id;
    card.setAttribute('data-nav', '1');
    card.getBoundingClientRect = (): DOMRect =>
      ({ left: x, top: 0, width: 100, height: 150, right: x + 100, bottom: 150, x, y: 0 } as DOMRect);
    card.scrollIntoView = (): void => undefined;

    const wb = document.createElement('watched-button') as HTMLElement & {
      openMenu: () => void;
      closeMenu: () => void;
    };
    let portal: HTMLElement | null = null;
    wb.openMenu = (): void => {
      portal = document.createElement('div');
      portal!.setAttribute('data-nav-menu', '');
      ['Mark as watched', 'Re-probe'].forEach((label) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('data-nav', '1');
        b.getBoundingClientRect = (): DOMRect =>
          ({ left: 0, top: 0, width: 160, height: 30, right: 160, bottom: 30, x: 0, y: 0 } as DOMRect);
        b.scrollIntoView = (): void => undefined;
        portal!.appendChild(b);
      });
      document.body.appendChild(portal!);
    };
    wb.closeMenu = (): void => {
      portal?.remove();
      portal = null;
      wb.dispatchEvent(new CustomEvent('menu-closed', { bubbles: true, composed: true }));
    };
    card.appendChild(wb);
    return card;
  }

  function pressKey(init: KeyboardEventInit): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }

  it('Menu key opens the focused card menu and traps focus inside it', () => {
    const a = makeCardWithMenu('cardA', 0);
    document.body.append(a);
    ctl.attach();
    pressKey({ key: 'ArrowRight' }); // focus cardA
    expect(ctl.getCurrent()?.id).toBe('cardA');

    pressKey({ key: 'ContextMenu' }); // open menu
    expect(document.querySelector('[data-nav-menu]')).not.toBeNull();
    // Focus parked on the first menu item (after the open tick is synchronous in
    // this mock since setTimeout(0) — flush it).
  });

  it('Back closes the menu and restores focus to the card', async () => {
    const a = makeCardWithMenu('cardA', 0);
    document.body.append(a);
    ctl.attach();
    pressKey({ key: 'ArrowRight' });
    pressKey({ key: 'ContextMenu' });
    expect(document.querySelector('[data-nav-menu]')).not.toBeNull();

    pressKey({ key: 'Escape' }); // Back while menu open → close, not navigate
    expect(document.querySelector('[data-nav-menu]')).toBeNull();
    expect(ctl.getCurrent()?.id).toBe('cardA'); // focus restored to the card
  });

  it('while the menu is open, arrows stay within it (focus trap)', () => {
    const a = makeCardWithMenu('cardA', 0);
    const b = makeCardWithMenu('cardB', 120);
    document.body.append(a, b);
    ctl.attach();
    pressKey({ key: 'ArrowRight' }); // cardA
    pressKey({ key: 'ContextMenu' }); // open A's menu
    // ArrowDown should move between menu items, never to cardB.
    pressKey({ key: 'ArrowDown' });
    const cur = ctl.getCurrent();
    expect(cur?.closest('[data-nav-menu]')).not.toBeNull();
    expect(cur?.id).not.toBe('cardB');
  });
});

describe('FocusNavController — yields keys to the player (D2)', () => {
  let ctl: FocusNavController;
  beforeEach(() => {
    document.body.innerHTML = '';
    ctl = new FocusNavController({ inputMode: 'dpad' });
  });
  afterEach(() => ctl.detach());

  it('does not move focus while a <media-player> is mounted', () => {
    const a = makeTile('a', 0, 0);
    const b = makeTile('b', 120, 0);
    document.body.append(a, b);
    ctl.attach();
    press('ArrowRight'); // seeds focus on a (no player yet)
    expect(ctl.getCurrent()?.id).toBe('a');
    // Player takes over the screen.
    const player = document.createElement('media-player');
    document.body.appendChild(player);
    press('ArrowRight'); // player owns arrows → nav must NOT advance to b
    expect(ctl.getCurrent()?.id).toBe('a');
  });
});

describe('FocusNavController — activation + back', () => {
  let ctl: FocusNavController;
  beforeEach(() => {
    document.body.innerHTML = '';
    ctl = new FocusNavController({ inputMode: 'dpad' });
  });
  afterEach(() => ctl.detach());

  it('Enter dispatches the same activation as a click', () => {
    const a = makeTile('a', 0, 0);
    const clicked = vi.fn();
    a.addEventListener('click', clicked);
    document.body.append(a);
    ctl.attach();
    press('ArrowRight'); // focus a
    press('Enter');
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
