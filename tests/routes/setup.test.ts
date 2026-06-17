import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 0.1.13 — FTUE backend: boot-without-keys, `GET /api/setup-state`, and the
 * `503 not_configured` guard on media routes.
 *
 * Each test uses a fresh temp dir as both MEDIA_ROOT and the settings.json home
 * (via SETTINGS_PATH) and an in-memory DB, so config + library state are
 * isolated and the real `data/` overlay is never touched.
 */

let tmpDir: string;

async function freshConfig(): Promise<void> {
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
}

async function freshDb(): Promise<void> {
  const { openDb, setDb } = await import('../../src/db.js');
  setDb(openDb(':memory:'));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-setup-'));
  process.env.SETTINGS_PATH = path.join(tmpDir, 'settings.json');
  // Default: a fully-configured install. Individual tests clear fields to
  // exercise the "needs setup" branches.
  process.env.TMDB_API_KEY = 'env-tmdb';
  process.env.MEDIA_ROOT = tmpDir;
  process.env.OMDB_API_KEY = '';
  process.env.TVDB_API_KEY = '';
  await freshConfig();
  await freshDb();
  const { _resetJobsForTests } = await import('../../src/scan-progress.js');
  _resetJobsForTests();
});

afterEach(async () => {
  delete process.env.SETTINGS_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await freshConfig();
  const { setDb } = await import('../../src/db.js');
  setDb(null);
  const { _resetJobsForTests } = await import('../../src/scan-progress.js');
  _resetJobsForTests();
});

describe('isConfigured / boot without keys', () => {
  it('loadConfig does not throw when TMDB + MEDIA_ROOT are absent', async () => {
    delete process.env.TMDB_API_KEY;
    delete process.env.MEDIA_ROOT;
    await freshConfig();
    const { loadConfig, isConfigured } = await import('../../src/config.js');
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().tmdbApiKey).toBe('');
    expect(loadConfig().mediaRoot).toBe('');
    expect(isConfigured()).toBe(false);
  });

  it('isConfigured is true only when both TMDB and MEDIA_ROOT are set', async () => {
    const { isConfigured } = await import('../../src/config.js');
    expect(isConfigured()).toBe(true);

    delete process.env.TMDB_API_KEY;
    await freshConfig();
    const { isConfigured: again } = await import('../../src/config.js');
    expect(again()).toBe(false);
  });
});

describe('GET /api/setup-state', () => {
  it('fresh clone (no keys): not configured, no wizard-skip', async () => {
    delete process.env.TMDB_API_KEY;
    delete process.env.MEDIA_ROOT;
    await freshConfig();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/setup-state' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(false);
      expect(body.tmdbReady).toBe(false);
      expect(body.mediaFolders).toEqual([]);
      expect(body.libraryBuilt).toBe(false);
      expect(body.itemCount).toBe(0);
      expect(body.activeJobId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('never leaks the raw TMDB key', async () => {
    process.env.TMDB_API_KEY = 'super-secret-key-123';
    await freshConfig();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/setup-state' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tmdbReady).toBe(true);
      expect(res.body).not.toContain('super-secret-key-123');
    } finally {
      await app.close();
    }
  });

  it('configured but unbuilt: configured=true, libraryBuilt=false', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/setup-state' });
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.mediaFolders).toEqual([path.resolve(tmpDir)]);
      expect(body.libraryBuilt).toBe(false);
      expect(body.itemCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('configured + built library: configured && libraryBuilt → no wizard', async () => {
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const runId = db.openScanRun('refresh-smart');
    db.closeScanRunOk(runId, {});
    db.upsertItem({
      path: 'Movie.mkv',
      type: 'movie',
      tmdb_id: 1,
      title: 'Movie',
      year: 2020,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1000,
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/setup-state' });
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.libraryBuilt).toBe(true);
      expect(body.itemCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('not_configured guard', () => {
  it('library routes return 503 not_configured until TMDB + folder are set', async () => {
    delete process.env.TMDB_API_KEY;
    delete process.env.MEDIA_ROOT;
    await freshConfig();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/library' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'not_configured' });
    } finally {
      await app.close();
    }
  });

  it('settings + setup-state stay reachable while not configured', async () => {
    delete process.env.TMDB_API_KEY;
    delete process.env.MEDIA_ROOT;
    await freshConfig();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const settings = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(settings.statusCode).toBe(200);
      const setup = await app.inject({ method: 'GET', url: '/api/setup-state' });
      expect(setup.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('library route opens once configured (no restart)', async () => {
    // Boot unconfigured…
    delete process.env.TMDB_API_KEY;
    delete process.env.MEDIA_ROOT;
    await freshConfig();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const closed = await app.inject({ method: 'GET', url: '/api/library' });
      expect(closed.statusCode).toBe(503);

      // …then configure live and re-check the same running server.
      process.env.TMDB_API_KEY = 'env-tmdb';
      process.env.MEDIA_ROOT = tmpDir;
      await freshConfig();
      const open = await app.inject({ method: 'GET', url: '/api/library' });
      expect(open.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
