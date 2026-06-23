import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-mi-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

function makeFakeTmdb(overrides: Partial<{
  searchMulti: (q: string, year?: number) => unknown;
  getMovie: (id: number) => unknown;
  getSeries: (id: number) => unknown;
  getEpisodes: (s: number, sn: number) => unknown;
  getMovieExternalIds: (id: number) => unknown;
  getSeriesExternalIds: (id: number) => unknown;
  findByImdbId: (id: string) => unknown;
}> = {}): never {
  return {
    searchMulti: overrides.searchMulti ?? (async () => ({ page: 1, total_results: 0, results: [] })),
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

describe('manual-identify routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
    process.env.MEDIA_ROOT = goodDir;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
  });

  afterEach(async () => {
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(null);
    vi.restoreAllMocks();
  });

  it('GET /search returns 503 when share is offline', async () => {
    process.env.MEDIA_ROOT = path.join(os.tmpdir(), `homemedia-missing-${Date.now()}`);
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/manual-identify/search?q=foo' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'share_offline' });
    } finally {
      await app.close();
    }
  });

  it('GET /search returns 400 on empty query', async () => {
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/manual-identify/search?q=' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /search returns up to 20 candidates with year extracted from "Title (2022)"', async () => {
    let captured: { q: string; year: number | undefined } | null = null;
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      searchMulti: async (q, year) => {
        captured = { q, year };
        return {
          page: 1,
          total_results: 30,
          results: Array.from({ length: 30 }, (_, i) => ({
            id: 100 + i,
            media_type: i % 2 === 0 ? 'movie' : 'tv',
            title: i % 2 === 0 ? `Title ${i}` : null,
            name: i % 2 === 1 ? `Show ${i}` : null,
            release_date: '2022-01-01',
            first_air_date: '2022-01-01',
            overview: null,
            poster_path: null,
          })),
        };
      },
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/manual-identify/search?q=${encodeURIComponent('The Bear (2022)')}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(captured).not.toBeNull();
      expect(captured!.q).toBe('The Bear');
      expect(captured!.year).toBe(2022);
      expect(body.candidates).toHaveLength(20);
      expect(body.candidates[0].tmdbId).toBe(100);
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with { tmdbId, type } updates the item and writes manual_overrides', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'wrong.mkv',
      type: 'movie',
      tmdb_id: 99,
      title: 'Wrong',
      year: 2000,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1000,
    });

    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async (id) => ({ id, title: 'Right Movie', release_date: '2020-01-01', overview: 'right' }),
      getMovieExternalIds: async () => ({ imdb_id: 'tt9999999', tvdb_id: null }),
    }));

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 12345, type: 'movie' },
      });
      expect(res.statusCode).toBe(200);
      const updatedRow = db.raw
        .prepare<[number], { id: number; tmdb_id: number; title: string; confidence: number }>(
          'SELECT id, tmdb_id, title, confidence FROM media_items WHERE id = ?',
        )
        .get(item.id);
      expect(updatedRow!.tmdb_id).toBe(12345);
      expect(updatedRow!.title).toBe('Right Movie');
      expect(updatedRow!.confidence).toBe(1.0);

      const ov = db.getManualOverride('wrong.mkv');
      expect(ov).toBeDefined();
      expect(ov!.tmdb_id).toBe(12345);
      expect(ov!.reason).toBe('tmdb-link');
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with { link: "tmdb:12345" } resolves and applies', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'wrong.mkv',
      type: 'movie',
      tmdb_id: 99,
      title: 'Wrong',
      year: 2000,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1000,
    });

    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async (id) => ({ id, title: 'Linked Movie', release_date: '2021-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { link: 'tmdb:42' },
      });
      expect(res.statusCode).toBe(200);
      const ov = db.getManualOverride('wrong.mkv')!;
      expect(ov.tmdb_id).toBe(42);
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with { link: "imdb:ttN" } resolves through findByImdbId', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'wrong.mkv', type: 'movie', tmdb_id: 99, title: 'Wrong', year: 2000,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      findByImdbId: async () => ({
        movie_results: [{ id: 777, title: 'Imdb Movie', release_date: '2019-01-01', overview: null }],
        tv_results: [],
        person_results: [],
      }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { link: 'imdb:tt0123456' },
      });
      expect(res.statusCode).toBe(200);
      const ov = db.getManualOverride('wrong.mkv')!;
      expect(ov.tmdb_id).toBe(777);
      expect(ov.reason).toBe('imdb-link');
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with TMDB URL link resolves the numeric id', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'wrong.mkv', type: 'series', tmdb_id: 99, title: 'Wrong', year: 2000,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      // First call (tmdb id) tries getMovie — make it fail so we fall through to series.
      getMovie: async () => { throw new Error('not a movie'); },
      getSeries: async (id) => ({ id, name: 'The Bear', first_air_date: '2022-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { link: 'https://www.themoviedb.org/tv/136315-the-bear' },
      });
      expect(res.statusCode).toBe(200);
      const ov = db.getManualOverride('wrong.mkv')!;
      expect(ov.tmdb_id).toBe(136315);
      expect(ov.type).toBe('series');
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with garbage link returns 400', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'wrong.mkv', type: 'movie', tmdb_id: 99, title: 'W', year: 2000,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { link: 'random garbage' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unresolvable_link' });
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id with unknown id returns 404', async () => {
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/manual-identify/item/999999',
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 1, type: 'movie' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /episode/:id with { season, episode } correction updates S/E', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 136315,
      title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const ep = db.upsertEpisode({
      series_id: series.id, path: 'TheBear/wrong.mkv', season: 1, episode: 99,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({ id, name: 'The Bear', first_air_date: '2022-01-01', overview: '', seasons: [{ season_number: 4, episode_count: 12 }] }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/episode/${ep.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 136315, type: 'series', season: 4, episode: 1 },
      });
      expect(res.statusCode).toBe(200);
      const updated = db.getEpisodeByPath('TheBear/wrong.mkv')!;
      expect(updated.season).toBe(4);
      expect(updated.episode).toBe(1);
      const ov = db.getManualOverride('TheBear/wrong.mkv')!;
      expect(ov.season).toBe(4);
      expect(ov.episode).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('POST /episode/:id with seInput "S04E01" parses and applies', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 136315,
      title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const ep = db.upsertEpisode({
      series_id: series.id, path: 'TheBear/x.mkv', season: 1, episode: 1,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({ id, name: 'The Bear', first_air_date: '2022-01-01', overview: '' }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/episode/${ep.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 136315, type: 'series', seInput: 'S04E01' },
      });
      expect(res.statusCode).toBe(200);
      const updated = db.getEpisodeByPath('TheBear/x.mkv')!;
      expect(updated.season).toBe(4);
      expect(updated.episode).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('POST /episode/:id with an absolute episode number maps across seasons', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'Naruto', type: 'series', tmdb_id: 46260,
      title: 'Naruto', year: 2002,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const ep = db.upsertEpisode({
      series_id: series.id, path: 'Naruto/060.mkv', season: 1, episode: 1,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb({
      getMovie: async () => { throw new Error('series only'); },
      getSeries: async (id) => ({
        id, name: 'Naruto', first_air_date: '2002-01-01', overview: '',
        seasons: [
          { season_number: 0, episode_count: 5 },
          { season_number: 1, episode_count: 57 },
          { season_number: 2, episode_count: 43 },
        ],
      }),
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/episode/${ep.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 46260, type: 'series', seInput: '60' },
      });
      expect(res.statusCode).toBe(200);
      const updated = db.getEpisodeByPath('Naruto/060.mkv')!;
      // ep 60 = season 1 (57) + 3 → season 2, episode 3.
      expect(updated.season).toBe(2);
      expect(updated.episode).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('POST /episode/:id with bad seInput returns 400', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 136315,
      title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const ep = db.upsertEpisode({
      series_id: series.id, path: 'TheBear/x.mkv', season: 1, episode: 1,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1000,
    });
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/episode/${ep.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 136315, type: 'series', seInput: 'nonsense' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_se_input' });
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id returns 409 when scan is in flight', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const item = db.upsertItem({
      path: 'foo.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const { tryAcquire } = await import('../../src/scan-lock.js');
    const release = tryAcquire();
    expect(release).not.toBeNull();
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/manual-identify/item/${item.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 5, type: 'movie' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'scan_in_progress' });
    } finally {
      release?.();
      await app.close();
    }
  });

  it('POST /item/:id/eject removes a misclassified movie and returns its files to needs_review', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    // Simulate the "Theodora" corruption: two loose episode files gated as one movie.
    const movie = db.upsertItem({
      path: 'Vampire S03E01.mkv', type: 'movie', tmdb_id: 323411, title: 'Theodora', year: 1996,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    db.upsertMediaFile({ item_id: movie.id, path: 'Vampire S03E01.mkv', mtime: 1, scanned_at: 1000 });
    db.upsertMediaFile({ item_id: movie.id, path: 'Vampire S03E02.mkv', mtime: 1, scanned_at: 1000 });
    db.setManualOverride({ path: 'Vampire S03E01.mkv', tmdb_id: 323411, type: 'movie', reason: 'tmdb-link', decided_at: 1 });
    db.setManualOverride({ path: 'Vampire S03E02.mkv', tmdb_id: 323411, type: 'movie', reason: 'tmdb-link', decided_at: 1 });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/manual-identify/item/${movie.id}/eject` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, ejected: 2 });

      // Movie item + its media_files are gone.
      expect(db.raw.prepare('SELECT id FROM media_items WHERE id = ?').get(movie.id)).toBeUndefined();
      expect(db.getMediaFileByPath('Vampire S03E01.mkv')).toBeUndefined();

      // Both files are back in needs_review with their movie override cleared.
      expect(db.getReviewItem('Vampire S03E01.mkv')!.reason).toBe('ejected');
      expect(db.getReviewItem('Vampire S03E02.mkv')).toBeDefined();
      expect(db.getManualOverride('Vampire S03E01.mkv')).toBeUndefined();
      expect(db.getManualOverride('Vampire S03E02.mkv')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id/eject returns 409 when a scan is in flight', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const movie = db.upsertItem({
      path: 'm.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    const { tryAcquire } = await import('../../src/scan-lock.js');
    const release = tryAcquire();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/manual-identify/item/${movie.id}/eject` });
      expect(res.statusCode).toBe(409);
    } finally {
      release?.();
      await app.close();
    }
  });

  it('POST /item/:id/eject returns 404 for an unknown id', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/manual-identify/item/999999/eject' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /item/:id returns 503 when share is offline', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    db.upsertItem({
      path: 'foo.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1000,
    });
    process.env.MEDIA_ROOT = path.join(os.tmpdir(), `homemedia-missing-${Date.now()}`);
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { setTmdbForTests } = await import('../../src/routes/manual-identify.js');
    setTmdbForTests(makeFakeTmdb());
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/manual-identify/item/1',
        headers: { 'Content-Type': 'application/json' },
        payload: { tmdbId: 5, type: 'movie' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
