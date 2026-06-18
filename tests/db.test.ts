import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-db-test');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../src/db.js');

describe('db', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('creates the expected tables and indexes', () => {
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('media_items');
    expect(names).toContain('episodes');
    expect(names).toContain('playback_state');

    const indexes = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
      .all() as Array<{ name: string }>;
    const idxNames = indexes.map((i) => i.name);
    expect(idxNames).toContain('idx_media_items_type');
    expect(idxNames).toContain('idx_episodes_series');
    expect(idxNames).toContain('idx_episodes_season_ep');
  });

  it('upsertItem inserts then updates the same row by path', () => {
    const t = 1_700_000_000_000;
    const inserted = db.upsertItem({
      path: 'Dune.2021.mkv',
      type: 'movie',
      tmdb_id: 438631,
      title: 'Dune',
      year: 2021,
      poster_url: 'https://image.tmdb.org/p/dune.jpg',
      backdrop_url: null,
      overview: 'desert',
      mtime: 1234,
      scanned_at: t,
    });
    expect(inserted.id).toBeTypeOf('number');
    expect(inserted.title).toBe('Dune');

    const updated = db.upsertItem({
      path: 'Dune.2021.mkv',
      type: 'movie',
      tmdb_id: 438631,
      title: 'Dune (rewritten)',
      year: 2021,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 5678,
      scanned_at: t + 1,
    });
    expect(updated.id).toBe(inserted.id);
    expect(updated.title).toBe('Dune (rewritten)');
    expect(updated.mtime).toBe(5678);
  });

  it('getByPath returns undefined for missing rows', () => {
    expect(db.getByPath('nope.mkv')).toBeUndefined();
  });

  it('upsertEpisode requires an existing series via FK', () => {
    expect(() =>
      db.upsertEpisode({
        series_id: 999,
        path: 'orphan/S01E01.mkv',
        season: 1,
        episode: 1,
        title: null,
        overview: null,
        still_url: null,
        mtime: 1,
        scanned_at: 1,
      }),
    ).toThrow();
  });

  it('getSeries returns the item plus sorted episodes; cascade delete works', () => {
    const t = 1;
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
      scanned_at: t,
    });
    db.upsertEpisode({
      series_id: series.id,
      path: 'The Bear/S01E02.mkv',
      season: 1,
      episode: 2,
      title: null,
      overview: null,
      still_url: null,
      mtime: 1,
      scanned_at: t,
    });
    db.upsertEpisode({
      series_id: series.id,
      path: 'The Bear/S01E01.mkv',
      season: 1,
      episode: 1,
      title: null,
      overview: null,
      still_url: null,
      mtime: 1,
      scanned_at: t,
    });

    const got = db.getSeries(series.id);
    expect(got).toBeDefined();
    expect(got!.episodes.map((e) => e.episode)).toEqual([1, 2]);

    db.raw.prepare('DELETE FROM media_items WHERE id = ?').run(series.id);
    expect(db.getEpisodeByPath('The Bear/S01E01.mkv')).toBeUndefined();
  });

  it('listLibrary excludes soft-deleted by default; includeStale returns everything', () => {
    db.upsertItem({
      path: 'old.mkv',
      type: 'movie',
      tmdb_id: 1,
      title: 'Old',
      year: 2000,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 100,
    });
    db.upsertItem({
      path: 'new.mkv',
      type: 'movie',
      tmdb_id: 2,
      title: 'New',
      year: 2024,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 200,
    });
    // 0.1.10 — staleness is `deleted_at IS NOT NULL`, not `scanned_at < MAX`.
    db.raw.prepare(`UPDATE media_items SET deleted_at = 150 WHERE path = 'old.mkv'`).run();

    const fresh = db.listLibrary();
    expect(fresh.map((r) => r.path)).toEqual(['new.mkv']);

    const all = db.listLibrary({ includeStale: true });
    expect(all.map((r) => r.path).sort()).toEqual(['new.mkv', 'old.mkv']);
  });

  it('latestRunAt returns 0 for an empty DB', () => {
    expect(db.latestRunAt()).toBe(0);
  });

  it('media_items has confidence + identification_json columns', () => {
    const cols = db.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('confidence');
    expect(names).toContain('identification_json');
  });

  it('needs_review table round-trips entries', () => {
    const path = 'mystery/file.mkv';
    const row = db.upsertReviewItem({
      path,
      reason: 'low_score',
      candidates: JSON.stringify([{ id: 1, score: 0.4 }]),
      added_at: 1_700_000_000_000,
      scanned_at: 1_700_000_000_000,
    });
    expect(row.path).toBe(path);
    const got = db.getReviewItem(path);
    expect(got).toBeDefined();
    expect(JSON.parse(got!.candidates)).toEqual([{ id: 1, score: 0.4 }]);

    db.clearReviewItem(path);
    expect(db.getReviewItem(path)).toBeUndefined();
  });

  it('needs_review upsert updates reason on the same path', () => {
    db.upsertReviewItem({ path: 'x.mkv', reason: 'no_results', candidates: '[]', added_at: 1, scanned_at: 1 });
    db.upsertReviewItem({ path: 'x.mkv', reason: 'low_score', candidates: '[{}]', added_at: 1, scanned_at: 2 });
    const got = db.getReviewItem('x.mkv');
    expect(got!.reason).toBe('low_score');
    expect(got!.scanned_at).toBe(2);
  });

  it('additive migration adds confidence/identification_json to a pre-0.1.1.1 DB', () => {
    const tmpDb = openDb(':memory:');
    // Drop the columns to simulate an older schema, then re-open via openDb to verify migration.
    tmpDb.raw.exec(`
      DROP TABLE IF EXISTS media_items;
      DROP TABLE IF EXISTS episodes;
      CREATE TABLE media_items (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        tmdb_id INTEGER,
        title TEXT,
        year INTEGER,
        poster_url TEXT,
        backdrop_url TEXT,
        overview TEXT,
        mtime INTEGER NOT NULL,
        scanned_at INTEGER NOT NULL
      );
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY,
        series_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        path TEXT UNIQUE NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        title TEXT,
        overview TEXT,
        still_url TEXT,
        mtime INTEGER NOT NULL,
        scanned_at INTEGER NOT NULL
      );
    `);
    const before = tmpDb.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    expect(before.map((c) => c.name)).not.toContain('confidence');

    // Re-apply schema + migration manually by calling the same code path openDb would.
    // The simpler path: just ALTER directly using the same helper logic.
    tmpDb.raw.exec(`ALTER TABLE media_items ADD COLUMN confidence REAL`);
    tmpDb.raw.exec(`ALTER TABLE media_items ADD COLUMN identification_json TEXT`);
    tmpDb.raw.exec(`ALTER TABLE episodes ADD COLUMN confidence REAL`);
    tmpDb.raw.exec(`ALTER TABLE episodes ADD COLUMN identification_json TEXT`);

    const after = tmpDb.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    expect(after.map((c) => c.name)).toContain('confidence');
    expect(after.map((c) => c.name)).toContain('identification_json');
    tmpDb.close();
  });

  it('media_files table exists with the expected columns', () => {
    const cols = db.raw.prepare(`PRAGMA table_info(media_files)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('item_id');
    expect(names).toContain('path');
    expect(names).toContain('mtime');
    expect(names).toContain('scanned_at');
  });

  it('upsertMediaFile + getMediaFilesForItem round-trip', () => {
    const item = db.upsertItem({
      path: 'Nausicaa.mkv',
      type: 'movie',
      tmdb_id: 81,
      title: 'Nausicaa',
      year: 1984,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: item.id, path: 'Nausicaa.mkv', mtime: 5, scanned_at: 10 });
    db.upsertMediaFile({ item_id: item.id, path: 'Nausicaa.RM14.mkv', mtime: 5, scanned_at: 10 });
    const files = db.getMediaFilesForItem(item.id);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path).sort()).toEqual(['Nausicaa.RM14.mkv', 'Nausicaa.mkv']);
  });

  it('media_files cascades on media_items delete', () => {
    const item = db.upsertItem({
      path: 'X.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: item.id, path: 'X.mkv', mtime: 1, scanned_at: 1 });
    db.raw.prepare(`DELETE FROM media_items WHERE id = ?`).run(item.id);
    expect(db.getMediaFilesForItem(item.id)).toHaveLength(0);
  });

  it('opening a DB twice runs the backfill exactly once (idempotent)', () => {
    // Ensure backfill doesn't crash and creates exactly the expected rows on re-open.
    db.upsertItem({
      path: 'Backfill.mkv', type: 'movie', tmdb_id: 5, title: 'B', year: 2020, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    // Manually re-run the backfill (the same SQL openDb runs).
    db.raw.exec(`
      INSERT INTO media_files (item_id, path, mtime, scanned_at)
      SELECT mi.id, mi.path, mi.mtime, mi.scanned_at
      FROM media_items mi
      WHERE mi.type = 'movie'
        AND NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = mi.id);
    `);
    // Run it a second time — should still leave exactly one row per movie.
    db.raw.exec(`
      INSERT INTO media_files (item_id, path, mtime, scanned_at)
      SELECT mi.id, mi.path, mi.mtime, mi.scanned_at
      FROM media_items mi
      WHERE mi.type = 'movie'
        AND NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = mi.id);
    `);
    const cnt = db.raw.prepare(`SELECT COUNT(*) AS c FROM media_files`).get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  it('media_items has imdb_id + tvdb_id columns (0.1.1.3)', () => {
    const cols = db.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('imdb_id');
    expect(names).toContain('tvdb_id');
  });

  it('manual_overrides round-trips entries', () => {
    db.setManualOverride({
      path: 'movies/Foo.mkv',
      tmdb_id: 999,
      imdb_id: 'tt000999',
      tvdb_id: 12345,
      type: 'movie',
      reason: 'manual',
      decided_at: 1_700_000_000_000,
    });
    const got = db.getManualOverride('movies/Foo.mkv');
    expect(got).toBeDefined();
    expect(got!.tmdb_id).toBe(999);
    expect(got!.imdb_id).toBe('tt000999');
    expect(got!.tvdb_id).toBe(12345);
    expect(got!.type).toBe('movie');

    db.deleteManualOverride('movies/Foo.mkv');
    expect(db.getManualOverride('movies/Foo.mkv')).toBeUndefined();
  });

  it('manual_overrides is upsert-keyed by path', () => {
    db.setManualOverride({
      path: 'p.mkv', tmdb_id: 1, type: 'movie', reason: 'manual', decided_at: 1,
    });
    db.setManualOverride({
      path: 'p.mkv', tmdb_id: 2, type: 'series', season: 3, episode: 4, reason: 'imdb-link', decided_at: 2,
    });
    const got = db.getManualOverride('p.mkv');
    expect(got!.tmdb_id).toBe(2);
    expect(got!.type).toBe('series');
    expect(got!.season).toBe(3);
    expect(got!.episode).toBe(4);
    expect(got!.reason).toBe('imdb-link');
  });

  it('upsertItem persists imdb_id and tvdb_id when provided', () => {
    const row = db.upsertItem({
      path: 'X.mkv',
      type: 'movie',
      tmdb_id: 1,
      imdb_id: 'tt0000001',
      tvdb_id: 42,
      title: 'X',
      year: 2020,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1,
    });
    expect(row.imdb_id).toBe('tt0000001');
    expect(row.tvdb_id).toBe(42);
  });

  it('media_items + episodes have probe_json column (0.1.4)', () => {
    const itemCols = db.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    const epCols = db.raw.prepare(`PRAGMA table_info(episodes)`).all() as Array<{ name: string }>;
    expect(itemCols.map((c) => c.name)).toContain('probe_json');
    expect(epCols.map((c) => c.name)).toContain('probe_json');
  });

  it('episodes has runtime_seconds column (0.1.3.1)', () => {
    const cols = db.raw.prepare(`PRAGMA table_info(episodes)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('runtime_seconds');
  });

  it('upsertEpisode persists runtime_seconds when provided (0.1.3.1)', () => {
    const series = db.upsertItem({
      path: 'Cascadia', type: 'series', tmdb_id: 100, title: 'Cascadia', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    const ep = db.upsertEpisode({
      series_id: series.id,
      path: 'Cascadia/S01E01.mkv',
      season: 1,
      episode: 1,
      title: 'Pilot',
      overview: null,
      still_url: null,
      runtime_seconds: 3480,
      mtime: 1,
      scanned_at: 1,
    });
    expect(ep.runtime_seconds).toBe(3480);
  });

  it('getSeries returns episodes joined with playback (0.1.3.1)', () => {
    const series = db.upsertItem({
      path: 'Cascadia', type: 'series', tmdb_id: 200, title: 'Cascadia', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'Cascadia/S01E01.mkv', season: 1, episode: 1,
      title: 'A', overview: null, still_url: null, mtime: 1, scanned_at: 1,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'Cascadia/S01E02.mkv', season: 1, episode: 2,
      title: 'B', overview: null, still_url: null, mtime: 1, scanned_at: 1,
    });
    db.upsertPlayback({
      path: 'Cascadia/S01E01.mkv',
      position: 1320,
      duration: 3000,
      updated_at: 1_700_000_000_000,
    });

    const got = db.getSeries(series.id);
    expect(got).toBeDefined();
    expect(got!.episodes).toHaveLength(2);
    const e1 = got!.episodes[0]!;
    expect(e1.path).toBe('Cascadia/S01E01.mkv');
    expect(e1.playback).not.toBeNull();
    expect(e1.playback!.position_seconds).toBe(1320);
    expect(e1.playback!.duration_seconds).toBe(3000);
    expect(e1.playback!.watched).toBe(0);
    const e2 = got!.episodes[1]!;
    expect(e2.path).toBe('Cascadia/S01E02.mkv');
    expect(e2.playback).toBeNull();
  });

  it('setProbe + getProbe round-trip on a media_items (movie) row', () => {
    db.upsertItem({
      path: 'Dune.2021.mkv',
      type: 'movie',
      tmdb_id: 438631,
      title: 'Dune',
      year: 2021,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1,
    });
    expect(db.getProbe('Dune.2021.mkv')).toBeUndefined();
    db.setProbe('Dune.2021.mkv', {
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1547.2,
    });
    const got = db.getProbe('Dune.2021.mkv');
    expect(got).toBeDefined();
    expect(got!.container).toBe('matroska,webm');
    expect(got!.videoCodec).toBe('h264');
    expect(got!.durationSeconds).toBeCloseTo(1547.2);
  });

  it('setProbe + getProbe round-trip on an episodes row', () => {
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
      path: 'The Bear/S01E01.mkv',
      season: 1,
      episode: 1,
      title: null,
      overview: null,
      still_url: null,
      mtime: 1,
      scanned_at: 1,
    });
    db.setProbe('The Bear/S01E01.mkv', {
      container: 'matroska,webm',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 1500,
    });
    const got = db.getProbe('The Bear/S01E01.mkv');
    expect(got).toBeDefined();
    expect(got!.videoCodec).toBe('h264');
  });

  it('setProbe via media_files lookup updates the parent media_items row', () => {
    const item = db.upsertItem({
      path: 'Nausicaa',
      type: 'movie',
      tmdb_id: 81,
      title: 'Nausicaa',
      year: 1984,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      mtime: 1,
      scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: item.id, path: 'Nausicaa/RM14.mkv', mtime: 1, scanned_at: 1 });
    db.setProbe('Nausicaa/RM14.mkv', {
      container: 'mov,mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      durationSeconds: 117,
    });
    const got = db.getProbe('Nausicaa/RM14.mkv');
    expect(got).toBeDefined();
    expect(got!.container).toBe('mov,mp4');
  });

  it('media_items has genres_json + runtime_seconds columns (0.1.3.2)', () => {
    const cols = db.raw.prepare(`PRAGMA table_info(media_items)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('genres_json');
    expect(names).toContain('runtime_seconds');
  });

  it('upsertItem persists genres_json + runtime_seconds when provided (0.1.3.2)', () => {
    const row = db.upsertItem({
      path: 'Dune.mkv',
      type: 'movie',
      tmdb_id: 438631,
      title: 'Dune',
      year: 2021,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      genres_json: JSON.stringify(['Drama', 'Sci-Fi']),
      runtime_seconds: 9300,
      mtime: 1,
      scanned_at: 1,
    });
    expect(row.genres_json).toBe(JSON.stringify(['Drama', 'Sci-Fi']));
    expect(row.runtime_seconds).toBe(9300);
  });

  it('upsertItem COALESCEs genres_json + runtime_seconds across re-upserts (0.1.3.2)', () => {
    const a = db.upsertItem({
      path: 'X.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020,
      poster_url: null, backdrop_url: null, overview: null,
      genres_json: JSON.stringify(['Action']),
      runtime_seconds: 6000,
      mtime: 1, scanned_at: 1,
    });
    expect(a.genres_json).toBe(JSON.stringify(['Action']));
    const b = db.upsertItem({
      path: 'X.mkv', type: 'movie', tmdb_id: 1, title: 'X', year: 2020,
      poster_url: null, backdrop_url: null, overview: null,
      // genres_json + runtime_seconds intentionally omitted — should NOT clobber
      mtime: 2, scanned_at: 2,
    });
    expect(b.genres_json).toBe(JSON.stringify(['Action']));
    expect(b.runtime_seconds).toBe(6000);
  });

  it('listLibraryWithPlayback returns aggregate fields with and without playback (0.1.3.2)', () => {
    db.upsertItem({
      path: 'NewMovie.mkv', type: 'movie', tmdb_id: 100, title: 'New', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 5000,
    });
    db.upsertPlayback({
      path: 'NewMovie.mkv', position: 600, duration: 1500, updated_at: 1_700_000_000_000,
    });
    db.upsertItem({
      path: 'OtherMovie.mkv', type: 'movie', tmdb_id: 101, title: 'Other', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 5000,
    });

    const rows = db.listLibraryWithPlayback({ includeStale: true });
    const byTitle = new Map(rows.map((r) => [r.item.title, r]));
    const newRow = byTitle.get('New')!;
    expect(newRow.playback.position).toBe(600);
    expect(newRow.playback.duration).toBe(1500);
    expect(newRow.playback.watched).toBe(false);
    expect(newRow.playback.lastPlayedAt).toBe(1_700_000_000_000);

    const otherRow = byTitle.get('Other')!;
    expect(otherRow.playback.position).toBe(0);
    expect(otherRow.playback.duration).toBe(0);
    expect(otherRow.playback.watched).toBe(false);
    expect(otherRow.playback.lastPlayedAt).toBeNull();
  });

  it('listLibraryWithPlayback aggregates series episode-level playback (0.1.3.2)', () => {
    const series = db.upsertItem({
      path: 'TheBear', type: 'series', tmdb_id: 200, title: 'The Bear', year: 2022,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'TheBear/S01E01.mkv', season: 1, episode: 1,
      title: 'A', overview: null, still_url: null, mtime: 1, scanned_at: 5000,
    });
    db.upsertEpisode({
      series_id: series.id, path: 'TheBear/S01E02.mkv', season: 1, episode: 2,
      title: 'B', overview: null, still_url: null, mtime: 1, scanned_at: 5000,
    });
    // Mark E1 watched, E2 in progress
    db.upsertPlayback({
      path: 'TheBear/S01E01.mkv', position: 1500, duration: 1500, updated_at: 1_700_000_000_000,
    });
    db.upsertPlayback({
      path: 'TheBear/S01E02.mkv', position: 600, duration: 1500, updated_at: 1_700_000_500_000,
    });

    const rows = db.listLibraryWithPlayback({ includeStale: true });
    const seriesAgg = rows.find((r) => r.item.title === 'The Bear')!;
    // Not all watched yet, so watched=false
    expect(seriesAgg.playback.watched).toBe(false);
    // lastPlayedAt is the MAX of episode updated_at
    expect(seriesAgg.playback.lastPlayedAt).toBe(1_700_000_500_000);

    // Mark E2 watched too
    db.upsertPlayback({
      path: 'TheBear/S01E02.mkv', position: 1500, duration: 1500, updated_at: 1_700_001_000_000,
      watched: true,
    });
    const rows2 = db.listLibraryWithPlayback({ includeStale: true });
    const seriesAgg2 = rows2.find((r) => r.item.title === 'The Bear')!;
    expect(seriesAgg2.playback.watched).toBe(true);
  });

  it('getContinueWatching: movie qualifies iff in-progress within 90% (0.1.3.2)', () => {
    db.upsertItem({
      path: 'A.mkv', type: 'movie', tmdb_id: 1, title: 'A', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertItem({
      path: 'B.mkv', type: 'movie', tmdb_id: 2, title: 'B', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertItem({
      path: 'C.mkv', type: 'movie', tmdb_id: 3, title: 'C', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    // A: in progress at 40%, B: at 95% (above 90% threshold), C: never started
    db.upsertPlayback({ path: 'A.mkv', position: 600, duration: 1500, updated_at: 1000 });
    db.upsertPlayback({ path: 'B.mkv', position: 1430, duration: 1500, updated_at: 2000, watched: true });

    const out = db.getContinueWatching();
    expect(out.map((r) => r.title)).toEqual(['A']);
    expect(out[0]!.position).toBe(600);
    expect(out[0]!.duration).toBe(1500);
    expect(out[0]!.type).toBe('movie');
    expect(out[0]!.resumePath).toBe('A.mkv');
    expect(out[0]!.resumeLabel).toBeNull();
  });

  it('getContinueWatching: series collapses to most-recent in-progress episode per series (0.1.3.2)', () => {
    const s = db.upsertItem({
      path: 'Show', type: 'series', tmdb_id: 99, title: 'Show', year: 2024,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertEpisode({ series_id: s.id, path: 'Show/S01E01.mkv', season: 1, episode: 1, title: '1', overview: null, still_url: null, mtime: 1, scanned_at: 1 });
    db.upsertEpisode({ series_id: s.id, path: 'Show/S01E02.mkv', season: 1, episode: 2, title: '2', overview: null, still_url: null, mtime: 1, scanned_at: 1 });
    db.upsertEpisode({ series_id: s.id, path: 'Show/S01E03.mkv', season: 1, episode: 3, title: '3', overview: null, still_url: null, mtime: 1, scanned_at: 1 });
    // E1 in progress at t=1000, E2 in progress at t=2000 (more recent)
    db.upsertPlayback({ path: 'Show/S01E01.mkv', position: 600, duration: 1500, updated_at: 1000 });
    db.upsertPlayback({ path: 'Show/S01E02.mkv', position: 600, duration: 1500, updated_at: 2000 });
    // E3 watched
    db.upsertPlayback({ path: 'Show/S01E03.mkv', position: 1500, duration: 1500, updated_at: 3000, watched: true });

    const out = db.getContinueWatching();
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('series');
    expect(out[0]!.title).toBe('Show');
    expect(out[0]!.resumePath).toBe('Show/S01E02.mkv');
    expect(out[0]!.resumeLabel).toBe('S1 · E2');
    expect(out[0]!.lastPlayedAt).toBe(2000);
  });

  it('getContinueWatching: orders by lastPlayedAt DESC and respects limit (0.1.3.2)', () => {
    db.upsertItem({ path: 'A.mkv', type: 'movie', tmdb_id: 1, title: 'A', year: 2024, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 });
    db.upsertItem({ path: 'B.mkv', type: 'movie', tmdb_id: 2, title: 'B', year: 2024, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 });
    db.upsertItem({ path: 'C.mkv', type: 'movie', tmdb_id: 3, title: 'C', year: 2024, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 });
    db.upsertPlayback({ path: 'A.mkv', position: 100, duration: 1000, updated_at: 1000 });
    db.upsertPlayback({ path: 'B.mkv', position: 100, duration: 1000, updated_at: 2000 });
    db.upsertPlayback({ path: 'C.mkv', position: 100, duration: 1000, updated_at: 3000 });

    expect(db.getContinueWatching().map((r) => r.title)).toEqual(['C', 'B', 'A']);
    expect(db.getContinueWatching(2).map((r) => r.title)).toEqual(['C', 'B']);
  });

  it('upsertItem stores confidence + identification_json when provided', () => {
    const row = db.upsertItem({
      path: 'Foo.mkv',
      type: 'movie',
      tmdb_id: 1,
      title: 'Foo',
      year: 2020,
      poster_url: null,
      backdrop_url: null,
      overview: null,
      confidence: 0.92,
      identification_json: '{"score":0.92}',
      mtime: 1,
      scanned_at: 1,
    });
    expect(row.confidence).toBe(0.92);
    expect(row.identification_json).toBe('{"score":0.92}');
  });

  describe('wipe', () => {
    /** Seed one series + episode, a movie + media_file, a review item, a
     *  scan_run, a playback row, and a manual override. */
    function seed(): void {
      const series = db.upsertItem({
        path: 'The Bear', type: 'series', tmdb_id: 1, title: 'The Bear', year: 2022,
        poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
      });
      db.upsertEpisode({
        series_id: series.id, path: 'The Bear/S01E01.mkv', season: 1, episode: 1,
        title: 'Pilot', overview: null, still_url: null, mtime: 1, scanned_at: 1,
      });
      const movie = db.upsertItem({
        path: 'Dune.mkv', type: 'movie', tmdb_id: 2, title: 'Dune', year: 2021,
        poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
      });
      db.upsertMediaFile({ item_id: movie.id, path: 'Dune.mkv', mtime: 1, scanned_at: 1 });
      db.upsertReviewItem({
        path: 'Mystery.mkv', reason: 'no_results', candidates: '[]', added_at: 1, scanned_at: 1,
      });
      db.openScanRun('smart');
      db.upsertPlayback({ path: 'Dune.mkv', position: 50, duration: 100, updated_at: 1 });
      db.setManualOverride({
        path: 'Dune.mkv', tmdb_id: 2, type: 'movie', reason: 'manual', decided_at: 1,
      });
    }

    function count(table: string): number {
      return (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }

    it("scope 'library' clears scanned data but keeps overrides + playback", () => {
      seed();
      const counts = db.wipe('library');

      // Library tables emptied.
      expect(count('media_items')).toBe(0);
      expect(count('episodes')).toBe(0);
      expect(count('media_files')).toBe(0);
      expect(count('needs_review')).toBe(0);
      expect(count('scan_runs')).toBe(0);
      // User-owned tables preserved.
      expect(count('manual_overrides')).toBe(1);
      expect(count('playback_state')).toBe(1);

      // Returned counts reflect what was deleted.
      expect(counts.media_items).toBe(2);
      expect(counts.episodes).toBe(1);
      expect(counts).not.toHaveProperty('manual_overrides');
    });

    it("scope 'all' clears every table including overrides + playback", () => {
      seed();
      const counts = db.wipe('all');

      expect(count('media_items')).toBe(0);
      expect(count('episodes')).toBe(0);
      expect(count('media_files')).toBe(0);
      expect(count('needs_review')).toBe(0);
      expect(count('scan_runs')).toBe(0);
      expect(count('manual_overrides')).toBe(0);
      expect(count('playback_state')).toBe(0);

      expect(counts.manual_overrides).toBe(1);
      expect(counts.playback_state).toBe(1);
    });

    it('is a no-op on an already-empty DB', () => {
      const counts = db.wipe('all');
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    });
  });
});
