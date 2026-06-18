/**
 * 0.1.10 — reconcile + parent-recompute + resurrection coverage.
 *
 * Exercises the explicit reconciliation pass directly (without spinning up a
 * full TMDB-backed scan) by seeding the DB and calling `reconcile()`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-reconcile-default');

const { openDb } = await import('../src/db.js');
const { reconcile } = await import('../src/scan.js');

function seedMovie(db: ReturnType<typeof openDb>, p: string): number {
  const item = db.upsertItem({
    path: p,
    type: 'movie',
    tmdb_id: Math.floor(Math.random() * 1_000_000),
    title: p,
    year: 2020,
    poster_url: null,
    backdrop_url: null,
    overview: null,
    mtime: 1,
    scanned_at: 1,
  });
  db.upsertMediaFile({ item_id: item.id, path: p, mtime: 1, scanned_at: 1 });
  return item.id;
}

function seedSeriesWithEpisodes(
  db: ReturnType<typeof openDb>,
  seriesPath: string,
  epPaths: string[],
): { seriesId: number; epIds: number[] } {
  const series = db.upsertItem({
    path: seriesPath,
    type: 'series',
    tmdb_id: Math.floor(Math.random() * 1_000_000),
    title: seriesPath,
    year: 2020,
    poster_url: null,
    backdrop_url: null,
    overview: null,
    mtime: 0,
    scanned_at: 1,
  });
  const epIds: number[] = [];
  for (let i = 0; i < epPaths.length; i++) {
    const ep = db.upsertEpisode({
      series_id: series.id,
      path: epPaths[i]!,
      season: 1,
      episode: i + 1,
      title: null,
      overview: null,
      still_url: null,
      mtime: 1,
      scanned_at: 1,
    });
    epIds.push(ep.id);
  }
  return { seriesId: series.id, epIds };
}

const RUN_AT = 999_999;

function deletedAt(db: ReturnType<typeof openDb>, table: string, p: string): number | null {
  const row = db.raw
    .prepare(`SELECT deleted_at FROM ${table} WHERE path = ?`)
    .get(p) as { deleted_at: number | null } | undefined;
  return row?.deleted_at ?? null;
}

describe('reconcile()', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('soft-deletes paths that were in the DB but absent from the disk set', () => {
    seedMovie(db, 'A.mkv');
    seedMovie(db, 'B.mkv');
    const counts = reconcile(db, [{ relPosix: 'A.mkv', mtime: 1 }], RUN_AT);
    expect(counts.disappeared).toBe(1);
    expect(deletedAt(db, 'media_items', 'B.mkv')).toBe(RUN_AT);
    expect(deletedAt(db, 'media_files', 'B.mkv')).toBe(RUN_AT);
    expect(deletedAt(db, 'media_items', 'A.mkv')).toBeNull();
  });

  it('resurrects paths that had deleted_at but are back on disk', () => {
    const id = seedMovie(db, 'A.mkv');
    db.raw.prepare(`UPDATE media_items SET deleted_at = 100 WHERE id = ?`).run(id);
    db.raw.prepare(`UPDATE media_files SET deleted_at = 100 WHERE path = 'A.mkv'`).run();
    const counts = reconcile(db, [{ relPosix: 'A.mkv', mtime: 1 }], RUN_AT);
    expect(counts.resurrected).toBe(1);
    expect(deletedAt(db, 'media_items', 'A.mkv')).toBeNull();
    expect(deletedAt(db, 'media_files', 'A.mkv')).toBeNull();
  });

  it('parent recompute: series row tombstoned when every episode tombstoned', () => {
    const { seriesId } = seedSeriesWithEpisodes(db, 'TheBear', [
      'TheBear/S01E01.mkv',
      'TheBear/S01E02.mkv',
    ]);
    // Both episodes disappear from disk.
    reconcile(db, [], RUN_AT);
    const series = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE id = ?`)
      .get(seriesId) as { deleted_at: number | null };
    expect(series.deleted_at).not.toBeNull();
  });

  it('parent recompute: series row stays alive when at least one episode survives', () => {
    const { seriesId } = seedSeriesWithEpisodes(db, 'TheBear', [
      'TheBear/S01E01.mkv',
      'TheBear/S01E02.mkv',
    ]);
    // Only episode 1 survives.
    reconcile(db, [{ relPosix: 'TheBear/S01E01.mkv', mtime: 1 }], RUN_AT);
    const series = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE id = ?`)
      .get(seriesId) as { deleted_at: number | null };
    expect(series.deleted_at).toBeNull();
  });

  it('parent recompute clears series when an episode comes back', () => {
    const { seriesId, epIds } = seedSeriesWithEpisodes(db, 'TheBear', [
      'TheBear/S01E01.mkv',
    ]);
    // First reconcile with no files → series tombstoned.
    reconcile(db, [], RUN_AT);
    let series = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE id = ?`)
      .get(seriesId) as { deleted_at: number | null };
    expect(series.deleted_at).not.toBeNull();
    expect(epIds.length).toBe(1);

    // Episode comes back.
    reconcile(db, [{ relPosix: 'TheBear/S01E01.mkv', mtime: 1 }], RUN_AT + 1);
    series = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE id = ?`)
      .get(seriesId) as { deleted_at: number | null };
    expect(series.deleted_at).toBeNull();
  });

  it('multi-rip movie: deleting one rip leaves movie alive', () => {
    const item = db.upsertItem({
      path: 'Naussica',
      type: 'movie',
      tmdb_id: 81,
      title: 'Naussica',
      year: 1984,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 0,
      scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: item.id, path: 'Naussica/RM10.mkv', mtime: 1, scanned_at: 1 });
    db.upsertMediaFile({ item_id: item.id, path: 'Naussica/RM14.mkv', mtime: 1, scanned_at: 1 });
    // Delete RM14 from disk; RM10 survives.
    reconcile(db, [{ relPosix: 'Naussica/RM10.mkv', mtime: 1 }], RUN_AT);
    expect(deletedAt(db, 'media_files', 'Naussica/RM14.mkv')).toBe(RUN_AT);
    expect(deletedAt(db, 'media_files', 'Naussica/RM10.mkv')).toBeNull();
    const movie = db.raw
      .prepare(`SELECT deleted_at FROM media_items WHERE id = ?`)
      .get(item.id) as { deleted_at: number | null };
    expect(movie.deleted_at).toBeNull();
  });

  it('disappeared count is deduped across tables (one path = one disappearance)', () => {
    seedMovie(db, 'X.mkv');
    // Movie path is in BOTH media_items and media_files. A single delete
    // should report disappeared = 1, not 2.
    const counts = reconcile(db, [], RUN_AT);
    expect(counts.disappeared).toBe(1);
  });

  it('idempotent: rerunning with the same disk state does nothing', () => {
    seedMovie(db, 'A.mkv');
    reconcile(db, [{ relPosix: 'A.mkv', mtime: 1 }], RUN_AT);
    const counts = reconcile(db, [{ relPosix: 'A.mkv', mtime: 1 }], RUN_AT + 1);
    expect(counts.disappeared).toBe(0);
    expect(counts.resurrected).toBe(0);
    expect(counts.reparented).toBe(0);
  });

  // 0.1.14 — mis-parent heal. Reproduces the real LOTR bug: a movie's file
  // got its media_files.item_id rewritten to a *different* movie item, leaving
  // the true owner childless (and thus tombstoned + hidden from home).
  it('heals a movie file re-parented onto the wrong item, reviving the true owner', () => {
    const fellowship = seedMovie(db, 'Fellowship.mkv');
    const rotkId = seedMovie(db, 'ROTK.mkv');
    // Corrupt the DB the way applyMovie did: point ROTK's file at Fellowship,
    // and tombstone the now-childless ROTK item.
    db.raw.prepare(`UPDATE media_files SET item_id = ? WHERE path = 'ROTK.mkv'`).run(fellowship);
    db.raw.prepare(`UPDATE media_items SET deleted_at = 100 WHERE id = ?`).run(rotkId);

    // Both files are still on disk.
    const counts = reconcile(
      db,
      [
        { relPosix: 'Fellowship.mkv', mtime: 1 },
        { relPosix: 'ROTK.mkv', mtime: 1 },
      ],
      RUN_AT,
    );

    expect(counts.reparented).toBe(1);
    // ROTK's file points back at the ROTK item.
    const file = db.raw
      .prepare(`SELECT item_id FROM media_files WHERE path = 'ROTK.mkv'`)
      .get() as { item_id: number };
    expect(file.item_id).toBe(rotkId);
    // ROTK item is alive again → visible on home.
    expect(deletedAt(db, 'media_items', 'ROTK.mkv')).toBeNull();
    // Fellowship is untouched and still alive.
    expect(deletedAt(db, 'media_items', 'Fellowship.mkv')).toBeNull();
  });

  it('mis-parent heal is a no-op when every file already points at its own item', () => {
    seedMovie(db, 'A.mkv');
    seedMovie(db, 'B.mkv');
    const counts = reconcile(
      db,
      [
        { relPosix: 'A.mkv', mtime: 1 },
        { relPosix: 'B.mkv', mtime: 1 },
      ],
      RUN_AT,
    );
    expect(counts.reparented).toBe(0);
  });

  it('mis-parent heal ignores multi-rip files (path never equals a movie item path)', () => {
    // Foldered multi-rip: the item path is the folder, the files live under it.
    const item = db.upsertItem({
      path: 'Naussica',
      type: 'movie',
      tmdb_id: 81,
      title: 'Naussica',
      year: 1984,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 0,
      scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: item.id, path: 'Naussica/RM10.mkv', mtime: 1, scanned_at: 1 });
    const counts = reconcile(db, [{ relPosix: 'Naussica/RM10.mkv', mtime: 1 }], RUN_AT);
    // No movie item has path 'Naussica/RM10.mkv', so the heal can't (and must
    // not) touch it.
    expect(counts.reparented).toBe(0);
    const file = db.raw
      .prepare(`SELECT item_id FROM media_files WHERE path = 'Naussica/RM10.mkv'`)
      .get() as { item_id: number };
    expect(file.item_id).toBe(item.id);
  });
});
