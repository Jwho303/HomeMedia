import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mediaRoot: string;
const FILENAME = 'Sunny/S04E01.avi';

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-stream-diag-'));
  await fs.mkdir(path.join(mediaRoot, 'Sunny'), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, FILENAME), Buffer.alloc(2048));
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

describe('GET /api/stream-diagnostics — read-only profile + ffmpeg args dump', () => {
  it('Xvid AVI returns the nvenc-legacy-avi profile with full Xvid arg set', async () => {
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
        url: '/api/stream-diagnostics/' + encodeURIComponent(FILENAME),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        decision: string;
        profile: { name: string; accel: string | null; audioStrategy: string } | null;
        ffmpegArgs: string[] | null;
        encoderCaps: { nvenc: boolean };
      };
      expect(body.decision).toBe('remux');
      expect(body.profile?.name).toBe('nvenc-legacy-avi');
      expect(body.profile?.accel).toBe('nvenc');
      expect(body.profile?.audioStrategy).toBe('transcode');
      expect(body.ffmpegArgs).toBeTruthy();
      expect(body.ffmpegArgs).toContain('-re');
      expect(body.ffmpegArgs).toContain('mpeg4_unpack_bframes');
      expect(body.encoderCaps.nvenc).toBe(true);
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('HEVC MKV returns the nvenc-modern profile WITHOUT -re or +genpts', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'hevc',
      audioCodec: 'aac',
      durationSeconds: 1547,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      // Use a path that exists in our temp media root.
      await fs.writeFile(path.join(mediaRoot, 'CSE.S04E01.mkv'), Buffer.alloc(2048));
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream-diagnostics/CSE.S04E01.mkv',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        profile: { name: string } | null;
        ffmpegArgs: string[] | null;
      };
      expect(body.profile?.name).toBe('nvenc-modern');
      expect(body.ffmpegArgs).toBeTruthy();
      expect(body.ffmpegArgs).not.toContain('-re');
      expect(body.ffmpegArgs).not.toContain('+genpts');
      expect(body.ffmpegArgs).not.toContain('mpeg4_unpack_bframes');
      // 10-bit HEVC sources (Main 10, p010le) need a GPU-side pixel-format
      // conversion — pinning -pix_fmt at the encoder when output is in CUDA
      // memory makes ffmpeg's auto-scaler explode. yuv420p is produced by
      // the scale_cuda filter instead.
      expect(body.ffmpegArgs).toContain('-vf');
      expect(body.ffmpegArgs).toContain('scale_cuda=format=yuv420p');
      expect(body.ffmpegArgs).not.toContain('-pix_fmt');
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('H.264 MKV returns the lean remux-modern profile', async () => {
    const probeMod = await import('../../src/probe.js');
    vi.spyOn(probeMod, 'probe').mockResolvedValue({
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'ac3',
      durationSeconds: 100,
    });
    const { setCachedEncodersForTests } = await import('../../src/encoders.js');
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await fs.writeFile(path.join(mediaRoot, 'modern.mkv'), Buffer.alloc(2048));
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream-diagnostics/modern.mkv',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        profile: { name: string; audioStrategy: string } | null;
        ffmpegArgs: string[] | null;
      };
      expect(body.profile?.name).toBe('remux-modern');
      expect(body.profile?.audioStrategy).toBe('transcode'); // ac3 → aac
      expect(body.ffmpegArgs).toBeTruthy();
      expect(body.ffmpegArgs).not.toContain('-re');
      expect(body.ffmpegArgs).not.toContain('+genpts');
      expect(body.ffmpegArgs).not.toContain('h264_nvenc');
      expect(body.ffmpegArgs).toContain('-c:v');
      expect(body.ffmpegArgs).toContain('copy');
    } finally {
      setCachedEncodersForTests(null);
      await app.close();
    }
  });

  it('returns 400 for bad path', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stream-diagnostics/' + encodeURIComponent('../escape.mkv'),
      });
      expect([400, 404]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});
