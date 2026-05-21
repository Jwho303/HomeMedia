import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/components/reconnect-overlay.js';
import type { ReconnectOverlay } from '../src/components/reconnect-overlay.js';
import {
  setConnectionState,
  __resetConnectionStoreForTests,
} from '../src/connection-store.js';

async function mount(): Promise<ReconnectOverlay> {
  const el = document.createElement('reconnect-overlay') as ReconnectOverlay;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function queryScrim(el: ReconnectOverlay): HTMLElement | null {
  return el.renderRoot.querySelector('.scrim');
}

function queryTitle(el: ReconnectOverlay): string {
  return el.renderRoot.querySelector('#rc-title')?.textContent?.trim() ?? '';
}

function queryElapsed(el: ReconnectOverlay): string {
  return el.renderRoot.querySelector('.elapsed')?.textContent?.trim() ?? '';
}

describe('<reconnect-overlay> (0.1.11)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetConnectionStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when state is null', async () => {
    const el = await mount();
    expect(queryScrim(el)).toBeNull();
  });

  it('renders nothing when reachable (any share status)', async () => {
    const el = await mount();
    setConnectionState({
      kind: 'reachable',
      status: { online: true, mountPath: '/m', lastSeen: 1 },
    });
    await el.updateComplete;
    expect(queryScrim(el)).toBeNull();

    setConnectionState({
      kind: 'reachable',
      status: { online: false, mountPath: '/m', lastSeen: 1 },
    });
    await el.updateComplete;
    expect(queryScrim(el)).toBeNull();
  });

  it('renders scrim + active card when unreachable+active', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    setConnectionState({ kind: 'unreachable', phase: 'active', since: Date.now() });
    await el.updateComplete;
    const scrim = queryScrim(el);
    expect(scrim).not.toBeNull();
    expect(scrim?.getAttribute('role')).toBe('alertdialog');
    expect(scrim?.getAttribute('aria-modal')).toBe('true');
    expect(queryTitle(el)).toBe('Reconnecting to server');
    // Elapsed copy mentions the 3s interval for the fast window.
    expect(queryElapsed(el)).toContain('Trying every 3s');
    expect(queryElapsed(el)).toContain('0s');
    // Dots not paused while active.
    const dots = el.renderRoot.querySelector('.dots');
    expect(dots?.classList.contains('paused')).toBe(false);
  });

  it('shows 10s cadence in the copy after 30s elapsed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    const t0 = Date.now();
    setConnectionState({ kind: 'unreachable', phase: 'active', since: t0 });
    await el.updateComplete;

    // Advance 35s — interval timer ticks, `now` updates, copy should flip.
    await vi.advanceTimersByTimeAsync(35_000);
    await el.updateComplete;
    expect(queryElapsed(el)).toContain('Trying every 10s');
    expect(queryElapsed(el)).toContain('35s');
  });

  it('renders idle card with paused dots and frozen counter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    const t0 = Date.now();
    setConnectionState({ kind: 'unreachable', phase: 'idle', since: t0 - 200_000 });
    await el.updateComplete;
    expect(queryTitle(el)).toBe('Server still unreachable');
    expect(queryElapsed(el)).toContain('Stopped trying');
    expect(queryElapsed(el)).toContain('200s');
    const dots = el.renderRoot.querySelector('.dots');
    expect(dots?.classList.contains('paused')).toBe(true);

    // Advance time — idle counter should NOT change (no tick timer running).
    await vi.advanceTimersByTimeAsync(60_000);
    await el.updateComplete;
    // Counter still says 200s — we didn't bump `now` because the tick timer
    // is inactive in idle.
    expect(queryElapsed(el)).toContain('200s');
  });

  it('Retry now button dispatches connection-retry-requested', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    setConnectionState({ kind: 'unreachable', phase: 'active', since: Date.now() });
    await el.updateComplete;
    const spy = vi.fn();
    document.addEventListener('connection-retry-requested', spy);
    const btn = el.renderRoot.querySelector<HTMLButtonElement>('button.retry');
    btn?.click();
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('connection-retry-requested', spy);
  });

  it('Retry button is available in idle too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    setConnectionState({ kind: 'unreachable', phase: 'idle', since: Date.now() - 200_000 });
    await el.updateComplete;
    const spy = vi.fn();
    document.addEventListener('connection-retry-requested', spy);
    const btn = el.renderRoot.querySelector<HTMLButtonElement>('button.retry');
    btn?.click();
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('connection-retry-requested', spy);
  });

  it('returns to empty render on reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount();
    setConnectionState({ kind: 'unreachable', phase: 'active', since: Date.now() });
    await el.updateComplete;
    expect(queryScrim(el)).not.toBeNull();
    setConnectionState({
      kind: 'reachable',
      status: { online: true, mountPath: '/m', lastSeen: 1 },
    });
    await el.updateComplete;
    expect(queryScrim(el)).toBeNull();
  });
});
