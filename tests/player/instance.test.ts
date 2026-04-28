import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  PlayerInstanceManager,
  CapacityExceededError,
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
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-pim-'));
  const spawnFn: HlsSpawn = (_cmd, args) => {
    const playlist = args[args.length - 1] ?? '';
    const dir = path.dirname(playlist);
    // Wrapped in a swallow because the cache dir may be wiped before the
    // timeout fires (test teardown races the fake encoder).
    setTimeout(() => {
      fs.writeFile(
        path.join(dir, 'index.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\nseg-00000.ts\n#EXT-X-ENDLIST\n',
      ).catch(() => undefined);
    }, 5);
    return fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
  };
  hlsMgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
});

afterEach(async () => {
  await hlsMgr.shutdownAll();
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

const ip = (v: string): Identity => ({ kind: 'ip', value: v });

async function spawn(mgr: HlsSessionManager) {
  return mgr.getOrCreate(
    {
      relPath: 'movie.mkv',
      absPath: '/m/movie.mkv',
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'matroska,webm',
    },
    {},
  );
}

describe('PlayerInstanceManager', () => {
  it('canOpen returns allowed when no players exist', () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    expect(m.canOpen(ip('10.0.0.5'))).toEqual({ kind: 'allowed' });
  });

  it('per-IP single-player default returns media-swap on second open', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    const opened = await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(opened.reused).toBe(false);
    expect(m.canOpen(ip('10.0.0.5'))).toEqual({ kind: 'media-swap', playerId: 'p1' });
  });

  it('opens a second player when MAX_PLAYERS_PER_IP > 1', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 3,
    });
    await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(m.canOpen(ip('10.0.0.5'))).toEqual({ kind: 'allowed' });
    await m.open({
      playerId: 'p2',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(m.countForIdentity(ip('10.0.0.5'))).toBe(2);
  });

  it('rejects with global-busy when MAX_CONCURRENT_PLAYERS hit by different IPs', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 2,
      maxPlayersPerIp: 1,
    });
    await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    await m.open({
      playerId: 'p2',
      identity: ip('10.0.0.6'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    const r = m.canOpen(ip('10.0.0.7'));
    expect(r.kind).toBe('global-busy');
  });

  it('throws CapacityExceededError when global cap is hit', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 1,
      maxPlayersPerIp: 1,
    });
    await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    await expect(
      m.open({
        playerId: 'p2',
        identity: ip('10.0.0.6'),
        relPath: 'movie.mkv',
        spawn: () => spawn(hlsMgr),
      }),
    ).rejects.toBeInstanceOf(CapacityExceededError);
  });

  it('media-swap reuses the same playerId and retires the old session', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    const a = await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'a.mkv',
      spawn: () => spawn(hlsMgr),
    });
    const oldSessionId = a.player.activeSession!.id;
    // Second /open from same identity but with a fresh playerId.
    const b = await m.open({
      playerId: 'p2-fresh',
      identity: ip('10.0.0.5'),
      relPath: 'b.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(b.reused).toBe(true);
    expect(b.player.playerId).toBe('p1');
    expect(b.player.activeSession!.id).not.toBe(oldSessionId);
    expect(m.liveCount()).toBe(1);
  });

  it('close removes the player entry and frees the slot', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 1,
      maxPlayersPerIp: 1,
    });
    await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(m.liveCount()).toBe(1);
    await m.close('p1');
    expect(m.liveCount()).toBe(0);
    expect(m.canOpen(ip('10.0.0.6'))).toEqual({ kind: 'allowed' });
  });

  it('ownedBy enforces identity match', async () => {
    const m = new PlayerInstanceManager({
      hlsSessionManager: hlsMgr,
      cacheRoot,
      gcIntervalMs: 0,
      maxConcurrentPlayers: 3,
      maxPlayersPerIp: 1,
    });
    await m.open({
      playerId: 'p1',
      identity: ip('10.0.0.5'),
      relPath: 'movie.mkv',
      spawn: () => spawn(hlsMgr),
    });
    expect(m.ownedBy('p1', ip('10.0.0.5'))).toBeTruthy();
    expect(m.ownedBy('p1', ip('10.0.0.6'))).toBeUndefined();
  });
});
