import { describe, it, expect, vi } from 'vitest';
import { createOmdbSource } from '../../src/identify/sources/omdb.js';
import { createMemoryBudgetTracker } from '../../src/identify/budget.js';

function fakeRequest(responses: Array<unknown>) {
  let i = 0;
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const body = responses[i++ % responses.length];
    return {
      statusCode: 200,
      body: {
        json: async () => body,
        text: async () => JSON.stringify(body),
      },
    } as never;
  });
  return { fn, calls };
}

const passthroughThrottle = <Args extends unknown[], R>(fn: (...a: Args) => Promise<R>) => fn;

describe('OmdbSource', () => {
  it('search returns SourceResult[] with imdbId populated', async () => {
    const search = {
      Response: 'True',
      Search: [
        { Title: 'The Lord of the Rings: The Two Towers', Year: '2002', imdbID: 'tt0167261', Type: 'movie' },
      ],
    };
    const full = {
      Response: 'True',
      Title: 'The Lord of the Rings: The Two Towers',
      Year: '2002',
      Type: 'movie',
      imdbID: 'tt0167261',
      Plot: 'A short plot.',
      Poster: 'https://example.com/poster.jpg',
    };
    const { fn } = fakeRequest([search, full]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const results = await source.search('two towers theatrical', 2002, 'movie');
    expect(results).toHaveLength(1);
    expect(results[0]!.imdbId).toBe('tt0167261');
    expect(results[0]!.title).toContain('Two Towers');
    expect(results[0]!.year).toBe(2002);
    expect(results[0]!.type).toBe('movie');
  });

  it('byImdbId returns a normalized SourceResult', async () => {
    const full = {
      Response: 'True',
      Title: 'The Lord of the Rings: The Two Towers',
      Year: '2002',
      Type: 'movie',
      imdbID: 'tt0167261',
      Plot: 'Short plot.',
      Poster: 'https://example.com/poster.jpg',
    };
    const { fn } = fakeRequest([full]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const r = await source.byImdbId!('tt0167261');
    expect(r).not.toBeNull();
    expect(r!.imdbId).toBe('tt0167261');
    expect(r!.year).toBe(2002);
    expect(r!.type).toBe('movie');
    expect(r!.posterPath).toBe('https://example.com/poster.jpg');
  });

  it('byImdbId returns null on Response=False', async () => {
    const { fn } = fakeRequest([{ Response: 'False', Error: 'Incorrect IMDb ID.' }]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const r = await source.byImdbId!('tt9999999');
    expect(r).toBeNull();
  });

  it('handles series Year ranges like "2003–"', async () => {
    const full = {
      Response: 'True',
      Title: 'It\'s Always Sunny in Philadelphia',
      Year: '2005–',
      Type: 'series',
      imdbID: 'tt0472954',
      Plot: 'p',
      Poster: 'N/A',
    };
    const { fn } = fakeRequest([full]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const r = await source.byImdbId!('tt0472954');
    expect(r!.year).toBe(2005);
    expect(r!.type).toBe('tv');
    expect(r!.posterPath).toBeNull();   // 'N/A' → null
  });

  it('returns empty array when budget exhausted; logs no error', async () => {
    const budget = createMemoryBudgetTracker(0);  // limit = 0
    const { fn } = fakeRequest([]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget,
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    const results = await source.search('foo');
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('search returns [] when OMDb returns Response=False (no matches)', async () => {
    const { fn } = fakeRequest([{ Response: 'False', Error: 'Movie not found!' }]);
    const source = createOmdbSource({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(1000),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    expect(await source.search('nothing here')).toEqual([]);
  });
});

describe('budget tracker', () => {
  it('memory tracker rejects past the soft cap', () => {
    const b = createMemoryBudgetTracker(10);    // limit = 9
    for (let i = 0; i < 9; i++) {
      expect(b.allow()).toBe(true);
      b.consume();
    }
    expect(b.allow()).toBe(false);
  });
});
