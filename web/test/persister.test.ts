import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackPersister } from '../src/components/media-player.js';

function mockOk(): Response {
  return new Response(JSON.stringify({ position: 0, duration: 0, watched: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PlaybackPersister', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throttles writes to once per 10s', async () => {
    let now = 1000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockOk());
    const p = new PlaybackPersister('a.mkv', () => now);

    p.maybeWrite(1, 100); // first write
    p.maybeWrite(2, 100); // throttled
    p.maybeWrite(3, 100); // throttled
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 9_000;
    p.maybeWrite(10, 100); // still throttled
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 2_000; // total 11s elapsed
    p.maybeWrite(15, 100); // allowed
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('flushNow always writes', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockOk());
    const p = new PlaybackPersister('a.mkv');
    p.flushNow(50, 100);
    p.flushNow(60, 100);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fireWatched sends watched:true', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockOk());
    const p = new PlaybackPersister('a.mkv');
    p.fireWatched(95, 100);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ position: 95, duration: 100, watched: true });
  });
});
