import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-unc-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

function makeFakeTmdb(overrides: Partial<{
  getMovie: (id: number) => unknown;
  getSeries: (id: number) => unknown;
  getEpisodes: (id: number, sn: number) => unknown;
  getMovieExternalIds: (id: number) => unknown;
  getSeriesExternalIds: (id: number) => unknown;
  findByImdbId: (id: string) => unknown;
}> = {}): never {
  return {
    getMovie: overrides.getMovie ?? (async (id: number) => ({ id, title: `Movie ${id}`, release_date: '2020-01-01', overview: 'm' })),
    getSeries: overrides.getSeries ?? (async (id: number) => ({ id, name: `Series ${id}`, first_air_date: '2020-01-01', overview: 's', seasons: [{ season_number: 1, episode_count: 10 }] })),
    getEpisodes: overrides.getEpisodes ?? (async () => ({ id: 1, season_number: 1, episodes: [] })),
    getMovieExternalIds: overrides.getMovieExternalIds ?? (async () => ({ imdb_id: null, tvdb_id: null })),
    getSeriesExternalIds: overrides.getSeriesExternalIds ?? (async () => ({ imdb_id: null, tvdb_id: null })),
    findByImdbId: overrides.findByImdbId ?? (async () => ({ movie_results: [], tv_results: [], person_results: [] })),
    posterUrl: (p: string | null | undefined) => (p ? `https://image.tmdb.org/p/${p}` : null),
    stillUrl: (p: string | null | undefined) => (p ? `https://image.tmdb.org/s/${p}` : null),
  } as never;
}

/** Seed a needs_review row AND write the backing file on disk (the identify
 *  route stats the file to confirm it exists and read its mtime). */
async function seedReview(relPath: string, reason = 'episode_unresolved', candidates = '[]'): Promise<void> {
  const { getDb } = await import('../../src/db.js');
  const abs = path.join(goodDir, ...relPath.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'x');
  getDb().upsertReviewItem({ path: relPath, reason, candidates, added_at: 1000, scanned_at: 1000 });
}

