import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/components/share-banner.js';
import type { ShareBanner } from '../src/components/share-banner.js';
import {
  getConnectionState,
  __resetConnectionStoreForTests,
} from '../src/connection-store.js';

async function tick(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function drainMicrotasks(): Promise<void> {
  // Two awaits drain the await chain inside <share-banner>.poll(): one for
  // the fetch promise, one for the .finally → scheduleNext sequence.
  await Promise.resolve();
  await Promise.resolve();
}

function mockOnlineResponse(online = true): Response {
  return new Response(
    JSON.stringify({ online, mountPath: '/m', lastSeen: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function mount(): Promise<ShareBanner> {
  const el = document.createElement('share-banner') as ShareBanner;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('<share-banner> adaptive polling (0.1.7 / 0.1.11)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    __resetConnectionStoreForTests();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately on mount', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await tick(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/share/status', undefined);
  });

  it('schedules the next poll at 30s when online', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 29s in: still no second poll.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 30s in: second poll fires.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('tightens to 5s when share is offline (server still reachable)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(false));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not fire while document.hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fires an immediate poll on visibilitychange→visible', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fires an immediate poll on window "online" event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('<share-banner> unreachable cadence (0.1.11)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    __resetConnectionStoreForTests();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on first failure, transitions to unreachable+active and polls at 3s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const state = getConnectionState();
    expect(state?.kind).toBe('unreachable');
    if (state?.kind === 'unreachable') {
      expect(state.phase).toBe('active');
    }

    // 2.999s — no second poll yet.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 3s — second poll fires.
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('flips to 10s polling after 30s of unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    // First failed poll; subsequent polls fire at 3s intervals.
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    // Advance through 30s of fast (3s) polling. Polls 2..11 fire at 3,6,...,30s.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(3_000);
      await drainMicrotasks();
    }
    // 11 polls total at this point (mount + 10 fast retries through 30s).
    expect(fetchSpy).toHaveBeenCalledTimes(11);

    // Next interval should now be 10s, not 3s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchSpy).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(12);
  });

  it('flips to idle (stops polling) after 150s of unreachable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    const initial = fetchSpy.mock.calls.length;

    // Fast-forward enough to cross 150s; bump in chunks larger than 10s so
    // the slow-phase scheduling lines up regardless of exact spacing.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();
    }
    // Confirm we're idle.
    const state = getConnectionState();
    expect(state?.kind).toBe('unreachable');
    if (state?.kind === 'unreachable') {
      expect(state.phase).toBe('idle');
    }
    const beforeQuietWindow = fetchSpy.mock.calls.length;
    expect(beforeQuietWindow).toBeGreaterThan(initial);

    // Now confirm polling has actually stopped: 5 minutes go by with no
    // additional fetches.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchSpy.mock.calls.length).toBe(beforeQuietWindow);
  });

  it('mousemove wakes from idle and fires one immediate poll (debounced)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    // Drive into idle.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();
    }
    const beforeWake = fetchSpy.mock.calls.length;
    expect(getConnectionState()?.kind).toBe('unreachable');

    // Fire many mousemove events; only the first should poll.
    for (let i = 0; i < 50; i++) {
      document.dispatchEvent(new MouseEvent('mousemove'));
    }
    await drainMicrotasks();
    expect(fetchSpy.mock.calls.length).toBe(beforeWake + 1);

    // State should be back to active with a fresh `since`.
    const state = getConnectionState();
    expect(state?.kind).toBe('unreachable');
    if (state?.kind === 'unreachable') {
      expect(state.phase).toBe('active');
    }
  });

  it('keydown wakes from idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();
    }
    const beforeWake = fetchSpy.mock.calls.length;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await drainMicrotasks();
    expect(fetchSpy.mock.calls.length).toBe(beforeWake + 1);
  });

  it('activity events when reachable are no-ops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOnlineResponse(true));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new MouseEvent('mousemove'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    document.dispatchEvent(new PointerEvent('pointerdown'));
    await drainMicrotasks();
    // No additional fetches — we were reachable.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('successful poll after unreachable transitions to reachable and dispatches library-invalidated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchSpy.mockResolvedValue(mockOnlineResponse(true));

    const invalidateSpy = vi.fn();
    document.addEventListener('library-invalidated', invalidateSpy);

    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(getConnectionState()?.kind).toBe('unreachable');
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Next poll at 3s succeeds.
    await vi.advanceTimersByTimeAsync(3_000);
    await drainMicrotasks();
    expect(getConnectionState()?.kind).toBe('reachable');
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    document.removeEventListener('library-invalidated', invalidateSpy);
  });

  it('connection-retry-requested event fires an immediate poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    const before = fetchSpy.mock.calls.length;

    document.dispatchEvent(new CustomEvent('connection-retry-requested'));
    await drainMicrotasks();
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
  });
});
