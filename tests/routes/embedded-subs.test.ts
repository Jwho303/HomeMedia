import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

let mediaRoot: string;
let cacheRoot: string;
const FILENAME = 'movie.mkv';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-embsubs-'));
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-embsubs-cache-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.CACHE_DIR = cacheRoot;
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(64));
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

interface FakeFf extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

function makeFakeFfmpeg(stdout: string, exitCode = 0): {
  spawn: (cmd: string, args: ReadonlyArray<string>) => unknown;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn();
  const spawn = (cmd: string, args: ReadonlyArray<string>): unknown => {
    spy(cmd, args);
    const child = new EventEmitter() as FakeFf;
    child.stdout = Readable.from([Buffer.from(stdout, 'utf8')]);
    child.stderr = Readable.from(['']);
    queueMicrotask(() => {
      child.stdout.on('end', () => {
        queueMicrotask(() => child.emit('close', exitCode));
      });
      child.stdout.resume();
      child.stderr.resume();
    });
    return child;
  };
  return { spawn, spy };
}

describe('GET /api/embedded-subs/*', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Fresh cache dir per test so a prior test's cached blob can't satisfy
    // a request that should be a miss.
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-embsubs-cache-'));
    const { openDb, setDb } = await import('../../src/db.js');
    const db = openDb(':memory:');
    setDb(db);
    process.env.MEDIA_ROOT = mediaRoot;
    process.env.CACHE_DIR = cacheRoot;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    // Seed: one media_items row + a probe blob with one text-based sub stream
    // and one image-based stream.
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES ('movie.mkv', 'movie', 1, 'Movie', 2020, NULL, NULL, NULL, 0, 0)`,
      )
      .run();
    db.setProbe('movie.mkv', {
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 60,
      audioStreams: [],
      subStreams: [
        {
          index: 3,
          subIndex: 0,
          codec: 'subrip',
          language: 'eng',
          title: null,
          default: true,
          forced: false,
          textBased: true,
        },
        {
          index: 4,
          subIndex: 1,
          codec: 'pgs',
          language: 'eng',
          title: null,
          default: false,
          forced: false,
          textBased: false,
        },
      ],
      chapters: [],
    });
  });

  it('extracts a text-based sub stream and serves valid WebVTT', async () => {
    const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
    const { spawn, spy } = makeFakeFfmpeg(VTT);
    const { setEmbeddedSubsSpawnForTests } = await import('../../src/routes/embedded-subs.js');
    setEmbeddedSubsSpawnForTests(spawn as never);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/embedded-subs/${encodeURIComponent(FILENAME)}?stream=3`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/vtt/);
      expect(res.payload).toContain('WEBVTT');
      // ffmpeg called with -map 0:s:0 (local sub index for global idx 3).
      expect(spy).toHaveBeenCalledOnce();
      const calledArgs = spy.mock.calls[0]![1] as ReadonlyArray<string>;
      expect(calledArgs).toContain('-map');
      expect(calledArgs).toContain('0:s:0');
      expect(calledArgs).toContain('webvtt');
    } finally {
      setEmbeddedSubsSpawnForTests(null);
      await app.close();
    }
  });

  it('second fetch is served from disk cache (no ffmpeg respawn)', async () => {
    const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCached\n';
    const { spawn, spy } = makeFakeFfmpeg(VTT);
    const { setEmbeddedSubsSpawnForTests } = await import('../../src/routes/embedded-subs.js');
    setEmbeddedSubsSpawnForTests(spawn as never);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const url = `/api/embedded-subs/${encodeURIComponent(FILENAME)}?stream=3`;
      const r1 = await app.inject({ method: 'GET', url });
      expect(r1.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
      const r2 = await app.inject({ method: 'GET', url });
      expect(r2.statusCode).toBe(200);
      // ffmpeg only ran once.
      expect(spy).toHaveBeenCalledOnce();
      expect(r2.payload).toContain('WEBVTT');
    } finally {
      setEmbeddedSubsSpawnForTests(null);
      await app.close();
    }
  });

  it('rejects an image-based sub stream with 415', async () => {
    const { setEmbeddedSubsSpawnForTests } = await import('../../src/routes/embedded-subs.js');
    setEmbeddedSubsSpawnForTests(null);

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/embedded-subs/${encodeURIComponent(FILENAME)}?stream=4`,
      });
      expect(res.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when stream index is not in the probe', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/embedded-subs/${encodeURIComponent(FILENAME)}?stream=99`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
