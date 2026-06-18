import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-apply-test');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../../src/db.js');
const { applyIdentity } = await import('../../src/identify/apply.js');

describe('applyIdentity', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('movie: writes media_items + media_files; clears review entry; persists imdb_id/tvdb_id', async () => {
    db.upsertReviewItem({ path: 'Foo.mkv', reason: 'low_score', candidates: '[]', added_at: 1, scanned_at: 1 });
    const r = await applyIdentity(
      'Foo.mkv',
      { tmdbId: 100, imdbId: 'tt100', tvdbId: 7, type: 'movie', title: 'Foo', year: 2020 },
      { confidence: 0.9, mtime: 1, scannedAt: 2 },
      { db },
    );
    expect(r.kind).toBe('movie');
    const row = db.getByPath('Foo.mkv')!;
    expect(row.tmdb_id).toBe(100);
    expect(row.imdb_id).toBe('tt100');
    expect(row.tvdb_id).toBe(7);
    expect(db.getMediaFileByPath('Foo.mkv')).toBeDefined();
    expect(db.getReviewItem('Foo.mkv')).toBeUndefined();
  });

  it('series episode: creates series row + episode row at requested S/E', async () => {
    const r = await applyIdentity(
      'Show/S01E02.mkv',
      { tmdbId: 200, type: 'series', title: 'Show', year: 2010 },
      { confidence: 0.9, season: 1, episode: 2, mtime: 1, scannedAt: 2 },
      { db },
    );
    expect(r.kind).toBe('episode');
    const seriesRows = db.raw.prepare(`SELECT * FROM media_items WHERE type='series'`).all() as Array<{ id: number; tmdb_id: number; title: string }>;
    expect(seriesRows).toHaveLength(1);
    expect(seriesRows[0]!.tmdb_id).toBe(200);
    const ep = db.getEpisodeByPath('Show/S01E02.mkv')!;
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(2);
  });

  it('series episode: extracts S/E from path when not supplied', async () => {
    const r = await applyIdentity(
      'Show/Season 1/Show.S01E03.mkv',
      { tmdbId: 200, type: 'series', title: 'Show', year: 2010 },
      { confidence: 0.9, mtime: 1, scannedAt: 2 },
      { db },
    );
    expect(r.kind).toBe('episode');
    const ep = db.getEpisodeByPath('Show/Season 1/Show.S01E03.mkv')!;
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(3);
  });

  // 0.1.14 — regression for the LOTR cross-wiring bug. Re-identifying a movie
  // file whose TMDB id happens to already be carried by a *different* movie
  // item must NOT re-parent the file onto that other item (which would orphan
  // — and the scan would then tombstone — the file's own item).
  it('movie: re-identify never re-parents the file onto a different item sharing the tmdb_id', async () => {
    // Fellowship at its own path, holding tmdb 120.
    const fellowship = db.upsertItem({
      path: 'Fellowship.mkv', type: 'movie', tmdb_id: 120, title: 'Fellowship', year: 2001,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: fellowship.id, path: 'Fellowship.mkv', mtime: 1, scanned_at: 1 });
    // ROTK at its own path, but (corrupted) ALSO carrying tmdb 120.
    const rotk = db.upsertItem({
      path: 'ROTK.mkv', type: 'movie', tmdb_id: 120, title: 'wrong', year: 2003,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: rotk.id, path: 'ROTK.mkv', mtime: 1, scanned_at: 1 });

    // Re-identify ROTK's file to its real identity (tmdb 122).
    await applyIdentity(
      'ROTK.mkv',
      { tmdbId: 122, type: 'movie', title: 'The Return of the King', year: 2003 },
      { confidence: 1, mtime: 1, scannedAt: 2 },
      { db },
    );

    // ROTK's file stays on ROTK's item, which now holds the correct tmdb id.
    const file = db.getMediaFileByPath('ROTK.mkv')!;
    expect(file.item_id).toBe(rotk.id);
    const rotkRow = db.getByPath('ROTK.mkv')!;
    expect(rotkRow.tmdb_id).toBe(122);
    expect(rotkRow.title).toBe('The Return of the King');
    // Fellowship's file is untouched.
    expect(db.getMediaFileByPath('Fellowship.mkv')!.item_id).toBe(fellowship.id);
  });

  it('movie: a new rip still merges onto the existing item with the same tmdb_id (multi-rip)', async () => {
    const original = db.upsertItem({
      path: 'Naussica/RM10.mkv', type: 'movie', tmdb_id: 81, title: 'Nausicaa', year: 1984,
      poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
    });
    db.upsertMediaFile({ item_id: original.id, path: 'Naussica/RM10.mkv', mtime: 1, scanned_at: 1 });
    // A second rip at a new path, same movie. No item owns this path yet → the
    // tmdb merge must still attach it to the existing item.
    await applyIdentity(
      'Naussica/RM14.mkv',
      { tmdbId: 81, type: 'movie', title: 'Nausicaa', year: 1984 },
      { confidence: 1, mtime: 1, scannedAt: 2 },
      { db },
    );
    expect(db.getMediaFileByPath('Naussica/RM14.mkv')!.item_id).toBe(original.id);
    // Still one movie item.
    const movies = db.raw.prepare(`SELECT id FROM media_items WHERE type='movie'`).all();
    expect(movies).toHaveLength(1);
  });

  it('reuses existing series row when one already exists for the tmdb_id', async () => {
    const existing = db.upsertItem({
      path: 'Show', type: 'series', tmdb_id: 200, title: 'Show', year: 2010,
      poster_url: null, backdrop_url: null, overview: null, mtime: 0, scanned_at: 1,
    });
    const r = await applyIdentity(
      'Show/Season 1/S01E04.mkv',
      { tmdbId: 200, type: 'series', title: 'Show', year: 2010 },
      { confidence: 0.9, mtime: 1, scannedAt: 2 },
      { db },
    );
    expect(r.kind).toBe('episode');
    if (r.kind === 'episode') expect(r.seriesId).toBe(existing.id);
    const seriesRows = db.raw.prepare(`SELECT id FROM media_items WHERE type='series'`).all();
    expect(seriesRows).toHaveLength(1);
  });
});
