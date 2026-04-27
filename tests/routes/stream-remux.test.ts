import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

let mediaRoot: string;
const FILENAME = 'The Bear/S01E01.mkv';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-stream-remux-'));
  await fs.mkdir(path.join(mediaRoot, 'The Bear'), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(2048));
  await fs.writeFile(path.join(mediaRoot, 'The Bear', 'S01E01.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.OMDB_API_KEY = '';
  process.env.TVDB_API_KEY = '';
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.resetModules();
  const { openDb, setDb } = await import('../../src/db.js');
  setDb(openDb(':memory:'));
  process.env.MEDIA_ROOT = mediaRoot;
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
});

describe('stream route — probe + 415 + remux', () => {
  it('caches the probe result on first request and skips ffprobe on subsequent ones', async () => {
    // Scanner-created rows are what backs the probe cache (the migration adds
    // `probe_json` to media_items / episodes). Pre-create a series + episode row.
    const { getDb } = await import('../../src/db.js');
    const db = getDb();
    const series = db.upsertItem({
      path: 'The Bear',
      type: 'series',
      tmdb_id: 86831,
      title: 'The Bear',
      year: 2022,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1,
    });
    db.upsertEpisode({
      series_id: series.id,
      path: FILENAME,
      season: 1,
      episode: 1,
      title: null,
      overview: null,
      still_url: null,
      mtime: 1,
      scanned_at: 1,
    });

    const probeMod = await import('../../src/probe.js');
    const probeSpy = vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1547.2,
      // v2 shape (0.1.4.3) — without these fields the route's lazy-upgrade
      // gate would re-probe on the second request.
      audioStreams: [],
      subStreams: [],
      chapters: [],
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res1.statusCode).toBe(415);
      expect(probeSpy).toHaveBeenCalledTimes(1);

      const res2 = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res2.statusCode).toBe(415);
      expect(probeSpy).toHaveBeenCalledTimes(1); // still 1 — cached
    } finally {
      await app.close();
      probeSpy.mockRestore();
    }
  });

  it('returns 415 with { decision: "remux", subs: [...] } for an MKV+H264+AAC file', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1547.2,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(415);
      const body = res.json() as { decision: string; subs: Array<{ path: string; lang: string | null }> };
      expect(body.decision).toBe('remux');
      expect(body.subs.length).toBeGreaterThanOrEqual(1);
      expect(body.subs.some((s) => s.path.endsWith('S01E01.en.srt') && s.lang === 'en')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 415 with { decision: "external" } when codecs are outside both allowlists', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'mpeg2video',
      audioCodec: 'wmav2',
      durationSeconds: 1547.2,
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(415);
      expect((res.json() as { decision: string }).decision).toBe('external');
    } finally {
      await app.close();
    }
  });

  it('Xvid (mpeg4) → 415 with decision:remux + preferAccel:nvenc (skip-the-remux hint)', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'avi',
      videoCodec: 'mpeg4',
      audioCodec: 'mp3',
      durationSeconds: 1320,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(415);
      const body = res.json() as { decision: string; preferAccel?: string; videoCodec?: string };
      expect(body.decision).toBe('remux');
      expect(body.videoCodec).toBe('mpeg4');
      expect(body.preferAccel).toBe('nvenc');
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('Xvid + NVENC unavailable → 415 with decision:remux but no preferAccel (no hint to skip)', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'avi',
      videoCodec: 'mpeg4',
      audioCodec: 'mp3',
      durationSeconds: 1320,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: false, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(415);
      const body = res.json() as { decision: string; preferAccel?: string };
      expect(body.decision).toBe('remux');
      expect(body.preferAccel).toBeUndefined();
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('HEVC + NVENC available → no preferAccel (HEVC plays natively on Mac/Safari, only Windows falls back)', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'hevc',
      audioCodec: 'aac',
      durationSeconds: 1547.2,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(415);
      const body = res.json() as { decision: string; preferAccel?: string };
      expect(body.decision).toBe('remux');
      // HEVC is opportunistic, not transcode-required — frontend should try
      // the remux first and fall back only on actual <video> error.
      expect(body.preferAccel).toBeUndefined();
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('remux pipeline transcodes AC3 audio inline (-c:a aac) while copying video', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'ac3', durationSeconds: 100,
    });

    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held */ } });
    stdout.push(Buffer.from([0x00]));
    const stderr = new Readable({ read() { this.push(null); } });
    let spawnArgs: ReadonlyArray<string> = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) { this.killed = true; stdout.push(null); queueMicrotask(() => fakeChild.emit('exit', 0)); return true; },
    }) as unknown as FakeFf;

    const { setRemuxSpawnForTests } = await import('../../src/streaming.js');
    setRemuxSpawnForTests((_cmd, args) => {
      spawnArgs = args;
      return fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + '?remux=true' },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.once('data', () => {
              expect(spawnArgs).toContain('-c:v');
              expect(spawnArgs).toContain('copy');
              expect(spawnArgs).toContain('-c:a');
              expect(spawnArgs).toContain('aac');
              req.destroy();
              resolve();
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
    } finally {
      setRemuxSpawnForTests(null);
      await app.close();
    }
  });

  it('remux pipeline copies AAC audio (-c:a copy) without transcoding', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100,
    });

    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held */ } });
    stdout.push(Buffer.from([0x00]));
    const stderr = new Readable({ read() { this.push(null); } });
    let spawnArgs: ReadonlyArray<string> = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) { this.killed = true; stdout.push(null); queueMicrotask(() => fakeChild.emit('exit', 0)); return true; },
    }) as unknown as FakeFf;

    const { setRemuxSpawnForTests } = await import('../../src/streaming.js');
    setRemuxSpawnForTests((_cmd, args) => {
      spawnArgs = args;
      return fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + '?remux=true' },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.once('data', () => {
              // Audio should be copied, not transcoded.
              const aIdx = spawnArgs.indexOf('-c:a');
              expect(aIdx).toBeGreaterThan(-1);
              expect(spawnArgs[aIdx + 1]).toBe('copy');
              expect(spawnArgs).not.toContain('aac');
              req.destroy();
              resolve();
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
    } finally {
      setRemuxSpawnForTests(null);
      await app.close();
    }
  });

  it('runs remux() with ?remux=true; client disconnect kills ffmpeg', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 100,
    });

    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held until kill */ } });
    stdout.push(Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const stderr = new Readable({ read() { this.push(null); } });
    let killCalled = false;
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) {
        killCalled = true;
        this.killed = true;
        stdout.push(null);
        queueMicrotask(() => fakeChild.emit('exit', 0, _sig));
        return true;
      },
    }) as unknown as FakeFf;

    const { setRemuxSpawnForTests, liveRemuxCount } = await import('../../src/streaming.js');
    setRemuxSpawnForTests(() =>
      fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams,
    );

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    // Boot a real listener so the OS-level socket close path fires reply.raw 'close'.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + '?remux=true' },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('video/mp4');
            res.once('data', () => {
              // Got bytes — abort to simulate tab close.
              req.destroy();
              resolve();
            });
            res.once('error', () => resolve());
          },
        );
        req.on('error', () => resolve()); // destroy triggers ECONNRESET — that's fine
        req.end();
        setTimeout(() => reject(new Error('request timeout')), 4000).unref();
      });

      // Allow the close handler chain to run.
      await new Promise((r) => setTimeout(r, 100));
      expect(killCalled).toBe(true);
      expect(liveRemuxCount()).toBe(0);
    } finally {
      setRemuxSpawnForTests(null);
      await app.close();
    }
  });

  it('?accel=nvenc returns 415 when NVENC is unavailable', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100,
    });

    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: false, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream/' + encodeURIComponent(FILENAME) + '?accel=nvenc',
      });
      expect(res.statusCode).toBe(415);
      expect((res.json() as { error: string }).error).toBe('nvenc_unavailable');
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('?accel=nvenc spawns the NVENC transcode pipeline when available', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100,
    });

    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held */ } });
    stdout.push(Buffer.from([0x00]));
    const stderr = new Readable({ read() { this.push(null); } });
    let spawnArgs: ReadonlyArray<string> = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) { this.killed = true; stdout.push(null); queueMicrotask(() => fakeChild.emit('exit', 0)); return true; },
    }) as unknown as FakeFf;

    const { setRemuxSpawnForTests } = await import('../../src/streaming.js');
    setRemuxSpawnForTests((_cmd, args) => {
      spawnArgs = args;
      return fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + '?accel=nvenc' },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('video/mp4');
            res.once('data', () => {
              // Confirm we're invoking NVENC, not the plain remux.
              expect(spawnArgs).toContain('h264_nvenc');
              expect(spawnArgs).toContain('cuda');
              req.destroy();
              resolve();
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
    } finally {
      setRemuxSpawnForTests(null);
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  /** Drive a single remux request through the live HTTP layer and capture the
   *  ffmpeg argv. Centralises the FakeFf + spawn-spy + http.request boilerplate
   *  used by the seek-arg tests below. */
  async function captureRemuxArgs(query: string): Promise<ReadonlyArray<string>> {
    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held */ } });
    stdout.push(Buffer.from([0x00]));
    const stderr = new Readable({ read() { this.push(null); } });
    let spawnArgs: ReadonlyArray<string> = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) { this.killed = true; stdout.push(null); queueMicrotask(() => fakeChild.emit('exit', 0)); return true; },
    }) as unknown as FakeFf;

    const { setRemuxSpawnForTests } = await import('../../src/streaming.js');
    setRemuxSpawnForTests((_cmd, args) => {
      spawnArgs = args;
      return fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + query },
          (res) => {
            res.once('data', () => { req.destroy(); resolve(); });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
    } finally {
      setRemuxSpawnForTests(null);
      await app.close();
    }
    return spawnArgs;
  }

  it('?start=0 omits both -ss flags so ffmpeg streams from the beginning', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100,
    });
    const args = await captureRemuxArgs('?remux=true&start=0');
    expect(args).not.toContain('-ss');
  });

  it('?start within SEEK_LEAD_SECONDS uses output-side -ss only (no input-side jump)', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100,
    });
    const args = await captureRemuxArgs('?remux=true&start=3');
    const inputIdx = args.indexOf('-i');
    const ssIndices = args
      .map((a, i) => (a === '-ss' ? i : -1))
      .filter((i) => i >= 0);
    expect(ssIndices).toHaveLength(1);
    expect(ssIndices[0]).toBeGreaterThan(inputIdx);
    expect(args[ssIndices[0]! + 1]).toBe('3');
  });

  it('?start past lead uses split seek: input-side jump + output-side fine align', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 3000,
    });
    const args = await captureRemuxArgs('?remux=true&start=1825');
    const inputIdx = args.indexOf('-i');
    const ssIndices = args
      .map((a, i) => (a === '-ss' ? i : -1))
      .filter((i) => i >= 0);
    expect(ssIndices).toHaveLength(2);
    // First -ss is BEFORE -i (input seek to target - 5s = 1820)
    expect(ssIndices[0]).toBeLessThan(inputIdx);
    expect(args[ssIndices[0]! + 1]).toBe('1820');
    // Second -ss is AFTER -i (output seek of the remaining 5s lead)
    expect(ssIndices[1]).toBeGreaterThan(inputIdx);
    expect(args[ssIndices[1]! + 1]).toBe('5');
  });

  it('EAC3 → AAC transcode includes the aresample async filter to lock A/V sync', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'eac3', durationSeconds: 2200,
    });
    const args = await captureRemuxArgs('?remux=true&start=1825');
    expect(args).toContain('-af');
    const afIdx = args.indexOf('-af');
    expect(args[afIdx + 1]).toMatch(/aresample=async=1/);
  });

  it('-c:a copy path does NOT include the -af filter (filters require re-encode)', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100,
    });
    const args = await captureRemuxArgs('?remux=true&start=10');
    expect(args).not.toContain('-af');
  });

  it('killAllRemuxProcesses() kills tracked ffmpegs (server shutdown path)', async () => {
    interface FakeFf extends EventEmitter {
      stdout: Readable;
      stderr: Readable;
      kill: (sig: NodeJS.Signals) => boolean;
      killed: boolean;
    }
    const stdout = new Readable({ read() { /* held */ } });
    stdout.push(Buffer.from([0]));
    const stderr = new Readable({ read() { this.push(null); } });
    let killed = false;
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout, stderr, killed: false,
      kill(_sig: NodeJS.Signals) { killed = true; this.killed = true; stdout.push(null); queueMicrotask(() => fakeChild.emit('exit', 0)); return true; },
    }) as unknown as FakeFf;

    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100,
    });

    const { setRemuxSpawnForTests, killAllRemuxProcesses, liveRemuxCount } =
      await import('../../src/streaming.js');
    setRemuxSpawnForTests(() => fakeChild as unknown as import('node:child_process').ChildProcessWithoutNullStreams);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/stream/' + encodeURIComponent(FILENAME) + '?remux=true' },
          (res) => {
            res.once('data', () => {
              expect(liveRemuxCount()).toBe(1);
              killAllRemuxProcesses();
              expect(killed).toBe(true);
              expect(liveRemuxCount()).toBe(0);
              req.destroy();
              resolve();
            });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
    } finally {
      setRemuxSpawnForTests(null);
      await app.close();
    }
  });
});
