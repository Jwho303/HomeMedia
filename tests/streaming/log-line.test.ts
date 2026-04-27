import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

let mediaRoot: string;
const FILENAME = 'show/S01E01.mkv';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-pipeline-log-'));
  await fs.mkdir(path.join(mediaRoot, 'show'), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(2048));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
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

interface FakeFf extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: (sig: NodeJS.Signals) => boolean;
  killed: boolean;
}

function makeFakeFf(): FakeFf {
  const stdout = new Readable({ read() { /* held */ } });
  stdout.push(Buffer.from([0x00]));
  const stderr = new Readable({ read() { this.push(null); } });
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout, stderr, killed: false,
    kill(_sig: NodeJS.Signals) {
      this.killed = true;
      stdout.push(null);
      queueMicrotask(() => fakeChild.emit('exit', 0));
      return true;
    },
  }) as unknown as FakeFf;
  return fakeChild;
}

describe('runPipeline emits exactly one structured pipeline.spawn log line', () => {
  it('logs profile name + ffmpeg args + source codec/container at info level', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'hevc',
      audioCodec: 'aac',
      durationSeconds: 1547,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    const fake = makeFakeFf();
    const { setRemuxSpawnForTests } = await import('../../src/streaming.js');
    setRemuxSpawnForTests(() =>
      fake as unknown as import('node:child_process').ChildProcessWithoutNullStreams,
    );

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();

    // Capture info-level log entries via Pino's child logger interface.
    const captured: Array<Record<string, unknown>> = [];
    const origInfo = app.log.info.bind(app.log);
    // Replace log.info on each request's logger by hooking the request log.
    app.addHook('onRequest', async (req) => {
      const origReqInfo = req.log.info.bind(req.log);
      req.log.info = ((...args: unknown[]) => {
        // Pino: (obj, msg) or (msg). Capture the obj-form.
        if (args.length >= 1 && typeof args[0] === 'object' && args[0] !== null) {
          captured.push(args[0] as Record<string, unknown>);
        }
        return origReqInfo(...(args as Parameters<typeof origReqInfo>));
      }) as typeof req.log.info;
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const http = await import('node:http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/stream/' + encodeURIComponent(FILENAME) + '?accel=nvenc',
          },
          (res) => {
            res.once('data', () => { req.destroy(); resolve(); });
            res.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
        req.end();
      });

      await new Promise((r) => setTimeout(r, 50));

      const spawnLogs = captured.filter((e) => (e as { evt?: string }).evt === 'pipeline.spawn');
      expect(spawnLogs.length).toBe(1);
      const entry = spawnLogs[0]!;
      expect(entry.relPath).toBe(FILENAME);
      const decision = entry.decision as Record<string, unknown>;
      expect(decision.profile).toBe('nvenc-modern');
      expect(decision.accel).toBe('nvenc');
      expect(decision.audioStrategy).toBe('copy');
      expect(decision.seekStrategy).toBe('fresh');
      const source = entry.source as Record<string, unknown>;
      expect(source.container).toBe('matroska,webm');
      expect(source.videoCodec).toBe('hevc');
      const args = entry.ffmpegArgs as string[];
      expect(args).toContain('h264_nvenc');
      expect(args).toContain('cuda');
      void origInfo;
    } finally {
      setRemuxSpawnForTests(null);
      setCachedEncodersForTests(null);
      await app.close();
    }
  });
});
