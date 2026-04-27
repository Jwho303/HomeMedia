import { describe, it, expect } from 'vitest';
import '../src/components/player-popover.js';
import type { PlayerPopover } from '../src/components/player-popover.js';

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('<player-popover>', () => {
  it('renders panel without [data-open] when closed', async () => {
    const el = document.createElement('player-popover') as PlayerPopover;
    document.body.appendChild(el);
    await tick();
    const panel = el.shadowRoot!.querySelector('.panel');
    expect(panel).toBeTruthy();
    expect(panel!.hasAttribute('data-open')).toBe(false);
    document.body.removeChild(el);
  });

  it('flips [data-open] on the panel when `open` toggles', async () => {
    const el = document.createElement('player-popover') as PlayerPopover;
    document.body.appendChild(el);
    el.open = true;
    await el.updateComplete;
    let panel = el.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.hasAttribute('data-open')).toBe(true);
    el.open = false;
    await el.updateComplete;
    panel = el.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.hasAttribute('data-open')).toBe(false);
    document.body.removeChild(el);
  });

  it('reflects width and notchRightPx into inline styles', async () => {
    const el = document.createElement('player-popover') as PlayerPopover;
    el.width = 348;
    el.notchRightPx = 22;
    document.body.appendChild(el);
    await el.updateComplete;
    const panel = el.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.getAttribute('style')).toContain('width:348px');
    const notch = el.shadowRoot!.querySelector('.notch') as HTMLElement;
    expect(notch.getAttribute('style')).toContain('right:22px');
    document.body.removeChild(el);
  });

  it('default slot exposes children for projection', async () => {
    const el = document.createElement('player-popover') as PlayerPopover;
    const child = document.createElement('div');
    child.textContent = 'menu item';
    el.appendChild(child);
    document.body.appendChild(el);
    await el.updateComplete;
    const slot = el.shadowRoot!.querySelector('slot');
    expect(slot).toBeTruthy();
    const assigned = (slot as HTMLSlotElement).assignedNodes();
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.textContent).toBe('menu item');
    document.body.removeChild(el);
  });

  it('reflects the `open` attribute when set via property', async () => {
    const el = document.createElement('player-popover') as PlayerPopover;
    document.body.appendChild(el);
    el.open = true;
    await el.updateComplete;
    expect(el.hasAttribute('open')).toBe(true);
    el.open = false;
    await el.updateComplete;
    expect(el.hasAttribute('open')).toBe(false);
    document.body.removeChild(el);
  });
});
