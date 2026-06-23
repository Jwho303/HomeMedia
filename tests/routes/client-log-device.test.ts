import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 0.2.0 — server wiring acceptance:
 *  - POST /api/client-log accepts a boot `device` diagnosis (D8) and 2xx's.
 *  - GET /legacy and /legacy/ serve the legacy ES5 client (Phase 5).
 */

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-device-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('client-log device diagnosis (D8)', () => {
  it('POST /api/client-log with a boot diag returns 2xx', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/client-log',
        payload: {
          tag: 'device.boot',
          evt: 'device.boot',
          device: {
            bucket: 'modern',
            inputMode: 'dpad',
            platform: 'playstation',
            mse: true,
            modernJs: true,
            nativeHls: false,
          },
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(300);
    } finally {
      await app.close();
    }
  });

  it('still accepts a legacy player-report shape (back-compat)', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/client-log',
        payload: { tag: 'player-report', relPath: 'Movies/X.mkv', playMode: 'hls' },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});

describe('legacy client static serving (Phase 5)', () => {
  it('GET /legacy/ serves the ES5 legacy index (no MSE / hls.js references)', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/legacy/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // It loads the protocol + app scripts and is a flat native-video client.
      expect(res.body).toContain('/legacy/protocol.js');
      expect(res.body).toContain('/legacy/app.js');
      // No hls.js / module bundle script tags (it's native <video> only).
      expect(res.body).not.toMatch(/<script[^>]+src=[^>]*hls/i);
      expect(res.body).not.toContain('type="module"');
    } finally {
      await app.close();
    }
  });

  it('GET /legacy (no trailing slash) redirects to /legacy/', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/legacy' });
      expect(res.statusCode).toBe(308);
      expect(res.headers.location).toBe('/legacy/');
    } finally {
      await app.close();
    }
  });

  it('GET /legacy/protocol.js serves the ES5 protocol port', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/legacy/protocol.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('mintPlayerId');
    } finally {
      await app.close();
    }
  });
});
