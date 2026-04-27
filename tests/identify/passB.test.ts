import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { passBIdentify, looksLikeSeries } from '../../src/identify/passB.js';
import { pathContext } from '../../src/identify/hypotheses.js';
import type { Source } from '../../src/identify/sources.js';
import type { SourceResult } from '../../src/identify/types.js';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-passb-test');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

function mockSource(name: string, handler: (title: string) => SourceResult[], byImdb?: (id: string) => SourceResult | null): Source {
  return {
    name,
    async search(title) { return handler(title); },
    async byImdbId(id) { return byImdb ? byImdb(id) : null; },
  };
}

const movie = (id: number, title: string, year: number, imdbId?: string): SourceResult => ({
  id,
  tmdbId: id,
  imdbId,
  type: 'movie',
  title,
  year,
  posterPath: null,
  backdropPath: null,
  overview: null,
});

const tv = (id: number | string, title: string, year: number, opts: { imdbId?: string; tvdbId?: number; tmdbId?: number } = {}): SourceResult => ({
  id,
  tmdbId: opts.tmdbId,
  imdbId: opts.imdbId,
  tvdbId: opts.tvdbId,
  type: 'tv',
  title,
  year,
  posterPath: null,
  backdropPath: null,
  overview: null,
});

describe('looksLikeSeries', () => {
  it('true for paths under a Season folder', () => {
    const rel = 'Show/Season 1/file.mkv';
    expect(looksLikeSeries(rel, pathContext(rel))).toBe(true);
  });

  it('true for explicit S/E in basename', () => {
    const rel = 'something.S01E02.mkv';
    expect(looksLikeSeries(rel, pathContext(rel))).toBe(true);
  });

  it('false for plain movie file at root', () => {
    const rel = 'Dune.2021.mkv';
    expect(looksLikeSeries(rel, pathContext(rel))).toBe(false);
  });

  it('forceSeries override always wins', () => {
    const rel = 'Dune.2021.mkv';
    expect(looksLikeSeries(rel, pathContext(rel), { forceSeries: true })).toBe(true);
  });
});

describe('passBIdentify', () => {
  it('two-source agreement (TMDB+OMDb) pushes a borderline candidate over the threshold', async () => {
    const tmdb = mockSource('tmdb', () => [movie(121, 'The Two Towers', 2002, 'tt0167261')]);
    const omdb = mockSource('omdb', () => [movie(0, 'The Two Towers', 2002, 'tt0167261')]);
    const r = await passBIdentify('LotR Two Towers THEATRICAL ED. (2002).mp4', { tmdb, omdb });
    expect(r.winner).not.toBeNull();
    expect(r.winner!.sources).toContain('tmdb');
    expect(r.winner!.sources).toContain('omdb');
  });

  it('does NOT query TVDB for a movie file (D9 routing)', async () => {
    const tmdbSearch = vi.fn(async () => [movie(121, 'Movie', 2002, 'tt1')]);
    const omdbSearch = vi.fn(async () => [movie(0, 'Movie', 2002, 'tt1')]);
    const tvdbSearch = vi.fn(async () => [] as SourceResult[]);
    const sources = {
      tmdb: { name: 'tmdb', search: tmdbSearch } as Source,
      omdb: { name: 'omdb', search: omdbSearch } as Source,
      tvdb: { name: 'tvdb', search: tvdbSearch } as Source,
    };
    await passBIdentify('Some.Movie.2002.mkv', sources);
    expect(tmdbSearch).toHaveBeenCalled();
    expect(omdbSearch).toHaveBeenCalled();
    expect(tvdbSearch).not.toHaveBeenCalled();
  });

  it('queries TVDB when the file is under a Season folder', async () => {
    const tmdbSearch = vi.fn(async () => [tv('100', 'Sunny', 2005, { tmdbId: 100, imdbId: 'tt0472954' })]);
    const omdbSearch = vi.fn(async () => [tv('o', 'Sunny', 2005, { imdbId: 'tt0472954' })]);
    const tvdbSearch = vi.fn(async () => [tv('tvdb:75805', 'Sunny', 2005, { tvdbId: 75805, imdbId: 'tt0472954' })]);
    const sources = {
      tmdb: { name: 'tmdb', search: tmdbSearch } as Source,
      omdb: { name: 'omdb', search: omdbSearch } as Source,
      tvdb: { name: 'tvdb', search: tvdbSearch } as Source,
    };
    const r = await passBIdentify('Sunny/Season 4/sunny.s04e02.mkv', sources);
    expect(tvdbSearch).toHaveBeenCalled();
    expect(r.winner).not.toBeNull();
    expect(r.winner!.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null winner when no source clears the threshold', async () => {
    const tmdb = mockSource('tmdb', () => [movie(1, 'completely unrelated', 1980)]);
    const r = await passBIdentify('the.real.title.mkv', { tmdb });
    expect(r.winner).toBeNull();
  });

  it('omdb omitted if not configured; works with TMDB alone', async () => {
    const tmdb = mockSource('tmdb', () => [movie(1, 'Dune', 2021, 'tt1160419')]);
    const r = await passBIdentify('Dune.2021.mkv', { tmdb });
    expect(r.sourcesQueried).toEqual(['tmdb']);
  });
});
