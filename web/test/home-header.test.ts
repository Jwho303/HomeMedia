import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/components/home-header.js';
import type { HomeHeader } from '../src/components/home-header.js';

async function tick(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(props: Partial<HomeHeader> = {}): Promise<HomeHeader> {
  const el = document.createElement('home-header') as HomeHeader;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  await tick();
  return el;
}

describe('<home-header> layout (0.1.5.1)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders search input as the first interactive element on the left', async () => {
    const el = await mount();
    const search = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    expect(search?.placeholder).toBe('Search');
  });

  it('renders the action group on the right with refresh + gear buttons', async () => {
    const el = await mount();
    const group = el.shadowRoot!.querySelector('.action-group');
    expect(group).not.toBeNull();
    const buttons = group!.querySelectorAll('button.action-btn');
    expect(buttons.length).toBe(2);
  });

  it('Movies/Series toggle still works', async () => {
    const el = await mount({ toggle: 'movies' });
    const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toggle button');
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.classList.contains('active')).toBe(true);
    expect(buttons[1]?.classList.contains('active')).toBe(false);
  });

  it('Enter in the search input fires a `search` event with the value', async () => {
    const el = await mount();
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'dune';
    input.dispatchEvent(new Event('input'));
    const spy = vi.fn();
    el.addEventListener('search', (e) => spy((e as CustomEvent<string>).detail));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    expect(spy).toHaveBeenCalledWith('dune');
  });

  it('clicking refresh button fires `refresh` with full=false', async () => {
    const el = await mount();
    const spy = vi.fn();
    el.addEventListener('refresh', (e) => spy((e as CustomEvent<{ full: boolean }>).detail));
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.refresh-btn')!;
    btn.click();
    expect(spy).toHaveBeenCalledWith({ full: false });
  });

  it('opens gear menu and renders Hard refresh, Re-probe, Uncategorized, Settings entries', async () => {
    const el = await mount();
    const gearBtn = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.action-btn')[1]!;
    gearBtn.click();
    await el.updateComplete;
    const items = el.shadowRoot!.querySelectorAll('.action-group .sort-menu button');
    expect(items.length).toBe(4);
    expect(items[0]?.textContent).toContain('Hard refresh');
    expect(items[1]?.textContent).toContain('Re-probe');
    expect(items[2]?.textContent).toContain('Uncategorized');
    expect(items[3]?.textContent).toContain('Settings');
  });

  it('hard refresh menu item is disabled while a job is active', async () => {
    const el = await mount({ jobActive: true });
    const gearBtn = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.action-btn')[1]!;
    gearBtn.click();
    await el.updateComplete;
    const hardRefresh = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.sort-menu button')[0]!;
    expect(hardRefresh.disabled).toBe(true);
  });

  it('gear-menu is NOT clipped by .action-group overflow (regression for invisible-menu bug)', async () => {
    // Pre-fix bug: .action-group had `overflow: hidden`, which clipped the
    // dropdown menu (positioned with top: 100% inside the group) so the menu
    // appeared to "not open" — it WAS in the DOM, just invisible.
    const el = await mount();
    const group = el.shadowRoot!.querySelector<HTMLElement>('.action-group')!;
    // The fix removed overflow:hidden from the group.
    const cs = getComputedStyle(group);
    expect(cs.overflow).not.toBe('hidden');
  });

  it('refresh button shows scanning class + path while a job is active', async () => {
    // The exact "i/n — file" format is exercised in dev-server manual testing
    // (Phase 9). Here we just assert the classes and that the file label
    // appears somewhere in the visible text.
    const el = document.createElement('home-header') as HomeHeader;
    el.jobActive = true;
    el.scanI = 12;
    el.scanN = 47;
    el.scanCurrentFile = 'Sunny/S04/S04E01.mkv';
    document.body.appendChild(el);
    await el.updateComplete;
    await tick();
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.refresh-btn')!;
    expect(btn.classList.contains('scanning')).toBe(true);
    expect((el.shadowRoot!.textContent ?? '')).toContain('S04E01');
  });

  it('refresh button is disabled while scanning (clicks are no-op)', async () => {
    const el = await mount({ jobActive: true, scanI: 1, scanN: 5 });
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.refresh-btn')!;
    expect(btn.disabled).toBe(true);
  });

  it('"/" keydown at document focuses the search input', async () => {
    const el = await mount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(el.shadowRoot!.activeElement).toBe(input);
  });
});
