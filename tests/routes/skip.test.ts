import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir: string;
let seriesId: number;
let movieId: number;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-skip-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = dir;
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { openDb, setDb } = await import('../../src/db.js');
  const db = openDb(':memory:');
  setDb(db);
  seriesId = db.upsertItem({ path: 'Show', type: 'series', tmdb_id: 1, title: 'Show', year: 2000, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 }).id;
  movieId = db.upsertItem({ path: 'Film.mkv', type: 'movie', tmdb_id: 2, title: 'Film', year: 2000, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 }).id;
  db.upsertEpisode({ series_id: seriesId, path: 'Show/S01E01.mkv', season: 1, episode: 1, title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1 });
});

async function app() {
  const { buildServer } = await import('../../src/server.js');
  return buildServer();
}

describe('skip prefs routes', { timeout: 30_000 }, () => {
  it('GET /api/series/:id includes default skipPrefs', async () => {
    const a = await app();
    try {
      const res = await a.inject({ method: 'GET', url: `/api/series/${seriesId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().skipPrefs).toEqual({ autoIntro: false, autoCredits: false });
    } finally {
      await a.close();
    }
  });

  it('PUT persists one pref and leaves the other alone', async () => {
    const a = await app();
    try {
      let res = await a.inject({ method: 'PUT', url: `/api/series/${seriesId}/skip-prefs`, payload: { autoCredits: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ autoIntro: false, autoCredits: true });
      res = await a.inject({ method: 'PUT', url: `/api/series/${seriesId}/skip-prefs`, payload: { autoIntro: true } });
      expect(res.json()).toEqual({ autoIntro: true, autoCredits: true });
      res = await a.inject({ method: 'GET', url: `/api/series/${seriesId}` });
      expect(res.json().skipPrefs).toEqual({ autoIntro: true, autoCredits: true });
    } finally {
      await a.close();
    }
  });

  it('PUT rejects unknown series, movies, and bad bodies', async () => {
    const a = await app();
    try {
      expect((await a.inject({ method: 'PUT', url: '/api/series/9999/skip-prefs', payload: { autoIntro: true } })).statusCode).toBe(404);
      expect((await a.inject({ method: 'PUT', url: `/api/series/${movieId}/skip-prefs`, payload: { autoIntro: true } })).statusCode).toBe(404);
      expect((await a.inject({ method: 'PUT', url: `/api/series/${seriesId}/skip-prefs`, payload: { autoIntro: 'yes' } })).statusCode).toBe(400);
      expect((await a.inject({ method: 'PUT', url: `/api/series/${seriesId}/skip-prefs`, payload: { other: true } })).statusCode).toBe(400);
    } finally {
      await a.close();
    }
  });

  it('POST relearn-themes runs the pass for the show', async () => {
    const a = await app();
    try {
      const res = await a.inject({ method: 'POST', url: `/api/series/${seriesId}/relearn-themes` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ themesLearned: 0 });
    } finally {
      await a.close();
    }
  });
});
