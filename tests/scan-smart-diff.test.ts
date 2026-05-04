/**
 * 0.1.5.1 — smart refresh diff-and-gate path.
 *
 * Asserts the cheap-by-default behavior: smart refresh on a clean library
 * makes ZERO TMDB calls, an added file processes only its cohort, a removed
 * file leaves the row's scanned_at frozen, a renamed file does both.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-smart-diff-default');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../src/db.js');
const { scan, diffPaths, buildDbPathIndex } = await import('../src/scan.js');

function makeTmdb() {
  const searchMulti = vi.fn(async (query: string) => {
    if (/dune/i.test(query)) {
      return {
        page: 1,
        total_results: 1,
        results: [
          { id: 438631, media_type: 'movie' as const, title: 'Dune', release_date: '2021-10-22', overview: null, poster_path: null, backdrop_path: null },
        ],
      };
    }
    if (/inception/i.test(query)) {
      return {
        page: 1,
        total_results: 1,
        results: [
          { id: 27205, media_type: 'movie' as const, title: 'Inception', release_date: '2010-07-15', overview: null, poster_path: null, backdrop_path: null },
        ],
      };
    }
    return { page: 1, total_results: 0, results: [] };
  });
  const getEpisodes = vi.fn();
  const getSeries = vi.fn();
  return {
    searchMulti, getEpisodes, getSeries,
    posterUrl: (p: string | null | undefined) => (p ? `https://x/${p}` : null),
    stillUrl: () => null,
  };
}

async function makeFixture(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-smart-diff-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return root;
}

const onlineShare = async () => ({ online: true, mountPath: '', lastSeen: Date.now() });

describe('diffPaths()', () => {
  it('returns empty diff when disk and DB match exactly', () => {
    const disk = [{ relPosix: 'a.mkv', mtime: 100 }];
    const dbIndex = new Map<string, { mtime: number; kind: 'media-file' }>([
      ['a.mkv', { mtime: 100, kind: 'media-file' }],
    ]);
    const r = diffPaths(disk, dbIndex);
    expect(r.newOrChanged).toEqual([]);
    expect(r.disappeared).toEqual([]);
  });

  it('reports a new file as newOrChanged', () => {
    const disk = [{ relPosix: 'new.mkv', mtime: 100 }];
    const dbIndex = new Map();
    const r = diffPaths(disk, dbIndex);
    expect(r.newOrChanged).toEqual(disk);
    expect(r.disappeared).toEqual([]);
  });

  it('reports an mtime-changed file as newOrChanged', () => {
    const disk = [{ relPosix: 'a.mkv', mtime: 200 }];
    const dbIndex = new Map<string, { mtime: number; kind: 'media-file' }>([
      ['a.mkv', { mtime: 100, kind: 'media-file' }],
    ]);
    const r = diffPaths(disk, dbIndex);
    expect(r.newOrChanged).toEqual(disk);
  });

  it('reports a missing file as disappeared', () => {
    const disk: Array<{ relPosix: string; mtime: number }> = [];
    const dbIndex = new Map<string, { mtime: number; kind: 'media-file' }>([
      ['gone.mkv', { mtime: 100, kind: 'media-file' }],
    ]);
    const r = diffPaths(disk, dbIndex);
    expect(r.disappeared).toEqual(['gone.mkv']);
  });
});

describe('smart refresh diff-and-gate', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('no changes since last scan → ZERO TMDB calls and zero added/updated', async () => {
    const root = await makeFixture({
      'Dune.2021.mkv': 'd',
    });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    t.searchMulti.mockClear();

    const r2 = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    expect(t.searchMulti).not.toHaveBeenCalled();
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
  });

  it('a single new file → only that cohort runs', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    t.searchMulti.mockClear();
    // Add a new file.
    await fs.writeFile(path.join(root, 'Inception.2010.mkv'), 'i');
    const r2 = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    // Only the new cohort should have triggered TMDB.
    const queries = t.searchMulti.mock.calls.map((c) => (c[0] as string).toLowerCase());
    expect(queries.some((q) => q.includes('inception'))).toBe(true);
    expect(queries.some((q) => q.includes('dune'))).toBe(false);
    expect(r2.added).toBeGreaterThanOrEqual(1);
  });

  it('a deleted file → deleted_at is set on the row (0.1.10)', async () => {
    const root = await makeFixture({
      'Dune.2021.mkv': 'd',
      'Inception.2010.mkv': 'i',
    });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    const before = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE path = 'Inception.2010.mkv'`)
      .get() as { deleted_at: number | null };
    expect(before.deleted_at).toBeNull();
    await fs.rm(path.join(root, 'Inception.2010.mkv'));
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    const after = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE path = 'Inception.2010.mkv'`)
      .get() as { deleted_at: number | null };
    expect(after.deleted_at).not.toBeNull();
    expect(r2.disappeared).toBeGreaterThanOrEqual(1);
    // `stale` aliases `disappeared` for one release of back-compat.
    expect(r2.stale).toBe(r2.disappeared);
  });

  it('renamed file: old path soft-deleted, new path is identified (0.1.10)', async () => {
    // Use two distinct movies so a rename actually disappears one identity
    // and adds another. (Renaming Dune → Dune Renamed would still resolve to
    // the same tmdb_id and the row would just update.)
    const root = await makeFixture({
      'Inception.2010.mkv': 'i',
    });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    await fs.rename(
      path.join(root, 'Inception.2010.mkv'),
      path.join(root, 'Dune.2021.mkv'),
    );
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    // Old media_files row is soft-deleted, not removed.
    const oldAfter = db.raw
      .prepare(`SELECT deleted_at FROM media_files WHERE path = 'Inception.2010.mkv'`)
      .get() as { deleted_at: number | null };
    expect(oldAfter.deleted_at).not.toBeNull();
    // New file got identified.
    expect(r2.added + r2.updated).toBeGreaterThanOrEqual(1);
  });

  it('hard refresh runs every cohort even when nothing changed on disk', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    t.searchMulti.mockClear();
    await scan({ full: true }, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    expect(t.searchMulti).toHaveBeenCalled();
  });
});

describe('buildDbPathIndex()', () => {
  it('is empty on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(buildDbPathIndex(db).size).toBe(0);
  });

  it('includes media_files entries with their mtime', () => {
    const db = openDb(':memory:');
    db.raw
      .prepare(
        `INSERT INTO media_items (path, type, tmdb_id, title, year, poster_url, backdrop_url, overview, mtime, scanned_at)
         VALUES ('m.mkv', 'movie', 1, 'M', 2020, NULL, NULL, NULL, 0, 0)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO media_files (item_id, path, mtime, scanned_at)
         VALUES ((SELECT id FROM media_items WHERE path='m.mkv'), 'm.mkv', 999, 0)`,
      )
      .run();
    const idx = buildDbPathIndex(db);
    expect(idx.get('m.mkv')?.mtime).toBe(999);
    expect(idx.get('m.mkv')?.kind).toBe('media-file');
  });
});
