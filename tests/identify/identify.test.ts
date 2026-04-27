import { describe, it, expect, vi } from 'vitest';
import { identify } from '../../src/identify/identify.js';
import { pathContext } from '../../src/identify/hypotheses.js';
import type { Source } from '../../src/identify/sources.js';
import type { SourceResult } from '../../src/identify/types.js';

const m = (id: number, title: string, year: number | null): SourceResult => ({
  id, type: 'movie', title, year, posterPath: null, backdropPath: null, overview: null,
});
const tv = (id: number, title: string, year: number | null): SourceResult => ({
  id, type: 'tv', title, year, posterPath: null, backdropPath: null, overview: null,
});

function fakeSource(handler: (title: string, year?: number) => SourceResult[]): { source: Source; calls: number } {
  let calls = 0;
  const source: Source = {
    name: 'fake',
    async search(title, year) {
      calls++;
      return handler(title, year);
    },
  };
  return {
    source,
    get calls() {
      return calls;
    },
  } as { source: Source; calls: number };
}

describe('identify orchestrator', () => {
  it('identifies a clean filename in a single TMDB call (early-bail)', async () => {
    const search = vi.fn(async (_q: string, _y?: number) => [m(438631, 'Dune', 2021)]);
    const source: Source = { name: 'tmdb', search };
    const rel = 'Dune.2021.1080p.BluRay.x264.YIFY.mkv';
    const r = await identify(rel, pathContext(rel), source);
    expect(r.winner).not.toBeNull();
    expect(r.winner!.tmdb.id).toBe(438631);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('Minority Report (2002).mp4 — picks the 2002 movie despite tv ranked higher', async () => {
    const search = vi.fn(async (_q: string, _y?: number) => [
      tv(63175, 'Minority Report', 2015),
      m(180, 'Minority Report', 2002),
    ]);
    const source: Source = { name: 'tmdb', search };
    const rel = 'Minority Report (2002).mp4';
    const r = await identify(rel, pathContext(rel), source);
    expect(r.winner).not.toBeNull();
    expect(r.winner!.tmdb.id).toBe(180);
    expect(r.winner!.score).toBeGreaterThanOrEqual(0.85);
  });

  it('returns no_results when TMDB returns nothing for any hypothesis', async () => {
    const search = vi.fn(async () => [] as SourceResult[]);
    const source: Source = { name: 'tmdb', search };
    const rel = 'something.nobody.knows.mkv';
    const r = await identify(rel, pathContext(rel), source);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('no_results');
  });

  it('returns ambiguous when two near-tied candidates appear', async () => {
    // Two same-titled movies with the same year (unrealistic, but a clean test).
    const search = vi.fn(async () => [
      m(1, 'Foo', 2010),
      m(2, 'Foo', 2010),
    ]);
    const source: Source = { name: 'tmdb', search };
    const rel = 'Foo.2010.mkv';
    const r = await identify(rel, pathContext(rel), source);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('ambiguous');
  });

  it('returns tmdb_error when search throws on every hypothesis', async () => {
    const search = vi.fn(async () => { throw new Error('boom'); });
    const source: Source = { name: 'tmdb', search };
    const rel = 'Dune.2021.mkv';
    const r = await identify(rel, pathContext(rel), source);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('tmdb_error');
  });

  it('aggressive mode evaluates all hypotheses (no early-bail)', async () => {
    const search = vi.fn(async (_q: string) => [m(438631, 'Dune', 2021)]);
    const source: Source = { name: 'tmdb', search };
    const rel = 'Dune.2021.1080p.BluRay.mkv';
    await identify(rel, pathContext(rel), source, { aggressive: true });
    // Without early-bail, every (deduped) hypothesis triggers a TMDB call.
    expect(search.mock.calls.length).toBeGreaterThan(1);
  });

  it('messy filename falls through hypotheses until something matches', async () => {
    // Cleaned-prefix yields "phila 402" → no results. PTT basename → no results.
    // Normalized → still no results. We end up with no_results, NOT a wrong guess.
    const search = vi.fn(async (q: string) => {
      if (/philadelphia/i.test(q)) return [tv(2710, "It's Always Sunny in Philadelphia", 2005)];
      return [];
    });
    const source: Source = { name: 'tmdb', search };
    const rel = 'A Show/Season 4/its.always.sunny.in.phila.402.dsr.xvid.notv.avi';
    const r = await identify(rel, pathContext(rel), source);
    // Whatever happens, we should NOT have returned a high-confidence winner here.
    if (r.winner) {
      expect(r.winner.score).toBeLessThan(1.0);
    } else {
      expect(['low_score', 'no_results', 'ambiguous']).toContain(r.reason!.reason);
    }
  });
});
