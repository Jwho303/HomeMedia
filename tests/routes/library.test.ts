import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-library-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('library routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
  });

  it('GET /api/library returns split movies/series; excludes soft-deleted by default', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    db.upsertItem({
      path: 'Old.mkv',
      type: 'movie',
      tmdb_id: 1,
      title: 'Old',
      year: 2000,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1000,
    });
    db.upsertItem({
      path: 'Fresh.mkv',
      type: 'movie',
      tmdb_id: 2,
      title: 'Fresh',
      year: 2020,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 5000,
    });
    db.upsertItem({
      path: 'TheBear',
      type: 'series',
      tmdb_id: 3,
      title: 'The Bear',
      year: 2022,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 5000,
    });
    // 0.1.10 — staleness is `deleted_at IS NOT NULL`, not the legacy
    // `scanned_at < MAX(scanned_at)` predicate.
    db.raw.prepare(`UPDATE media_items SET deleted_at = 2000 WHERE path = 'Old.mkv'`).run();

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.movies.map((m: { title: string }) => m.title)).toEqual(['Fresh']);
      expect(body.series.map((s: { title: string }) => s.title)).toEqual(['The Bear']);

      const resAll = await app.inject({ method: 'GET', url: '/api/library?includeStale=true' });
      expect(resAll.statusCode).toBe(200);
      const all = resAll.json();
      expect(all.movies.map((m: { title: string }) => m.title).sort()).toEqual(['Fresh', 'Old']);
    } finally {
      await app.close();
    }
  });

  it('GET /api/series/:id returns series + sorted episodes with inline playback fields (0.1.3.1)', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear',
      type: 'series',
      tmdb_id: 3,
      title: 'The Bear',
      year: 2022,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id,
      path: 'TheBear/S01E02.mkv',
      season: 1,
      episode: 2,
      title: 'Two',
      overview: null,
      still_url: null,
      runtime_seconds: 1800,
      mtime: 1,
      scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id,
      path: 'TheBear/S01E01.mkv',
      season: 1,
      episode: 1,
      title: 'One',
      overview: null,
      still_url: null,
      runtime_seconds: 1500,
      mtime: 1,
      scanned_at: 5000,
    });
    // E1 has resume progress; E2 is fresh.
    db.upsertPlayback({
      path: 'TheBear/S01E01.mkv',
      position: 600,
      duration: 1500,
      updated_at: 1_700_000_000_000,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/series/${series.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.series.title).toBe('The Bear');
      const eps = body.episodes as Array<{
        episode: number;
        runtimeSeconds: number | null;
        position: number;
        duration: number;
        watched: boolean;
        watchedAt: number | null;
      }>;
      expect(eps.map((e) => e.episode)).toEqual([1, 2]);
      // Inline playback for E1.
      expect(eps[0]!.runtimeSeconds).toBe(1500);
      expect(eps[0]!.position).toBe(600);
      expect(eps[0]!.duration).toBe(1500);
      expect(eps[0]!.watched).toBe(false);
      expect(eps[0]!.watchedAt).toBeNull();
      // E2 carries defaults when no playback row exists.
      expect(eps[1]!.runtimeSeconds).toBe(1800);
      expect(eps[1]!.position).toBe(0);
      expect(eps[1]!.duration).toBe(0);
      expect(eps[1]!.watched).toBe(false);
      expect(eps[1]!.watchedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('runtimeSeconds falls back to ffprobe cache when TMDB runtime is missing (0.1.3.1)', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 4, title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'TheBear/S01E01.mkv', season: 1, episode: 1,
      title: 'One', overview: null, still_url: null,
      mtime: 1, scanned_at: 5000,
    });
    db.setProbe('TheBear/S01E01.mkv', {
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1500.6,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/series/${series.id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.episodes[0].runtimeSeconds).toBe(1501);
    } finally {
      await app.close();
    }
  });

  it('runtimeSeconds is null when neither TMDB nor probe is available (0.1.3.1)', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 5, title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'TheBear/S01E01.mkv', season: 1, episode: 1,
      title: 'One', overview: null, still_url: null,
      mtime: 1, scanned_at: 5000,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/series/${series.id}` });
      const body = res.json();
      expect(body.episodes[0].runtimeSeconds).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET /api/library returns home-screen fields with playback aggregate (0.1.3.2)', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    db.upsertItem({
      path: 'Dune.mkv', type: 'movie', tmdb_id: 1, title: 'Dune', year: 2021,
      poster_url: null, backdrop_url: null, overview: null,
      genres_json: JSON.stringify(['Sci-Fi', 'Drama']),
      runtime_seconds: 9300,
      mtime: 1_700_000_000_000, scanned_at: 5000,
    });
    db.upsertPlayback({
      path: 'Dune.mkv', position: 1200, duration: 9300, updated_at: 1_700_000_500_000,
    });
    db.upsertItem({
      path: 'Plain.mkv', type: 'movie', tmdb_id: 2, title: 'Plain', year: 2024,
      poster_url: null, backdrop_url: null, overview: null,
      mtime: 1_700_000_100_000, scanned_at: 5000,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const dune = body.movies.find((m: { title: string }) => m.title === 'Dune');
      expect(dune.genres).toEqual(['Sci-Fi', 'Drama']);
      expect(dune.runtimeSeconds).toBe(9300);
      expect(dune.position).toBe(1200);
      expect(dune.duration).toBe(9300);
      expect(dune.watched).toBe(false);
      expect(dune.addedAt).toBe(1_700_000_000_000);
      expect(dune.lastPlayedAt).toBe(1_700_000_500_000);

      const plain = body.movies.find((m: { title: string }) => m.title === 'Plain');
      expect(plain.genres).toEqual([]);
      expect(plain.runtimeSeconds).toBeNull();
      expect(plain.position).toBe(0);
      expect(plain.duration).toBe(0);
      expect(plain.lastPlayedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET /api/continue returns the unified resumable list (0.1.3.2)', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    db.upsertItem({
      path: 'Dune.mkv', type: 'movie', tmdb_id: 10, title: 'Dune', year: 2021,
      poster_url: null, backdrop_url: null, overview: null,
      runtime_seconds: 9300, mtime: 1, scanned_at: 1,
    });
    db.upsertPlayback({ path: 'Dune.mkv', position: 1200, duration: 9300, updated_at: 5_000 });
    const series = db.upsertItem({
      path: 'Show', type: 'series', tmdb_id: 11, title: 'Show', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'Show/S02E04.mkv', season: 2, episode: 4,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1,
    });
    db.upsertPlayback({ path: 'Show/S02E04.mkv', position: 600, duration: 1500, updated_at: 10_000 });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/continue' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Series most recent → first
      expect(body.items.map((i: { type: string }) => i.type)).toEqual(['series', 'movie']);
      expect(body.items[0].title).toBe('Show');
      expect(body.items[0].resumePath).toBe('Show/S02E04.mkv');
      expect(body.items[0].resumeLabel).toBe('S2 · E4');
      expect(body.items[1].title).toBe('Dune');
      expect(body.items[1].resumeLabel).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('GET /api/series/:id 404 for unknown id', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/series/999' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // 0.1.14 — Hidden-items recovery surface.
  it('GET /api/library/hidden lists tombstoned items whose file is still on disk', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    // Present-on-disk hidden movie.
    await fs.writeFile(path.join(goodDir, 'Present.mkv'), 'x');
    const present = db.upsertItem({
      path: 'Present.mkv', type: 'movie', tmdb_id: 1, title: 'Present', year: 2001,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: present.id, path: 'Present.mkv', mtime: 1, scanned_at: 1 });
    // Genuinely-gone hidden movie (no file written).
    const gone = db.upsertItem({
      path: 'Gone.mkv', type: 'movie', tmdb_id: 2, title: 'Gone', year: 2002,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    // Tombstone both.
    db.raw.prepare(`UPDATE media_items SET deleted_at = 100 WHERE id IN (?, ?)`).run(present.id, gone.id);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library/hidden' });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ id: number; title: string }>;
      // Only the on-disk one is recoverable.
      expect(items.map((i) => i.title)).toEqual(['Present']);
    } finally {
      await fs.rm(path.join(goodDir, 'Present.mkv'), { force: true });
      await app.close();
    }
  });

  it('POST /api/library/hidden/:id/restore revives a hidden movie and re-parents its file', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    await fs.writeFile(path.join(goodDir, 'ROTK.mkv'), 'x');
    const fellowship = db.upsertItem({
      path: 'Fellowship.mkv', type: 'movie', tmdb_id: 120, title: 'Fellowship', year: 2001,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    const rotk = db.upsertItem({
      path: 'ROTK.mkv', type: 'movie', tmdb_id: 122, title: 'ROTK', year: 2003,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    // Mis-parent: ROTK's file points at Fellowship; ROTK item tombstoned.
    db.upsertMediaFile({ item_id: fellowship.id, path: 'ROTK.mkv', mtime: 1, scanned_at: 1 });
    db.raw.prepare(`UPDATE media_items SET deleted_at = 100 WHERE id = ?`).run(rotk.id);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/library/hidden/${rotk.id}/restore` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.restored).toBe(true);
      // File re-parented to ROTK, item alive.
      expect(db.getMediaFileByPath('ROTK.mkv')!.item_id).toBe(rotk.id);
      expect(db.getByPath('ROTK.mkv')!.deleted_at ?? null).toBeNull();
    } finally {
      await fs.rm(path.join(goodDir, 'ROTK.mkv'), { force: true });
      await app.close();
    }
  });

  it('POST /api/library/hidden/:id/restore 404 for unknown id', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/library/hidden/9999/restore' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
