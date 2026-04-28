import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  HlsSessionManager,
  setHlsSessionManagerForTests,
  type HlsSpawn,
} from '../../src/streaming/hls-session.js';
import {
  PlayerInstanceManager,
  setPlayerInstanceManagerForTests,
} from '../../src/player/instance.js';
import {
  setIdentityResolverForTests,
  type Identity,
  type IdentityResolver,
} from '../../src/identity/resolver.js';

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

let mediaRoot: string;
let cacheRoot: string;
const FILENAME = 'movie.mkv';
const FILENAME_B = 'second.mkv';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-player-routes-media-'));
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-player-routes-cache-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.HLS_CACHE_DIR = cacheRoot;
  process.env.PLAYER_SESSION = 'true';
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(4096));
  await fs.writeFile(path.join(mediaRoot, FILENAME_B), Buffer.alloc(4096));
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
  delete process.env.HLS_CACHE_DIR;
  delete process.env.PLAYER_SESSION;
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
  setPlayerInstanceManagerForTests(null);
  setIdentityResolverForTests(null);
});

interface FakeOptions {
  maxConcurrentPlayers?: number;
  maxPlayersPerIp?: number;
}

async function setupFakes(opts: FakeOptions = {}): Promise<{
  hlsMgr: HlsSessionManager;
  playerMgr: PlayerInstanceManager;
}> {
  const spawnFn: HlsSpawn = (_cmd, args) => {
    const playlist = args[args.length - 1] ?? '';
    const cacheDir = path.dirname(playlist);
    setTimeout(() => {
      fs.writeFile(
        path.join(cacheDir, 'index.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXTINF:6.0,\nseg-00000.ts\n#EXT-X-ENDLIST\n',
      ).catch(() => undefined);
      fs.writeFile(path.join(cacheDir, 'seg-00000.ts'), Buffer.from('fake-ts-bytes')).catch(
        () => undefined,
      );
    }, 30);
    return fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
  };
  const hlsMgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
  setHlsSessionManagerForTests(hlsMgr);
  const playerMgr = new PlayerInstanceManager({
    hlsSessionManager: hlsMgr,
    cacheRoot,
    gcIntervalMs: 0,
    maxConcurrentPlayers: opts.maxConcurrentPlayers ?? 3,
    maxPlayersPerIp: opts.maxPlayersPerIp ?? 1,
  });
  setPlayerInstanceManagerForTests(playerMgr);
  return { hlsMgr, playerMgr };
}

class FixedIpResolver implements IdentityResolver {
  constructor(private readonly ip: string) {}
  resolve(): Identity {
    return { kind: 'ip', value: this.ip };
  }
}

const PID = '00000000-0000-4000-8000-000000000001';
const PID2 = '00000000-0000-4000-8000-000000000002';

describe('player routes', () => {
  it('POST /open returns a bundle with sessionId, encodedWindow, and metadata', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        playerId: string;
        reused: boolean;
        session: { sessionId: string; playlistUrl: string; encodedWindow: { from: number; to: number } };
        metadata: { durationSeconds: number };
      };
      expect(body.playerId).toBe(PID);
      expect(body.reused).toBe(false);
      expect(body.session.sessionId).toMatch(/[a-f0-9-]{8,}/i);
      expect(body.session.playlistUrl).toContain('master.m3u8');
      expect(body.metadata.durationSeconds).toBe(1200);
    } finally {
      await app.close();
    }
  });

  it('per-IP single-player default: second /open from same IP reuses playerId with reused=true', async () => {
    await setupFakes({ maxPlayersPerIp: 1 });
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID2}/open`,
        payload: { relPath: FILENAME_B },
      });
      expect(r2.statusCode).toBe(200);
      const body = r2.json() as { playerId: string; reused: boolean };
      expect(body.playerId).toBe(PID);
      expect(body.reused).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('global cap returns 503 capacity_exceeded with kind:global', async () => {
    await setupFakes({ maxConcurrentPlayers: 1, maxPlayersPerIp: 1 });
    let counter = 0;
    setIdentityResolverForTests({
      resolve: () => ({ kind: 'ip', value: `10.0.0.${counter++}` }),
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID2}/open`,
        payload: { relPath: FILENAME },
      });
      expect(r2.statusCode).toBe(503);
      const body = r2.json() as { error: string; kind: string; limit: number };
      expect(body.error).toBe('capacity_exceeded');
      expect(body.kind).toBe('global');
      expect(body.limit).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('per-IP cap with MAX_PLAYERS_PER_IP > 1 returns 503 capacity_exceeded with kind:per_ip', async () => {
    await setupFakes({ maxConcurrentPlayers: 5, maxPlayersPerIp: 2 });
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID2}/open`,
        payload: { relPath: FILENAME_B },
      });
      const PID3 = '00000000-0000-4000-8000-000000000003';
      const r3 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID3}/open`,
        payload: { relPath: FILENAME },
      });
      expect(r3.statusCode).toBe(503);
      const body = r3.json() as { error: string; kind: string };
      expect(body.error).toBe('capacity_exceeded');
      expect(body.kind).toBe('per_ip');
    } finally {
      await app.close();
    }
  });

  it('/seek with target inside the encoded window returns mode:reuse', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      const open = r1.json() as { session: { encodedWindow: { from: number; to: number } } };
      // The fake playlist has one segment of 6s starting at 0, so the window
      // is [0, 6]. Target 3 lands inside.
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/seek`,
        payload: { absoluteSeconds: 3 },
      });
      expect(r2.statusCode).toBe(200);
      const body = r2.json() as {
        mode: string;
        action: { kind: string; localSeconds?: number };
      };
      expect(body.mode).toBe('reuse');
      expect(body.action.kind).toBe('set-current-time');
      expect(body.action.localSeconds).toBeCloseTo(3 - open.session.encodedWindow.from, 5);
    } finally {
      await app.close();
    }
  });

  it('/seek with target far past the encoded head returns mode:respawn', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/seek`,
        payload: { absoluteSeconds: 600 },
      });
      expect(r2.statusCode).toBe(200);
      const body = r2.json() as { mode: string; action: { kind: string } };
      expect(body.mode).toBe('respawn');
      expect(body.action.kind).toBe('reattach');
    } finally {
      await app.close();
    }
  });

  it('/state returns alive + encodedWindow', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      const r = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/state`,
        payload: { currentLocalSeconds: 1.5, paused: false },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { status: string; encodedWindow: { from: number; to: number }; encodePaused: boolean };
      expect(body.status).toBe('alive');
      expect(body.encodedWindow.to).toBeGreaterThan(0);
      expect(body.encodePaused).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('/state on an unknown playerId returns 410 gone', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/state`,
        payload: { currentLocalSeconds: 0, paused: true },
      });
      expect(r.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/player/:id is idempotent', async () => {
    await setupFakes();
    setIdentityResolverForTests(new FixedIpResolver('10.0.0.5'));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      const r1 = await app.inject({ method: 'DELETE', url: `/api/player/${PID}` });
      expect(r1.statusCode).toBe(204);
      const r2 = await app.inject({ method: 'DELETE', url: `/api/player/${PID}` });
      expect(r2.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it('different identities cannot read each other\'s players (404)', async () => {
    await setupFakes({ maxConcurrentPlayers: 5, maxPlayersPerIp: 1 });
    let resolveAs = '10.0.0.5';
    setIdentityResolverForTests({
      resolve: () => ({ kind: 'ip', value: resolveAs }),
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      resolveAs = '10.0.0.6';
      const r = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/seek`,
        payload: { absoluteSeconds: 5 },
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('Identity resolver is swappable: a user-keyed resolver makes the cap apply per-user', async () => {
    await setupFakes({ maxConcurrentPlayers: 5, maxPlayersPerIp: 1 });
    let resolveIp = '10.0.0.5';
    setIdentityResolverForTests({
      // Two different IPs but same userId — both should resolve to the
      // SAME identity, so the per-identity cap should kick in.
      resolve: () => ({ kind: 'user', userId: 'alice', ip: resolveIp }),
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID}/open`,
        payload: { relPath: FILENAME },
      });
      expect(r1.statusCode).toBe(200);
      resolveIp = '10.0.0.6';
      const r2 = await app.inject({
        method: 'POST',
        url: `/api/player/${PID2}/open`,
        payload: { relPath: FILENAME_B },
      });
      // Same user; per-user cap = 1 (default) → media-swap onto PID with reused:true.
      expect(r2.statusCode).toBe(200);
      const body = r2.json() as { reused: boolean; playerId: string };
      expect(body.reused).toBe(true);
      expect(body.playerId).toBe(PID);
    } finally {
      await app.close();
    }
  });
});
