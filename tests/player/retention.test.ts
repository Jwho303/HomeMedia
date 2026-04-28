import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  PlayerInstanceManager,
  paramsHashOf,
  relPathHashOf,
} from '../../src/player/instance.js';
import {
  HlsSessionManager,
  type HlsSpawn,
} from '../../src/streaming/hls-session.js';
import type { Identity } from '../../src/identity/resolver.js';

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

let cacheRoot: string;
let hlsMgr: HlsSessionManager;

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-retention-'));
  const spawnFn: HlsSpawn = (_cmd, args) => {
    const playlist = args[args.length - 1] ?? '';
    const dir = path.dirname(playlist);
    setTimeout(() => {
      fs.writeFile(
        path.join(dir, 'index.m3u8'),
        '#EXTM3U\n#EXTINF:6.0,\nseg-00000.ts\n#EXT-X-ENDLIST\n',
      ).catch(() => undefined);
      fs.writeFile(path.join(dir, 'seg-00000.ts'), Buffer.from('ts')).catch(() => undefined);
    }, 5);
    return fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
  };
  hlsMgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
});

afterEach(async () => {
  await hlsMgr.shutdownAll();
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

const ip: Identity = { kind: 'ip', value: '10.0.0.5' };

async function spawn(opts: { cacheDir: string; keepCacheOnDispose?: boolean }) {
  return hlsMgr.getOrCreate(
    {
      relPath: 'movie.mkv',
      absPath: '/m/movie.mkv',
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'matroska,webm',
    },
    {
      cacheDir: opts.cacheDir,
      ...(opts.keepCacheOnDispose ? { keepCacheOnDispose: true } : {}),
    },
  );
}

describe('Player retention rules', () => {
  it('relPath swap wipes the previous relPath subtree', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    const opts = { audioStreamIndex: 0 };
    const aDir = m.paramsCacheDir('p1', 'a.mkv', paramsHashOf(opts));
    const bDir = m.paramsCacheDir('p1', 'b.mkv', paramsHashOf(opts));
    await m.open({
      playerId: 'p1',
      identity: ip,
      relPath: 'a.mkv',
      audioStreamIndex: 0,
      spawn: () => spawn({ cacheDir: aDir, keepCacheOnDispose: true }),
    });
    // Wait for the fake spawner to land segments.
    await new Promise((r) => setTimeout(r, 30));
    expect(await fs.stat(aDir).then(() => true).catch(() => false)).toBe(true);

    // Per-IP single-player default: media-swap.
    await m.open({
      playerId: 'p1-fresh',
      identity: ip,
      relPath: 'b.mkv',
      audioStreamIndex: 0,
      spawn: () => spawn({ cacheDir: bDir, keepCacheOnDispose: true }),
    });
    await new Promise((r) => setTimeout(r, 30));
    // The relPath subtree for 'a.mkv' under p1 should have been wiped.
    const aRelDir = path.join(cacheRoot, 'p1', relPathHashOf('a.mkv'));
    const aGone = await fs.stat(aRelDir).then(() => false).catch(() => true);
    expect(aGone).toBe(true);
  });

  it('close() wipes the entire <playerId>/ subtree', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    const opts = { audioStreamIndex: 0 };
    const aDir = m.paramsCacheDir('p1', 'a.mkv', paramsHashOf(opts));
    await m.open({
      playerId: 'p1',
      identity: ip,
      relPath: 'a.mkv',
      audioStreamIndex: 0,
      spawn: () => spawn({ cacheDir: aDir, keepCacheOnDispose: true }),
    });
    await new Promise((r) => setTimeout(r, 30));
    await m.close('p1');
    const playerDir = path.join(cacheRoot, 'p1');
    const gone = await fs.stat(playerDir).then(() => false).catch(() => true);
    expect(gone).toBe(true);
  });

  it('cleanupOrphans wipes every <playerId>/ dir at boot', async () => {
    // Scatter some orphan dirs.
    await fs.mkdir(path.join(cacheRoot, 'orphan-a'), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, 'orphan-b'), { recursive: true });
    await fs.writeFile(path.join(cacheRoot, 'orphan-a', 'seg-0.ts'), 'x');

    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
    });
    await m.cleanupOrphans();

    const a = await fs.stat(path.join(cacheRoot, 'orphan-a')).then(() => false).catch(() => true);
    const b = await fs.stat(path.join(cacheRoot, 'orphan-b')).then(() => false).catch(() => true);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('keepCacheOnDispose: HlsSessionManager.delete leaves segments on disk', async () => {
    const aDir = path.join(cacheRoot, 'p1', 'rh', 'ph');
    await fs.mkdir(aDir, { recursive: true });
    const session = await spawn({ cacheDir: aDir, keepCacheOnDispose: true });
    await new Promise((r) => setTimeout(r, 30));
    await hlsMgr.delete(session.id);
    const segStillThere = await fs
      .stat(path.join(aDir, 'seg-00000.ts'))
      .then(() => true)
      .catch(() => false);
    expect(segStillThere).toBe(true);
  });
});
