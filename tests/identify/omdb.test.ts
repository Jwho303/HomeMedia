import { describe, it, expect, vi } from 'vitest';
import {
  createOmdbSource,
  createOmdbRatingFetcher,
  parseImdbRating,
} from '../../src/identify/sources/omdb.js';
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

// 0.1.8 — IMDb rating extraction. OMDb gives us the canonical /10 number
// the same audience sees on imdb.com (TMDB's vote_average is its own
// community score and runs ~0.5 higher; we don't use it for the pill).
describe('parseImdbRating', () => {
  it('extracts rating + comma-stripped vote count from a populated record', () => {
    expect(parseImdbRating({ imdbRating: '7.8', imdbVotes: '1,234,567' }))
      .toEqual({ rating: 7.8, votes: 1234567 });
  });

  it('returns null when imdbRating is "N/A" (OMDb-speak for missing)', () => {
    expect(parseImdbRating({ imdbRating: 'N/A', imdbVotes: 'N/A' })).toBeNull();
  });

  it('returns null when imdbRating is missing entirely', () => {
    expect(parseImdbRating({})).toBeNull();
  });

  it('returns the rating with null votes when imdbVotes is N/A but rating is present', () => {
    expect(parseImdbRating({ imdbRating: '6.4', imdbVotes: 'N/A' }))
      .toEqual({ rating: 6.4, votes: null });
  });

  it('rejects out-of-range ratings (defensive — OMDb shouldn\'t emit these)', () => {
    expect(parseImdbRating({ imdbRating: '12.0' })).toBeNull();
    expect(parseImdbRating({ imdbRating: '-1.5' })).toBeNull();
    expect(parseImdbRating({ imdbRating: '0' })).toBeNull();
  });

  it('rejects malformed votes but preserves the rating', () => {
    expect(parseImdbRating({ imdbRating: '8.1', imdbVotes: 'not a number' }))
      .toEqual({ rating: 8.1, votes: null });
  });
});

describe('createOmdbRatingFetcher', () => {
  it('returns null for non-tt prefixed ids without spending budget', async () => {
    const { fn, calls } = fakeRequest([{ Response: 'False', Error: 'Movie not found!' }]);
    const budget = createMemoryBudgetTracker(10);
    const f = createOmdbRatingFetcher({
      apiKey: 'k', budget, fetch: fn as never, throttle: passthroughThrottle,
    });
    expect(await f.fetchRating('not-an-imdb-id')).toBeNull();
    expect(calls).toEqual([]);  // never reached the network
  });

  it('returns the parsed rating + votes on a hit', async () => {
    const { fn } = fakeRequest([
      { Response: 'True', Title: 'Dune', imdbRating: '8.0', imdbVotes: '900,000' },
    ]);
    const f = createOmdbRatingFetcher({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(10),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    expect(await f.fetchRating('tt1160419')).toEqual({ rating: 8.0, votes: 900000 });
  });

  it('returns null when OMDb says the title isn\'t found', async () => {
    const { fn } = fakeRequest([{ Response: 'False', Error: 'Movie not found!' }]);
    const f = createOmdbRatingFetcher({
      apiKey: 'k',
      budget: createMemoryBudgetTracker(10),
      fetch: fn as never,
      throttle: passthroughThrottle,
    });
    expect(await f.fetchRating('tt0000000')).toBeNull();
  });

  it('returns null and stops calling when the budget is exhausted', async () => {
    const { fn, calls } = fakeRequest([{ Response: 'True', imdbRating: '8.0' }]);
    const budget = createMemoryBudgetTracker(1);   // limit = 0
    const f = createOmdbRatingFetcher({
      apiKey: 'k', budget, fetch: fn as never, throttle: passthroughThrottle,
    });
    expect(await f.fetchRating('tt1234567')).toBeNull();
    expect(calls).toEqual([]);
  });
});
