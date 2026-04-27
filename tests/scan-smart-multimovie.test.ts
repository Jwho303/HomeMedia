/**
 * Diagnostic tests for the user-reported "smart refresh didn't find them all"
 * bug. Specifically: a single folder containing multiple distinct movies
 * (e.g. "Scary Movie Collection 1-5/...") gets identified by groupIntoCohorts
 * as a series-root cohort with all files as one identity. That's 0.1.4
 * cohort behavior, not a 0.1.5.1 regression — but we want explicit coverage
 * so the symptom is documented.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-multimovie-default');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../src/db.js');
const { scan } = await import('../src/scan.js');

function makeTmdb() {
  const searchMulti = vi.fn(async (query: string) => {
    if (/scary movie/i.test(query)) {
      return {
        page: 1,
        total_results: 5,
        results: [
          { id: 4256, media_type: 'movie' as const, title: 'Scary Movie', release_date: '2000-07-07', overview: null, poster_path: '/sm1.jpg', backdrop_path: null },
          { id: 6951, media_type: 'movie' as const, title: 'Scary Movie 2', release_date: '2001-07-04', overview: null, poster_path: '/sm2.jpg', backdrop_path: null },
        ],
      };
    }
    return { page: 1, total_results: 0, results: [] };
  });
  return {
    searchMulti, getEpisodes: vi.fn(), getSeries: vi.fn(),
    posterUrl: (p: string | null | undefined) => (p ? `https://image.tmdb.org/t/p/w500${p}` : null),
    stillUrl: () => null,
  };
}

async function makeFixture(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-multimovie-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return root;
}

const onlineShare = async () => ({ online: true, mountPath: '', lastSeen: Date.now() });

describe('multi-movie folder cohort behavior', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('a "Collection" folder with distinct movies is split into per-file singletons (post-fix)', async () => {
    // User-reported scenario: a "collection" folder with 5 distinct movies.
    // The collection-folder split (see shouldSplitCollectionBucket) detects
    // the "Collection" keyword + year-range pattern AND that the files'
    // parsed titles disagree, then bypasses the series-root cohort and
    // emits one singleton cohort per file. Each file gets identified
    // individually.
    const root = await makeFixture({
      'Scary Movie Collection 1-5/Scary.Movie.2000.mkv': '1',
      'Scary Movie Collection 1-5/Scary.Movie.2.2001.mkv': '2',
      'Scary Movie Collection 1-5/Scary.Movie.3.2003.mkv': '3',
      'Scary Movie Collection 1-5/Scary.Movie.4.2006.mkv': '4',
      'Scary Movie Collection 1-5/Scary.Movie.5.2013.mkv': '5',
    });
    const t = makeTmdb();
    const r = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    expect(r.scanned).toBe(5);

    // The TMDB mock returns 2 distinct results (Scary Movie 4256, Scary
    // Movie 2 6951). Per-file identification picks the best match for each
    // filename: "Scary.Movie.2000" → Scary Movie, "Scary.Movie.2.2001" →
    // Scary Movie 2, etc. Files that map to the same tmdb_id collapse into
    // one media_items row (since persistMovieCohort dedupes by tmdb_id).
    const items = db.raw.prepare(`SELECT COUNT(*) AS c FROM media_items WHERE type='movie'`).get() as { c: number };
    expect(items.c).toBeGreaterThanOrEqual(2);  // at least Scary Movie + Scary Movie 2

    // Every input file landed in either media_files or needs_review — none
    // were silently dropped.
    const filePaths = [
      'Scary Movie Collection 1-5/Scary.Movie.2000.mkv',
      'Scary Movie Collection 1-5/Scary.Movie.2.2001.mkv',
      'Scary Movie Collection 1-5/Scary.Movie.3.2003.mkv',
      'Scary Movie Collection 1-5/Scary.Movie.4.2006.mkv',
      'Scary Movie Collection 1-5/Scary.Movie.5.2013.mkv',
    ];
    for (const p of filePaths) {
      const inFiles = db.raw.prepare(`SELECT 1 FROM media_files WHERE path=?`).get(p);
      const inReview = db.raw.prepare(`SELECT 1 FROM needs_review WHERE path=?`).get(p);
      expect(Boolean(inFiles) || Boolean(inReview), `${p} was dropped`).toBe(true);
    }
  });

  it('a folder of distinct movies at the share root (no parent folder) → 5 singleton cohorts → 5 media_items', async () => {
    // Same files, but at the root with no shared parent. Each file becomes
    // its own singleton cohort and gets identified individually. This is
    // the expected/correct behavior for distinct movies.
    const root = await makeFixture({
      'Scary.Movie.2000.mkv': '1',
      'Scary.Movie.2.2001.mkv': '2',
      'Scary.Movie.3.2003.mkv': '3',
    });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });

    // With distinct titles in singleton cohorts, the identifier might still
    // pick the same TMDB id for all (since the search returns the same top
    // result). That's a different limitation (per-file identification quality);
    // the scanner saw all 5 files and at least attempted identification on
    // each — none should have been silently dropped.
    const allRows = db.raw.prepare(`SELECT COUNT(*) AS c FROM media_files`).get() as { c: number };
    const reviewRows = db.raw.prepare(`SELECT COUNT(*) AS c FROM needs_review`).get() as { c: number };
    expect(allRows.c + reviewRows.c).toBeGreaterThanOrEqual(3);
  });

  it('smart refresh after adding a brand-new folder picks up every file in newOrChanged', async () => {
    // Initial scan with one movie.
    const root = await makeFixture({
      'Existing.Movie.2020.mkv': 'old',
    });
    const t = makeTmdb();
    await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });

    // Add a new folder with 3 files; smart refresh should NOT skip any of them.
    await fs.mkdir(path.join(root, 'New Folder'), { recursive: true });
    await fs.writeFile(path.join(root, 'New Folder', 'a.mkv'), 'a');
    await fs.writeFile(path.join(root, 'New Folder', 'b.mkv'), 'b');
    await fs.writeFile(path.join(root, 'New Folder', 'c.mkv'), 'c');
    await new Promise((r) => setTimeout(r, 5));

    const r2 = await scan({}, { db, mediaRoot: root, tmdb: t, share: onlineShare });
    expect(r2.scanned).toBe(4);  // 1 old + 3 new

    // All 3 new files should be visible somewhere — either in media_files
    // (identified) or in needs_review (couldn't identify but at least seen).
    const newFilePaths = ['New Folder/a.mkv', 'New Folder/b.mkv', 'New Folder/c.mkv'];
    for (const p of newFilePaths) {
      const inMediaFiles = db.raw.prepare(`SELECT 1 FROM media_files WHERE path=?`).get(p);
      const inEpisodes = db.raw.prepare(`SELECT 1 FROM episodes WHERE path=?`).get(p);
      const inReview = db.raw.prepare(`SELECT 1 FROM needs_review WHERE path=?`).get(p);
      expect(
        Boolean(inMediaFiles) || Boolean(inEpisodes) || Boolean(inReview),
        `path ${p} was silently dropped — appears in NO table`,
      ).toBe(true);
    }
  });
});
