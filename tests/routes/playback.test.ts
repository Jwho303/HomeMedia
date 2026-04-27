import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-playback-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('playback routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
  });

  it('GET /api/playback/:path returns zeros when row missing; does not insert', async () => {
    const { buildServer } = await import('../../src/server.js');
    const { getDb } = await import('../../src/db.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ position: 0, duration: 0, watched: false });
      // Confirm we did not insert.
      const db = getDb();
      expect(db.getPlayback('Dune.2021.mkv')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('POST /api/playback/:path upserts and round-trips', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 120.5, duration: 9000 },
      });
      expect(post.statusCode).toBe(200);
      const get = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
      });
      const body = get.json();
      expect(body.position).toBe(120.5);
      expect(body.duration).toBe(9000);
      expect(body.watched).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('POST /api/playback rejects extra fields with 400', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 0, duration: 1, evil: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/playback marks watched when near end', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 9000, duration: 9000 },
      });
      const get = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
      });
      expect(get.json().watched).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /api/playback with watched:true forces watched=1 mid-playback (0.1.3)', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 5400, duration: 9000, watched: true },
      });
      expect(res.statusCode).toBe(200);
      const get = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
      });
      const body = get.json();
      expect(body.watched).toBe(true);
      expect(body.position).toBe(5400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/playback without watched preserves prior watched=1 (0.1.3)', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      // First, mark watched.
      await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 5400, duration: 9000, watched: true },
      });
      // Then a backwards seek with no watched flag must not flip watched off.
      await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
        payload: { position: 100, duration: 9000 },
      });
      const get = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent('Dune.2021.mkv'),
      });
      const body = get.json();
      expect(body.watched).toBe(true);
      expect(body.position).toBe(100);
    } finally {
      await app.close();
    }
  });

  it('handles paths with subfolders and special chars', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const rel = 'The Bear (2022)/S01E01 - System.mkv';
      await app.inject({
        method: 'POST',
        url: '/api/playback/' + encodeURIComponent(rel),
        payload: { position: 60, duration: 1800 },
      });
      const get = await app.inject({
        method: 'GET',
        url: '/api/playback/' + encodeURIComponent(rel),
      });
      expect(get.json().position).toBe(60);
    } finally {
      await app.close();
    }
  });
});
