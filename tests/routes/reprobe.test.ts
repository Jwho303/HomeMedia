import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mediaRoot: string;

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-reprobe-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  // Two real-on-disk files we can stat.
  await fs.writeFile(path.join(mediaRoot, 'movie.mkv'), Buffer.alloc(64));
  await fs.mkdir(path.join(mediaRoot, 'show'), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, 'show', 's01e01.mkv'), Buffer.alloc(64));
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

/** Wait for the reprobe job (a background promise) to fire its `done` event. */
async function waitForJobDone(jobId: string, timeoutMs = 2000): Promise<unknown> {
  const { attach } = await import('../../src/scan-progress.js');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const a = attach(jobId);
    if (!a) {
      // job already reaped — happens when the test polls slowly
      return null;
    }
    const last = a.history[a.history.length - 1];
    if (last && last.type === 'done') return last.result;
    if (last && last.type === 'error') throw new Error(`job errored: ${last.message}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout waiting for job done');
}

describe('reprobe routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    const db = openDb(':memory:');
    setDb(db);
    process.env.MEDIA_ROOT = mediaRoot;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { _resetJobsForTests } = await import('../../src/scan-progress.js');
    _resetJobsForTests();
    // Seed: one movie row + one media_files row + one episode row.
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES ('movie.mkv', 'movie', 1, 'Movie', 2020, NULL, NULL, NULL, 0, 0)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO media_files (item_id, path, mtime, scanned_at)
         VALUES ((SELECT id FROM media_items WHERE path='movie.mkv'), 'movie.mkv', 0, 0)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES ('show', 'series', 2, 'Show', 2020, NULL, NULL, NULL, 0, 0)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO episodes (series_id, path, season, episode, title, overview, still_url, mtime, scanned_at)
         VALUES ((SELECT id FROM media_items WHERE path='show'), 'show/s01e01.mkv', 1, 1, 'Pilot', NULL, NULL, 0, 0)`,
      )
      .run();
  });

  it('POST /api/reprobe-library returns 202 + jobId; force-probes every row', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const probeFn = vi.fn(async () => ({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 60,
      audioStreams: [],
      subStreams: [],
      chapters: [],
    }));
    setProberDepsForTests({ probe: probeFn });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/reprobe-library' });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { jobId: string; kind: string; files: number };
      expect(body.kind).toBe('reprobe-library');
      expect(body.files).toBe(2);
      const result = (await waitForJobDone(body.jobId)) as
        | { probed: number; fresh: number; failed: number; skipped: number }
        | null;
      // 2 files: movie (via media_files) and episode.
      expect(result?.probed).toBe(2);
      expect(result?.fresh).toBe(0);
      expect(result?.failed).toBe(0);
      expect(probeFn).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });

  it('running reprobe-library twice in a row force-probes both times', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const probeFn = vi.fn(async () => ({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 60,
      audioStreams: [],
      subStreams: [],
      chapters: [],
    }));
    setProberDepsForTests({ probe: probeFn });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({ method: 'POST', url: '/api/reprobe-library' });
      const job1 = (r1.json() as { jobId: string }).jobId;
      await waitForJobDone(job1);
      probeFn.mockClear();
      const r2 = await app.inject({ method: 'POST', url: '/api/reprobe-library' });
      expect(r2.statusCode).toBe(202);
      const job2 = (r2.json() as { jobId: string }).jobId;
      const result = (await waitForJobDone(job2)) as { probed: number };
      expect(result.probed).toBe(2);
      expect(probeFn).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });

  it('returns 409 when a refresh is in flight', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    setProberDepsForTests({
      probe: async () => ({
        container: '', videoCodec: '', audioCodec: '', durationSeconds: 0,
        audioStreams: [], subStreams: [], chapters: [],
      }),
    });
    const releaseScanRef: { current: (() => void) | null } = { current: null };
    setScanForTests(() => new Promise((resolve) => {
      releaseScanRef.current = (): void => resolve({ added: 0, updated: 0, stale: 0, errors: 0, scanned: 0, needsReview: 0 });
    }));

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const refreshRes = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(refreshRes.statusCode).toBe(202);
      // Yield so the background scan begins.
      await new Promise((r) => setImmediate(r));
      const res = await app.inject({ method: 'POST', url: '/api/reprobe-library' });
      expect(res.statusCode).toBe(409);
      releaseScanRef.current?.();
      // Wait for lock release.
      await new Promise((r) => setImmediate(r));
    } finally {
      await app.close();
      setProberDepsForTests(null);
      setScanForTests(null);
    }
  });

  it('POST /api/reprobe-item/:id force-probes every file under a movie', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const probeFn = vi.fn(async () => ({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac',
      durationSeconds: 60, audioStreams: [], subStreams: [], chapters: [],
    }));
    setProberDepsForTests({ probe: probeFn });

    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const movieId = (db.raw.prepare(`SELECT id FROM media_items WHERE path='movie.mkv'`).get() as { id: number }).id;
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/reprobe-item/${movieId}` });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { jobId: string; kind: string; files: number };
      expect(body.kind).toBe('reprobe-item');
      expect(body.files).toBe(1);
      const result = (await waitForJobDone(body.jobId)) as { probed: number };
      expect(result.probed).toBe(1);
      expect(probeFn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });

  it('POST /api/reprobe-item/:id force-probes every episode under a series', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const probeFn = vi.fn(async () => ({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac',
      durationSeconds: 60, audioStreams: [], subStreams: [], chapters: [],
    }));
    setProberDepsForTests({ probe: probeFn });

    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const seriesId = (db.raw.prepare(`SELECT id FROM media_items WHERE path='show'`).get() as { id: number }).id;
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/reprobe-item/${seriesId}` });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { files: number; jobId: string };
      expect(body.files).toBe(1);
      await waitForJobDone(body.jobId);
      expect(probeFn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });

  it('POST /api/reprobe-episode/:id force-probes a single episode', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    const probeFn = vi.fn(async () => ({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac',
      durationSeconds: 60, audioStreams: [], subStreams: [], chapters: [],
    }));
    setProberDepsForTests({ probe: probeFn });

    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const epId = (db.raw.prepare(`SELECT id FROM episodes WHERE path='show/s01e01.mkv'`).get() as { id: number }).id;
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/reprobe-episode/${epId}` });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { kind: string; files: number; jobId: string };
      expect(body.kind).toBe('reprobe-episode');
      expect(body.files).toBe(1);
      await waitForJobDone(body.jobId);
      expect(probeFn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });

  it('reprobe does NOT modify identity columns or scanned_at', async () => {
    const { setProberDepsForTests } = await import('../../src/routes/reprobe.js');
    setProberDepsForTests({
      probe: async () => ({
        container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac',
        durationSeconds: 60, audioStreams: [], subStreams: [], chapters: [],
      }),
    });
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const before = db.raw
      .prepare(`SELECT title, tmdb_id, poster_url, scanned_at FROM media_items WHERE path='movie.mkv'`)
      .get();
    const movieId = (db.raw.prepare(`SELECT id FROM media_items WHERE path='movie.mkv'`).get() as { id: number }).id;
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/reprobe-item/${movieId}` });
      const body = res.json() as { jobId: string };
      await waitForJobDone(body.jobId);
      const after = db.raw
        .prepare(`SELECT title, tmdb_id, poster_url, scanned_at FROM media_items WHERE path='movie.mkv'`)
        .get();
      expect(after).toEqual(before);
    } finally {
      await app.close();
      setProberDepsForTests(null);
    }
  });
});