describe('uncategorized routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
    process.env.MEDIA_ROOT = goodDir;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
  });

  afterEach(async () => {
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(null);
    vi.restoreAllMocks();
  });

  it('GET /uncategorized lists alive needs_review rows, newest first', async () => {
    await seedReview('Show/S03E01.mkv', 'episode_unresolved');
    await seedReview('Show/S03E02.mkv', 'episode_unresolved');
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library/uncategorized' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toMatchObject({ reason: 'episode_unresolved' });
      expect(body.items[0]).toHaveProperty('addedAt');
      expect(Array.isArray(body.items[0].candidates)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('GET /uncategorized excludes soft-deleted rows', async () => {
    await seedReview('Show/gone.mkv');
    const { getDb } = await import('../../src/db.js');
    getDb().raw.prepare(`UPDATE needs_review SET deleted_at = 1 WHERE path = ?`).run('Show/gone.mkv');
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library/uncategorized' });
      expect(res.json().items).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('POST /identify rescues a series episode, writes override, clears review', async () => {
    await seedReview('Vampire/S03E01.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({ id, name: 'Interview with the Vampire', first_air_date: '2022-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'Vampire/S03E01.mkv', tmdbId: 128098, type: 'series', seInput: 'S03E01' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const ep = db.getEpisodeByPath('Vampire/S03E01.mkv')!;
      expect(ep.season).toBe(3);
      expect(ep.episode).toBe(1);

      const ov = db.getManualOverride('Vampire/S03E01.mkv')!;
      expect(ov.tmdb_id).toBe(128098);
      expect(ov.type).toBe('series');
      expect(ov.season).toBe(3);

      // needs_review entry is cleared.
      expect(db.getReviewItem('Vampire/S03E01.mkv')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('POST /identify rescues a movie via a TMDB link', async () => {
    await seedReview('looseMovie.mkv', 'no_results');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async (id) => ({ id, title: 'Rescued Movie', release_date: '2019-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'looseMovie.mkv', link: 'tmdb:42' },
      });
      expect(res.statusCode).toBe(200);
      const item = db.getByPath('looseMovie.mkv')!;
      expect(item.type).toBe('movie');
      expect(item.tmdb_id).toBe(42);
      expect(db.getManualOverride('looseMovie.mkv')!.tmdb_id).toBe(42);
      expect(db.getReviewItem('looseMovie.mkv')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('POST /identify honours the picked series type even when the same id is ALSO a valid movie', async () => {
    // The real collision: movie/323411 = "Theodora", tv/323411 = "The Vampire
    // Lestat". The user picks the SERIES. getMovie(323411) succeeds (it's a real
    // movie), so movie-first probing would mis-resolve — type-aware resolution
    // must fetch the series instead.
    await seedReview('Vampire/S03E01.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async (id) => ({ id, title: 'Theodora', release_date: '1996-01-01', overview: '' }),
      getSeries: async (id) => ({ id, name: 'The Vampire Lestat', first_air_date: '2026-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'Vampire/S03E01.mkv', tmdbId: 323411, type: 'series', seInput: 'S03E01' },
      });
      expect(res.statusCode).toBe(200);
      const ep = db.getEpisodeByPath('Vampire/S03E01.mkv')!;
      expect(ep.season).toBe(3);
      expect(ep.episode).toBe(1);
      const series = db.getByTmdbId(323411, 'series')!;
      expect(series.title).toBe('The Vampire Lestat');
      // It was NOT gated as the "Theodora" movie.
      expect(db.getByTmdbId(323411, 'movie')).toBeUndefined();
      const ov = db.getManualOverride('Vampire/S03E01.mkv')!;
      expect(ov.type).toBe('series');
    } finally {
      await app.close();
    }
  });

  it('POST /identify rejects a movie identity when an episode (S/E) was supplied — no silent movie', async () => {
    // The "Theodora" bug: a bare tmdb id resolves movie-first. If the user typed
    // an episode, refuse rather than gating it as a movie and dropping the S/E.
    await seedReview('Vampire/S03E01.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      // id 323411 is a real movie → getMovie succeeds → resolves as 'movie'.
      getMovie: async (id) => ({ id, title: 'Theodora', release_date: '1996-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'Vampire/S03E01.mkv', tmdbId: 323411, type: 'movie', seInput: 'S03E01' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'episode_requires_series' });
      // Nothing was gated; the file stays in needs_review.
      expect(db.getByPath('Vampire/S03E01.mkv')).toBeUndefined();
      expect(db.getReviewItem('Vampire/S03E01.mkv')).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 404 for a path not in needs_review', async () => {
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'nope.mkv', tmdbId: 1, type: 'movie' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 404 file_missing when the row exists but the file is gone', async () => {
    // Seed the DB row directly, WITHOUT writing the file on disk.
    const { getDb } = await import('../../src/db.js');
    getDb().upsertReviewItem({ path: 'phantom.mkv', reason: 'no_results', candidates: '[]', added_at: 1, scanned_at: 1 });
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'phantom.mkv', tmdbId: 7, type: 'movie' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'file_missing' });
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 400 on a bad seInput', async () => {
    await seedReview('badse.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'badse.mkv', tmdbId: 1, type: 'series', seInput: 'nonsense' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_se_input' });
    } finally {
      await app.close();
    }
  });

  it('POST /identify maps an absolute episode number across seasons', async () => {
    // Naruto-shaped: ripped as 001–220 with no SxxEyy; user types "60", which
    // (season 1 = 57 eps) falls into season 2 episode 3.
    await seedReview('Naruto/060.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({
        id,
        name: 'Naruto',
        first_air_date: '2002-01-01',
        overview: '',
        seasons: [
          { season_number: 0, episode_count: 5 },
          { season_number: 1, episode_count: 57 },
          { season_number: 2, episode_count: 43 },
        ],
      }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'Naruto/060.mkv', tmdbId: 46260, type: 'series', seInput: '60' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const ep = db.getEpisodeByPath('Naruto/060.mkv')!;
      expect(ep.season).toBe(2);
      expect(ep.episode).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 400 when an absolute number runs past the series', async () => {
    await seedReview('Naruto/999.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({
        id,
        name: 'Naruto',
        first_air_date: '2002-01-01',
        overview: '',
        seasons: [{ season_number: 1, episode_count: 57 }],
      }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'Naruto/999.mkv', tmdbId: 46260, type: 'series', seInput: '999' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'absolute_out_of_range' });
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 400 on an unresolvable link', async () => {
    await seedReview('garbage.mkv');
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'garbage.mkv', link: 'random garbage' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unresolvable_link' });
    } finally {
      await app.close();
    }
  });

  it('POST /identify returns 409 when a scan is in flight', async () => {
    await seedReview('locked.mkv');
    const { tryAcquire } = await import('../../src/scan-lock.js');
    const release = tryAcquire();
    expect(release).not.toBeNull();
    const { setTmdbForTests } = await import('../../src/routes/uncategorized.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/uncategorized/identify',
        headers: { 'Content-Type': 'application/json' },
        payload: { path: 'locked.mkv', tmdbId: 5, type: 'movie' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'scan_in_progress' });
    } finally {
      release?.();
      await app.close();
    }
  });
});
