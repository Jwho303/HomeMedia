import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-prober-default');

const { openDb } = await import('../src/db.js');
const { probeFile } = await import('../src/prober.js');
import type { ProbeResult } from '../src/db.js';

function v2Result(): ProbeResult {
  return {
    container: 'matroska,webm',
    videoCodec: 'h264',
    audioCodec: 'aac',
    durationSeconds: 60,
    audioStreams: [
      {
        index: 1,
        audioIndex: 0,
        codec: 'aac',
        language: 'eng',
        title: null,
        channels: 2,
        default: true,
        forced: false,
      },
    ],
    subStreams: [],
    chapters: [],
  };
}

describe('probeFile()', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it("returns 'reprobed' when no probe is cached", async () => {
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0)`,
      )
      .run('x.mkv');
    const probe = vi.fn(async () => v2Result());
    const status = await probeFile('/abs/x.mkv', 'x.mkv', 100, db, {}, { probe });
    expect(status).toBe('reprobed');
    expect(probe).toHaveBeenCalledOnce();
    const cached = db.getProbe('x.mkv');
    expect(cached?.probedAtMtime).toBe(100);
    expect(cached?.audioStreams).toHaveLength(1);
  });

  it("returns 'fresh' when probe is current and v2-shaped", async () => {
    db.setProbe('x.mkv', { ...v2Result(), probedAtMtime: 100 });
    // Insert a media_files row pointing at the same path so getProbe finds it.
    // setProbe above tries items first; with no row there it's a no-op. Insert
    // a media_items row directly so getProbe can read it back.
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at, probe_json)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0, ?)`,
      )
      .run('x.mkv', JSON.stringify({ ...v2Result(), probedAtMtime: 100 }));
    const probe = vi.fn(async () => v2Result());
    const status = await probeFile('/abs/x.mkv', 'x.mkv', 100, db, {}, { probe });
    expect(status).toBe('fresh');
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns 'reprobed' when cached probe has stale mtime", async () => {
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at, probe_json)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0, ?)`,
      )
      .run('x.mkv', JSON.stringify({ ...v2Result(), probedAtMtime: 50 }));
    const probe = vi.fn(async () => v2Result());
    const status = await probeFile('/abs/x.mkv', 'x.mkv', 100, db, {}, { probe });
    expect(status).toBe('reprobed');
    expect(probe).toHaveBeenCalledOnce();
  });

  it("treats v1-shaped cached blob as stale", async () => {
    // v1 blob: no audioStreams field.
    const v1Blob = {
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 60,
      probedAtMtime: 100,
    };
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at, probe_json)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0, ?)`,
      )
      .run('x.mkv', JSON.stringify(v1Blob));
    const probe = vi.fn(async () => v2Result());
    const status = await probeFile('/abs/x.mkv', 'x.mkv', 100, db, {}, { probe });
    expect(status).toBe('reprobed');
    expect(probe).toHaveBeenCalledOnce();
  });

  it("force: true re-probes regardless of cache state", async () => {
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at, probe_json)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0, ?)`,
      )
      .run('x.mkv', JSON.stringify({ ...v2Result(), probedAtMtime: 100 }));
    const probe = vi.fn(async () => v2Result());
    const status = await probeFile('/abs/x.mkv', 'x.mkv', 100, db, { force: true }, { probe });
    expect(status).toBe('reprobed');
    expect(probe).toHaveBeenCalledOnce();
  });

  it("returns 'failed' when ffprobe throws and never re-throws", async () => {
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES (?, 'movie', NULL, 'X', NULL, NULL, NULL, NULL, 0, 0)`,
      )
      .run('x.mkv');
    const probe = vi.fn(async () => {
      throw new Error('boom');
    });
    const warn = vi.fn();
    const status = await probeFile(
      '/abs/x.mkv',
      'x.mkv',
      100,
      db,
      {},
      { probe, logger: { warn } },
    );
    expect(status).toBe('failed');
    expect(warn).toHaveBeenCalledOnce();
    // Existing row left as-is — no probe blob written.
    expect(db.getProbe('x.mkv')).toBeUndefined();
  });
});
