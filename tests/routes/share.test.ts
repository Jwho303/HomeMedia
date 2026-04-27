import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-share-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('share routes', () => {
  it('GET /api/share/status returns online for a real dir', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/share/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.online).toBe(true);
      expect(body.mountPath).toBe(goodDir);
      expect(typeof body.lastSeen).toBe('number');
    } finally {
      await app.close();
    }
  });

  it('GET /api/share/status returns offline for missing dir', async () => {
    const missing = path.join(os.tmpdir(), `homemedia-missing-${Date.now()}`);
    process.env.MEDIA_ROOT = missing;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/share/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json().online).toBe(false);
    } finally {
      await app.close();
      process.env.MEDIA_ROOT = goodDir;
      resetConfigForTests();
    }
  });

  it('POST /api/share/reconnect on non-darwin returns status without throwing', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/share/reconnect' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('online');
      expect(body).toHaveProperty('mountPath');
    } finally {
      await app.close();
    }
  });

  it('reconnect() on darwin spawns osascript with smb URL', async () => {
    const { reconnect } = await import('../../src/share.js');
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = async (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return { exitCode: 0 };
    };
    await reconnect({
      platform: () => 'darwin',
      spawn: fakeSpawn,
      smbHost: 'desktop-host',
      smbShare: 'media',
      mountPath: goodDir,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe('osascript');
    expect(calls[0]!.args[1]).toContain('smb://desktop-host/media');
  });

  it('reconnect() on darwin without smb config does not spawn', async () => {
    const { reconnect } = await import('../../src/share.js');
    let spawned = false;
    await reconnect({
      platform: () => 'darwin',
      spawn: async () => {
        spawned = true;
        return { exitCode: 0 };
      },
      smbHost: null,
      smbShare: null,
      mountPath: goodDir,
    });
    expect(spawned).toBe(false);
  });
});
