import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-config-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('config routes (0.1.7)', () => {
  it('GET /api/config returns hlsPlayer:false by default', async () => {
    const { resetConfigForTests } = await import('../../src/config.js');
    delete process.env.HLS_PLAYER;
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ hlsPlayer: false });
    } finally {
      await app.close();
    }
  });

  it('GET /api/config returns hlsPlayer:true when HLS_PLAYER=true', async () => {
    const { resetConfigForTests } = await import('../../src/config.js');
    process.env.HLS_PLAYER = 'true';
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ hlsPlayer: true });
    } finally {
      await app.close();
      delete process.env.HLS_PLAYER;
      resetConfigForTests();
    }
  });

  it('GET /api/share/status no longer carries hlsPlayer', async () => {
    const { resetConfigForTests } = await import('../../src/config.js');
    process.env.HLS_PLAYER = 'true';
    resetConfigForTests();
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/share/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.online).toBe(true);
      expect(body).not.toHaveProperty('hlsPlayer');
    } finally {
      await app.close();
      delete process.env.HLS_PLAYER;
      resetConfigForTests();
    }
  });
});
