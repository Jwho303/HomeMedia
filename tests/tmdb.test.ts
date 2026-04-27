import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-tmdb-test');

const requestMock = vi.fn(async (_url: string, _opts?: unknown): Promise<{
  statusCode: number;
  body: { json: () => Promise<unknown>; text: () => Promise<string> };
}> => ({
  statusCode: 200,
  body: {
    json: async () => ({ page: 1, results: [], total_results: 0 }),
    text: async () => '',
  },
}));

vi.mock('undici', () => ({
  request: requestMock,
}));

const tmdb = await import('../src/tmdb.js');

describe('tmdb client', () => {
  beforeEach(() => {
    requestMock.mockClear();
  });

  it('searchMulti hits /search/multi with query, year, and api_key', async () => {
    await tmdb.searchMulti('Dune', 2021);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const url = String(requestMock.mock.calls[0]![0]);
    expect(url).toContain('/search/multi');
    expect(url).toContain('query=Dune');
    expect(url).toContain('year=2021');
    expect(url).toContain('api_key=test-key');
  });

  it('getMovie hits /movie/:id', async () => {
    await tmdb.getMovie(438631);
    const url = String(requestMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/movie\/438631\?/);
  });

  it('throttle holds the rate at 3 requests/second under burst load (fake clock)', async () => {
    // Fake timers remove real-world jitter so the windowed throttle behavior is deterministic.
    vi.useFakeTimers();
    try {
      const startTimes: number[] = [];
      requestMock.mockImplementation(async () => {
        startTimes.push(Date.now());
        return {
          statusCode: 200,
          body: { json: async () => ({}), text: async () => '' },
        } as any;
      });

      const all = Promise.all(
        Array.from({ length: 12 }, (_, i) => tmdb.searchMulti(`q${i}`)),
      );
      // Advance the virtual clock through the throttle's queued waits.
      await vi.advanceTimersByTimeAsync(5000);
      await all;

      expect(startTimes).toHaveLength(12);

      // No more than 3 calls in any 1-second window starting at any call's timestamp.
      for (let i = 0; i < startTimes.length; i++) {
        const windowStart = startTimes[i]!;
        const inWindow = startTimes.filter((t) => t >= windowStart && t < windowStart + 1000).length;
        expect(inWindow, `window starting at ${windowStart}ms had ${inWindow} calls`).toBeLessThanOrEqual(3);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on non-2xx', async () => {
    requestMock.mockImplementationOnce(async () => ({
      statusCode: 401,
      body: { json: async () => ({}), text: async () => '{"status_message":"unauthorized"}' },
    } as any));
    await expect(tmdb.searchMulti('x')).rejects.toThrow(/TMDB 401/);
  });
});
