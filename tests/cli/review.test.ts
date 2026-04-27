import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-review-test');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../../src/db.js');
const {
  parseAction,
  parseSeInput,
  candidatesToViews,
  resolveAction,
  applyChoice,
  formatCandidateLine,
} = await import('../../src/cli/review-core.js');

describe('parseAction', () => {
  it('numeric pick', () => {
    expect(parseAction('1')).toEqual({ kind: 'pick', index: 1 });
    expect(parseAction(' 12 ')).toEqual({ kind: 'pick', index: 12 });
  });

  it('skip / quit', () => {
    expect(parseAction('s')).toEqual({ kind: 'skip' });
    expect(parseAction('skip')).toEqual({ kind: 'skip' });
    expect(parseAction('q')).toEqual({ kind: 'quit' });
    expect(parseAction('quit')).toEqual({ kind: 'quit' });
  });

  it('tmdb / tvdb / imdb prefixes', () => {
    expect(parseAction('tmdb:121')).toEqual({ kind: 'tmdb', id: 121 });
    expect(parseAction('tvdb:75805')).toEqual({ kind: 'tvdb', id: 75805 });
    expect(parseAction('imdb:tt0167261')).toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('IMDb URL is recognized', () => {
    expect(parseAction('https://www.imdb.com/title/tt0167261/')).toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('bare tt-id is recognized', () => {
    expect(parseAction('tt0167261')).toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('t:<title> retitle', () => {
    expect(parseAction('t:lord of the rings two towers')).toEqual({ kind: 'retitle', title: 'lord of the rings two towers' });
  });

  it('invalid input is reported as such', () => {
    expect(parseAction('garbage flarbage').kind).toBe('invalid');
    expect(parseAction('').kind).toBe('invalid');
  });
});

describe('parseSeInput', () => {
  it('accepts s4e2, S04E02, 4x2', () => {
    expect(parseSeInput('s4e2')).toEqual({ season: 4, episode: 2 });
    expect(parseSeInput('S04E02')).toEqual({ season: 4, episode: 2 });
    expect(parseSeInput('4x2')).toEqual({ season: 4, episode: 2 });
    expect(parseSeInput('S4 E2')).toEqual({ season: 4, episode: 2 });
  });

  it('rejects unrecognized formats', () => {
    expect(parseSeInput('what')).toBeNull();
  });
});

describe('candidatesToViews', () => {
  it('shapes Pass B JSON candidates into displayable views', () => {
    const raw = [
      {
        tmdb: { tmdbId: 121, imdbId: 'tt0167261', tvdbId: null, title: 'Two Towers', year: 2002, type: 'movie', overview: 'Hobbits.' },
        score: 0.78,
        sources: ['tmdb', 'omdb'],
      },
    ];
    const views = candidatesToViews(raw);
    expect(views).toHaveLength(1);
    expect(views[0]!.tmdbId).toBe(121);
    expect(views[0]!.imdbId).toBe('tt0167261');
    expect(views[0]!.sources).toEqual(['tmdb', 'omdb']);
  });

  it('formatCandidateLine produces a non-empty string with sources, score, agreement', () => {
    const v = candidatesToViews([
      { tmdb: { tmdbId: 1, imdbId: 'tt1', title: 'X', year: 2020, type: 'movie' }, score: 0.71, sources: ['tmdb', 'omdb', 'tvdb'] },
    ])[0]!;
    const line = formatCandidateLine(v);
    expect(line).toContain('X');
    expect(line).toContain('tmdb:1');
    expect(line).toContain('imdb:tt1');
    expect(line).toContain('0.71');
    expect(line).toContain('3 sources agree');
  });
});

describe('resolveAction (network-free paths)', () => {
  it('pick: uses the candidate\'s tmdb id directly', async () => {
    const views = candidatesToViews([
      { tmdb: { tmdbId: 121, imdbId: 'tt1', title: 'X', year: 2020, type: 'movie' }, score: 0.8, sources: ['tmdb'] },
    ]);
    const r = await resolveAction({ kind: 'pick', index: 1 }, {
      row: { path: 'foo.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 },
      views,
      sources: { tmdb: { name: 'tmdb', search: async () => [] } },
      tmdb: { findByImdbId: vi.fn() } as never,
    });
    expect(r).not.toBeNull();
    expect(r!.identity.tmdbId).toBe(121);
    expect(r!.reason).toBe('manual');
  });

  it('imdb: resolves through tmdb.findByImdbId', async () => {
    const tmdb = {
      findByImdbId: vi.fn(async () => ({
        movie_results: [{ id: 121, title: 'Two Towers', release_date: '2002-12-18', overview: 'Hobbits.' }],
        tv_results: [],
        person_results: [],
      })),
    };
    const r = await resolveAction({ kind: 'imdb', id: 'tt0167261' }, {
      row: { path: 'foo.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 },
      views: [],
      sources: { tmdb: { name: 'tmdb', search: async () => [] } },
      tmdb: tmdb as never,
    });
    expect(r).not.toBeNull();
    expect(r!.identity.tmdbId).toBe(121);
    expect(r!.identity.imdbId).toBe('tt0167261');
    expect(r!.reason).toBe('imdb-link');
  });

  it('tmdb: resolves via getMovie + getMovieExternalIds', async () => {
    const tmdb = {
      getMovie: vi.fn(async () => ({ id: 121, title: 'Two Towers', release_date: '2002-12-18', overview: 'Hobbits.' })),
      getMovieExternalIds: vi.fn(async () => ({ imdb_id: 'tt0167261', tvdb_id: null })),
    };
    const r = await resolveAction({ kind: 'tmdb', id: 121 }, {
      row: { path: 'foo.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 },
      views: [],
      sources: { tmdb: { name: 'tmdb', search: async () => [] } },
      tmdb: tmdb as never,
    });
    expect(r).not.toBeNull();
    expect(r!.identity.tmdbId).toBe(121);
    expect(r!.identity.imdbId).toBe('tt0167261');
    expect(r!.reason).toBe('tmdb-link');
  });

  it('tvdb: walks tvdb→imdb→tmdb when the candidate has both ids', async () => {
    const views = candidatesToViews([
      { tmdb: { tvdbId: 75805, imdbId: 'tt0472954', tmdbId: null, title: 'Sunny', year: 2005, type: 'tv' }, score: 0.7, sources: ['tvdb'] },
    ]);
    const tmdb = {
      findByImdbId: vi.fn(async () => ({
        movie_results: [],
        tv_results: [{ id: 2710, name: 'Sunny', first_air_date: '2005-08-04', overview: null }],
        person_results: [],
      })),
    };
    const r = await resolveAction({ kind: 'tvdb', id: 75805 }, {
      row: { path: 'foo.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 },
      views,
      sources: { tmdb: { name: 'tmdb', search: async () => [] } },
      tmdb: tmdb as never,
    });
    expect(r).not.toBeNull();
    expect(r!.identity.tmdbId).toBe(2710);
    expect(r!.reason).toBe('imdb-link');
  });
});

describe('applyChoice', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => { db = openDb(':memory:'); });

  it('movie: writes media_items, media_files, manual_overrides; clears review', async () => {
    db.upsertReviewItem({ path: 'mystery.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 });
    await applyChoice(
      {
        row: db.getReviewItem('mystery.mkv')!,
        identity: { tmdbId: 121, imdbId: 'tt0167261', type: 'movie', title: 'Two Towers', year: 2002 },
        reason: 'manual',
        mtime: 100,
        decidedAt: 200,
      },
      db,
      { getEpisodes: (async () => ({ id: 1, season_number: 1, episodes: [] })) as never, stillUrl: () => null },
    );
    const row = db.getByPath('mystery.mkv');
    expect(row).toBeDefined();
    expect(row!.tmdb_id).toBe(121);
    expect(row!.imdb_id).toBe('tt0167261');
    expect(db.getMediaFileByPath('mystery.mkv')).toBeDefined();
    expect(db.getReviewItem('mystery.mkv')).toBeUndefined();
    const ov = db.getManualOverride('mystery.mkv');
    expect(ov).toBeDefined();
    expect(ov!.reason).toBe('manual');
  });

  it('series: writes episode at supplied S/E and persists override', async () => {
    db.upsertReviewItem({ path: 'sunny.s04e02.avi', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 });
    await applyChoice(
      {
        row: db.getReviewItem('sunny.s04e02.avi')!,
        identity: { tmdbId: 2710, type: 'series', title: 'Sunny', year: 2005 },
        reason: 'imdb-link',
        season: 4,
        episode: 2,
        mtime: 100,
        decidedAt: 200,
      },
      db,
      { getEpisodes: (async () => ({ id: 1, season_number: 4, episodes: [] })) as never, stillUrl: () => null },
    );
    const ep = db.getEpisodeByPath('sunny.s04e02.avi')!;
    expect(ep.season).toBe(4);
    expect(ep.episode).toBe(2);
    const ov = db.getManualOverride('sunny.s04e02.avi')!;
    expect(ov.season).toBe(4);
    expect(ov.episode).toBe(2);
    expect(ov.reason).toBe('imdb-link');
  });
});
