import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HlsSessionManager, type HlsSpawn } from '../../src/streaming/hls-session.js';

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

beforeEach(async () => {
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-hls-test-'));
});

afterEach(async () => {
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

describe('HlsSessionManager', () => {
  it('spawns one ffmpeg per unique key, reuses on second request', async () => {
    let spawnCount = 0;
    const spawnFn: HlsSpawn = () => {
      spawnCount++;
      return fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
    };
    const mgr = new HlsSessionManager({
      spawn: spawnFn,
      cacheRoot,
      gcIntervalMs: 0,
    });

    const a = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      { startSeconds: 0 },
    );
    const b = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      { startSeconds: 0 },
    );
    expect(spawnCount).toBe(1);
    expect(a.id).toBe(b.id);
    await mgr.shutdownAll();
  });

  it('different start times → different sessions', async () => {
    const spawnFn: HlsSpawn = () => fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
    const mgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });

    const a = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      { startSeconds: 0 },
    );
    const b = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      { startSeconds: 600 },
    );
    expect(a.id).not.toBe(b.id);
    await mgr.shutdownAll();
  });

  it('GC kills sessions that have not been touched in idleMs', async () => {
    let now = 1_000_000;
    const spawnFn: HlsSpawn = () => fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
    const mgr = new HlsSessionManager({
      spawn: spawnFn,
      cacheRoot,
      now: () => now,
      idleMs: 60_000,
      gcIntervalMs: 0,
    });

    const session = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      {},
    );
    expect(mgr.liveCount()).toBe(1);
    // Advance time past idle window.
    now += 90_000;
    mgr.gcIdle();
    // disposeSession is async — wait a tick.
    await new Promise((r) => setImmediate(r));
    expect(mgr.liveCount()).toBe(0);
    expect(session.state).toBe('killed');
  });

  it('delete() kills session and removes cache dir', async () => {
    const spawnFn: HlsSpawn = () => fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
    const mgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });

    const session = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      {},
    );
    // Drop a fake segment so we can verify the dir vanishes.
    await fs.writeFile(path.join(session.cacheDir, 'seg-00000.ts'), 'x');
    expect((await fs.readdir(session.cacheDir)).length).toBe(1);
    const ok = await mgr.delete(session.id);
    expect(ok).toBe(true);
    await expect(fs.access(session.cacheDir)).rejects.toBeTruthy();
  });

  it('waitForPlaylist returns true once index.m3u8 appears', async () => {
    const spawnFn: HlsSpawn = () => fakeFFmpeg() as unknown as ReturnType<HlsSpawn>;
    const mgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
    const session = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      {},
    );
    // Schedule playlist creation a moment later.
    setTimeout(() => {
      void fs.writeFile(path.join(session.cacheDir, 'index.m3u8'), '#EXTM3U\n');
    }, 50);
    const ok = await mgr.waitForPlaylist(session.id, 1000);
    expect(ok).toBe(true);
    await mgr.shutdownAll();
  });

  it('waitForPlaylist returns false on errored session', async () => {
    const ff = fakeFFmpeg();
    const spawnFn: HlsSpawn = () => ff as unknown as ReturnType<HlsSpawn>;
    const mgr = new HlsSessionManager({ spawn: spawnFn, cacheRoot, gcIntervalMs: 0 });
    const session = await mgr.getOrCreate(
      {
        relPath: 'show/ep1.mkv',
        absPath: '/m/show/ep1.mkv',
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'matroska,webm',
      },
      {},
    );
    // Simulate ffmpeg dying immediately.
    setImmediate(() => ff.emit('exit', 1, null));
    const ok = await mgr.waitForPlaylist(session.id, 500);
    expect(ok).toBe(false);
    await mgr.shutdownAll();
  });

  it('cleanupOrphans removes leftover dirs in the cache root', async () => {
    await fs.mkdir(path.join(cacheRoot, 'orphan-1'), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, 'orphan-2'), { recursive: true });
    await fs.writeFile(path.join(cacheRoot, 'orphan-1', 'seg-00000.ts'), 'x');
    const mgr = new HlsSessionManager({ cacheRoot, gcIntervalMs: 0 });
    await mgr.cleanupOrphans();
    const remaining = await fs.readdir(cacheRoot);
    expect(remaining).toEqual([]);
    await mgr.shutdownAll();
  });
});
