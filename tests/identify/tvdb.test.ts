import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createTvdbSource } from '../../src/identify/sources/tvdb.js';
import { createMemoryBudgetTracker } from '../../src/identify/budget.js';

interface FakeResponse {
  status?: number;
  body: unknown;
}

function fakeFetch(handlers: Array<(url: string, init?: { method?: string | undefined; headers?: Record<string, string>; body?: string }) => FakeResponse>) {
  const calls: Array<{ url: string; method?: string | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: { method?: string | undefined; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method });
    const handler = handlers[i++];
    if (!handler) throw new Error(`fakeFetch out of handlers (call #${i}, url=${url})`);
    const r = handler(url, init);
    return {
      statusCode: r.status ?? 200,
      body: {
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      },
    } as never;
  });
  return { fn, calls };
}

const passthroughThrottle = <Args extends unknown[], R>(fn: (...a: Args) => Promise<R>) => fn;

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'tvdb-'));
});

describe('TvdbSource', () => {
  it('login: POSTs to /login, caches token in memory + on disk, reuses it', async () => {
    const { fn, calls } = fakeFetch([
      // 1: login
      () => ({ body: { data: { token: 'TOKEN-1' } } }),
      // 2: search call
      () => ({ body: { data: [{ tvdb_id: 75805, name: 'It\'s Always Sunny in Philadelphia', type: 'series', year: '2005', remote_ids: [{ id: 'tt0472954', sourceName: 'IMDB' }] }] } }),
      // 3: second search call (should reuse cached token)
      () => ({ body: { data: [] } }),
    ]);

    const tokenPath = path.join(tempDir, 'tvdb-token.json');
    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      tokenPath,
      fetch: fn as never,
      throttle: passthroughThrottle,
    });

    const r1 = await source.search('sunny', undefined, 'tv');
    expect(r1).toHaveLength(1);
    expect(r1[0]!.tvdbId).toBe(75805);
    expect(r1[0]!.imdbId).toBe('tt0472954');
    expect(existsSync(tokenPath)).toBe(true);
    expect(JSON.parse(readFileSync(tokenPath, 'utf8')).value).toBe('TOKEN-1');

    await source.search('something else', undefined, 'tv');
    // login should have been called exactly once.
    const loginCalls = calls.filter((c) => c.url.endsWith('/login') && c.method === 'POST');
    expect(loginCalls).toHaveLength(1);
  });

  it('reads token from disk on cold start (skips login)', async () => {
    const tokenPath = path.join(tempDir, 'tvdb-token.json');
    // Pre-seed disk.
    require('node:fs').writeFileSync(
      tokenPath,
      JSON.stringify({ value: 'PRE-EXISTING', obtainedAt: Date.now() - 24 * 60 * 60 * 1000 }),
    );
    const { fn, calls } = fakeFetch([
      // search response — no login expected.
      () => ({ body: { data: [{ tvdb_id: 1, name: 'Foo', type: 'series', year: '2020' }] } }),
    ]);

    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      tokenPath,
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    await source.search('foo', undefined, 'tv');
    expect(calls.some((c) => c.url.endsWith('/login'))).toBe(false);
  });

  it('on 401: re-logs in, retries the original request once', async () => {
    const { fn } = fakeFetch([
      // 1: login
      () => ({ body: { data: { token: 'OLD' } } }),
      // 2: search → 401
      () => ({ status: 401, body: {} }),
      // 3: re-login
      () => ({ body: { data: { token: 'NEW' } } }),
      // 4: retry of search → success
      () => ({ body: { data: [{ tvdb_id: 9, name: 'Doctor Who', type: 'series', year: '2005' }] } }),
    ]);
    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      tokenPath: path.join(tempDir, 'tvdb-token.json'),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const r = await source.search('Doctor Who', undefined, 'tv');
    expect(r).toHaveLength(1);
    expect(r[0]!.tvdbId).toBe(9);
  });

  it('byImdbId returns the resolved series record', async () => {
    const { fn } = fakeFetch([
      () => ({ body: { data: { token: 'T' } } }),
      () => ({
        body: {
          data: [
            {
              series: {
                tvdb_id: 78804,
                name: 'Doctor Who',
                type: 'series',
                year: '2005',
                remote_ids: [{ id: 'tt0436992', sourceName: 'IMDB' }],
              },
            },
          ],
        },
      }),
    ]);
    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      tokenPath: path.join(tempDir, 'tvdb-token.json'),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const r = await source.byImdbId!('tt0436992');
    expect(r).not.toBeNull();
    expect(r!.tvdbId).toBe(78804);
    expect(r!.imdbId).toBe('tt0436992');
    expect(r!.type).toBe('tv');
  });

  it('returns empty when budget exhausted; no fetches issued', async () => {
    const { fn } = fakeFetch([]);
    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(0),
      tokenPath: path.join(tempDir, 'tvdb-token.json'),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    expect(await source.search('foo', undefined, 'tv')).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('forces re-login when cached disk token has expired (TTL margin)', async () => {
    const tokenPath = path.join(tempDir, 'tvdb-token.json');
    require('node:fs').writeFileSync(
      tokenPath,
      // 30 days ago — past our 25d TTL margin.
      JSON.stringify({ value: 'STALE', obtainedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }),
    );
    const { fn, calls } = fakeFetch([
      () => ({ body: { data: { token: 'FRESH' } } }),
      () => ({ body: { data: [] } }),
    ]);
    const source = createTvdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      tokenPath,
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    await source.search('foo', undefined, 'tv');
    expect(calls[0]!.url.endsWith('/login')).toBe(true);
  });
});
