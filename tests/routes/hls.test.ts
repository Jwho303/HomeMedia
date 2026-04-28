import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HlsSessionManager, setHlsSessionManagerForTests, type HlsSpawn } from '../../src/streaming/hls-session.js';

vi.mock('../../src/probe.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/probe.js')>();
  return {
    ...orig,
    probe: async () => ({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1200,
      audioStreams: [],
      subStreams: [],
      chapters: [],
    }),
  };
});

interface FakeFFmpeg extends EventEmitter {
  killed: boolean;
  kill: (sig?: string) => boolean;
  stderr: EventEmitter;
}

let mediaRoot: string;
let cacheRoot: string;
const FILENAME = 'movie.mkv';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-hls-routes-media-'));
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-hls-routes-cache-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.HLS_CACHE_DIR = cacheRoot;
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(4096));
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
  delete process.env.HLS_CACHE_DIR;
});

beforeEach(async () => {
  const { openDb, setDb } = await import('../../src/db.js');
  setDb(openDb(':memory:'));
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.HLS_CACHE_DIR = cacheRoot;
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
});

afterEach(() => {
  setHlsSessionManagerForTests(null);
});

function fakeFFmpeg(): FakeFFmpeg {
  const ee = new EventEmitter() as FakeFFmpeg;
  ee.killed = false;
  ee.stderr = new EventEmitter();
  ee.kill = () => {
    ee.killed = true;
    setImmediate(() => ee.emit('exit', null, 'SIGKILL'));
    return true;
  };
  return ee;
}

/** Register a fake session manager that synthesizes a playlist on disk in
 *  lieu of running ffmpeg. The probe is stubbed out via vi.mock at the
 *  module top. */
async function setupFakes(): Promise<HlsSessionManager> {
  const spawnFn: HlsSpawn = (_cmd, args) => {
    // Find the cache dir from the args (last arg is the playlist path).
    const playlist = args[args.length - 1] ?? '';
    const cacheDir = path.dirname(playlist);
    setTimeout(() => {
      void fs.writeFile(
        path.join(cacheDir, 'index.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXTINF:6.0,\nseg-00000.ts\n#EXT-X-ENDLIST\n',
      );
      void fs.writeFile(path.join(cacheDir, 'seg-00000.ts'), Buffer.from('fake-ts-bytes'));
    }, 30);
    return fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
  };
  const mgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
  setHlsSessionManagerForTests(mgr);
  return mgr;
}

describe('hls routes', () => {
  it('GET /api/hls/master.m3u8?path=… returns playlist with rewritten segment URIs', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
      const sessionId = res.headers['x-hls-session-id'];
      expect(typeof sessionId).toBe('string');
      const body = res.payload;
      expect(body).toContain('#EXTM3U');
      expect(body).toContain(`/api/hls/${sessionId}/seg-00000.ts`);
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('GET segment with valid session returns the bytes', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const sessionId = r1.headers['x-hls-session-id'] as string;
      const r2 = await app.inject({
        method: 'GET',
        url: `/api/hls/${sessionId}/seg-00000.ts`,
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.headers['content-type']).toBe('video/mp2t');
      expect(r2.rawPayload.toString('utf8')).toBe('fake-ts-bytes');
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('GET segment with unknown session returns 404', async () => {
    await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/hls/00000000-0000-0000-0000-000000000000/seg-00000.ts',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/hls/:sessionId tears down the session', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const sessionId = r1.headers['x-hls-session-id'] as string;
      expect(mgr.get(sessionId)).toBeDefined();
      const r2 = await app.inject({
        method: 'DELETE',
        url: `/api/hls/${sessionId}`,
      });
      expect(r2.statusCode).toBe(204);
      expect(mgr.get(sessionId)).toBeUndefined();
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('DELETE on unknown session is idempotent (204)', async () => {
    await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/hls/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  // Heartbeat: the player POSTs /touch every ~20s while playing so the
  // server's idle GC doesn't reap a session whose client has buffered
  // ahead and stopped fetching segments. 204 means the session is alive
  // (and was just touched); 410 means the client should respawn.
  it('POST /touch on a live session bumps lastTouchedAt and 204s', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const sessionId = r1.headers['x-hls-session-id'] as string;
      const before = mgr.get(sessionId)!.lastTouchedAt;
      // Sleep a tick so we can observe a different timestamp.
      await new Promise((r) => setTimeout(r, 5));
      const r2 = await app.inject({ method: 'POST', url: `/api/hls/${sessionId}/touch` });
      expect(r2.statusCode).toBe(204);
      const after = mgr.get(sessionId)!.lastTouchedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('POST /touch on a session that was already deleted returns 410', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const sessionId = r1.headers['x-hls-session-id'] as string;
      await mgr.delete(sessionId);
      const r2 = await app.inject({ method: 'POST', url: `/api/hls/${sessionId}/touch` });
      expect(r2.statusCode).toBe(410);
      expect(r2.json()).toEqual({ error: 'session_gone' });
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('POST /touch with a malformed session id returns 400', async () => {
    await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/hls/not-a-uuid/touch' });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects bad session id with 400', async () => {
    await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/hls/badid/seg-00000.ts',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects bad segment name with 400', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const sessionId = r1.headers['x-hls-session-id'] as string;
      const r2 = await app.inject({
        method: 'GET',
        url: `/api/hls/${sessionId}/../etc/passwd`,
      });
      expect([400, 404]).toContain(r2.statusCode);
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('reuses session on second master.m3u8 fetch with same params', async () => {
    const mgr = await setupFakes();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      const r2 = await app.inject({
        method: 'GET',
        url: `/api/hls/master.m3u8?path=${encodeURIComponent(FILENAME)}`,
      });
      expect(r1.headers['x-hls-session-id']).toBe(r2.headers['x-hls-session-id']);
      expect(mgr.liveCount()).toBe(1);
    } finally {
      await app.close();
      await mgr.shutdownAll();
    }
  });

  it('/api/config carries the hlsPlayer flag (0.1.7 — moved off /api/share/status)', async () => {
    await setupFakes();
    process.env.HLS_PLAYER = 'true';
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const cfg = await app.inject({ method: 'GET', url: '/api/config' });
      expect(cfg.statusCode).toBe(200);
      expect(cfg.json().hlsPlayer).toBe(true);
      // Share status no longer carries the flag.
      const ss = await app.inject({ method: 'GET', url: '/api/share/status' });
      expect(ss.json()).not.toHaveProperty('hlsPlayer');
    } finally {
      await app.close();
      delete process.env.HLS_PLAYER;
      resetConfigForTests();
    }
  });
});
