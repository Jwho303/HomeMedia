import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../../src/db.js';
import { MARKERS_VERSION, runThemePass } from '../../src/themes/pass.js';
import { clearSeriesThemes, saveEpisodeFingerprint } from '../../src/themes/store.js';
import { items, randomFp, rng, windowWith } from './fixtures.js';

const HEAD_S = 240;
const TAIL_S = 200;
const DURATION = 1400;
const TAIL_OFFSET = DURATION - TAIL_S;

let db: DbHandle;
let seriesId: number;
const r = rng(42);

interface EpSpec {
  season: number;
  episode: number;
  opening?: Uint32Array;
  openingAt?: number;
  ending?: Uint32Array;
  endingAt?: number; // seconds into the tail window
}

function addEpisodes(specs: EpSpec[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const s of specs) {
    const path = `Show/S${s.season}E${s.episode}.mkv`;
    const row = db.upsertEpisode({
      series_id: seriesId, path, season: s.season, episode: s.episode,
      title: null, overview: null, still_url: null, mtime: 1, scanned_at: 1,
    });
    saveEpisodeFingerprint(db, {
      episodeId: row.id, mtime: 1, version: 1,
      head: windowWith(HEAD_S, r, s.opening, s.openingAt ?? 0),
      tail: windowWith(TAIL_S, r, s.ending, s.endingAt ?? 0),
      tailOffsetS: TAIL_OFFSET,
    });
    ids.set(`${s.season}x${s.episode}`, row.id);
  }
  return ids;
}

function markers(season: number, episode: number) {
  return db.raw
    .prepare(`SELECT intro_start, intro_end, credits_start, credits_end, markers_version FROM episodes WHERE path = ?`)
    .get(`Show/S${season}E${episode}.mkv`) as { intro_start: number | null; intro_end: number | null; credits_start: number | null; credits_end: number | null; markers_version: number | null };
}

const themeCount = (kind: string): number =>
  (db.raw.prepare(`SELECT COUNT(*) n FROM theme_fingerprints WHERE series_id = ? AND kind = ?`).get(seriesId, kind) as { n: number }).n;
const seasonLinks = (season: number): number[] =>
  (db.raw.prepare(`SELECT fingerprint_id id FROM season_themes WHERE series_id = ? AND season = ? ORDER BY id`).all(seriesId, season) as Array<{ id: number }>).map((x) => x.id);

beforeEach(() => {
  db = openDb(':memory:');
  seriesId = db.upsertItem({
    path: 'Show', type: 'series', tmdb_id: 1, title: 'Show', year: 2000,
    poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1,
  }).id;
});

describe('runThemePass', () => {
  it('learns per season, reuses known themes, learns again when the theme changes', () => {
    const op1 = randomFp(items(40), r);
    const op2 = randomFp(items(30), r);
    const ed1 = randomFp(items(50), r);
    const eps: EpSpec[] = [];
    for (let e = 1; e <= 3; e++) eps.push({ season: 1, episode: e, opening: op1, openingAt: 10 + e * 7, ending: ed1, endingAt: 100 });
    for (let e = 1; e <= 3; e++) eps.push({ season: 2, episode: e, opening: op1, openingAt: 5, ending: ed1, endingAt: 90 });
    for (let e = 1; e <= 3; e++) eps.push({ season: 3, episode: e, opening: op2, openingAt: 60 });
    for (let e = 1; e <= 2; e++) eps.push({ season: 4, episode: e, opening: op2, openingAt: 0 });
    addEpisodes(eps);

    const res = runThemePass(db, seriesId);

    expect(themeCount('opening')).toBe(2);
    expect(themeCount('ending')).toBe(1);
    // S2 reused S1's opening, S4 reused S3's.
    expect(seasonLinks(2)).toEqual(seasonLinks(1));
    expect(seasonLinks(4).length).toBe(1);
    expect(seasonLinks(4)[0]).not.toBe(seasonLinks(1)[0]);
    expect(res.episodesMarked).toBe(11);

    const m = markers(1, 2);
    expect(Math.abs(m.intro_start! - 24)).toBeLessThan(1);
    expect(Math.abs(m.intro_end! - 64)).toBeLessThan(1);
    // Ending times are file-relative (tail offset added) and stop at the theme's end, not the file's.
    expect(Math.abs(m.credits_start! - (TAIL_OFFSET + 100))).toBeLessThan(1);
    expect(Math.abs(m.credits_end! - (TAIL_OFFSET + 150))).toBeLessThan(1);
    expect(m.credits_end!).toBeLessThan(DURATION - 10);
    // A cold open: opening 60 s in.
    expect(Math.abs(markers(3, 1).intro_start! - 60)).toBeLessThan(1);
    // No ending theme in S3.
    expect(markers(3, 1).credits_start).toBeNull();
    expect(markers(3, 1).markers_version).toBe(MARKERS_VERSION);
  });

  it('still learns a season whose first episode has no opening', () => {
    const op = randomFp(items(40), r);
    addEpisodes([
      { season: 1, episode: 1 },
      { season: 1, episode: 2, opening: op, openingAt: 0 },
      { season: 1, episode: 3, opening: op, openingAt: 0 },
    ]);
    runThemePass(db, seriesId);
    expect(markers(1, 1).intro_start).toBeNull();
    expect(markers(1, 2).intro_start).not.toBeNull();
    expect(markers(1, 3).intro_start).not.toBeNull();
  });

  it('marks a one-episode season from a known theme, but never learns from one episode', () => {
    const op = randomFp(items(40), r);
    addEpisodes([
      { season: 1, episode: 1, opening: op },
      { season: 1, episode: 2, opening: op },
      { season: 2, episode: 1, opening: op, openingAt: 30 },
      { season: 3, episode: 1, opening: randomFp(items(40), r) },
    ]);
    runThemePass(db, seriesId);
    expect(Math.abs(markers(2, 1).intro_start! - 30)).toBeLessThan(1);
    expect(markers(3, 1).intro_start).toBeNull();
    expect(themeCount('opening')).toBe(1);
  });

  it('handles a theme change part-way through a season', () => {
    const a = randomFp(items(40), r);
    const b = randomFp(items(35), r);
    addEpisodes([
      { season: 1, episode: 1, opening: a },
      { season: 1, episode: 2, opening: a },
      { season: 1, episode: 3, opening: a },
      { season: 1, episode: 4, opening: b },
      { season: 1, episode: 5, opening: b },
    ]);
    runThemePass(db, seriesId);
    for (let e = 1; e <= 5; e++) expect(markers(1, e).intro_start).not.toBeNull();
    expect(seasonLinks(1).length).toBe(2);
  });

  it('a new episode added later is matched against the known theme without learning', () => {
    const op = randomFp(items(40), r);
    addEpisodes([
      { season: 1, episode: 1, opening: op },
      { season: 1, episode: 2, opening: op },
    ]);
    runThemePass(db, seriesId);
    addEpisodes([{ season: 1, episode: 3, opening: op, openingAt: 12 }]);
    const res = runThemePass(db, seriesId);
    expect(res.themesLearned).toBe(0);
    expect(Math.abs(markers(1, 3).intro_start! - 12)).toBeLessThan(1);
  });

  it('skips up-to-date seasons; force or relearn recomputes', () => {
    const op = randomFp(items(40), r);
    addEpisodes([
      { season: 1, episode: 1, opening: op },
      { season: 1, episode: 2, opening: op },
    ]);
    runThemePass(db, seriesId);
    expect(runThemePass(db, seriesId).episodesMarked).toBe(0);
    expect(runThemePass(db, seriesId, { force: true }).episodesMarked).toBe(2);
    clearSeriesThemes(db, seriesId);
    expect(markers(1, 1).intro_start).toBeNull();
    const res = runThemePass(db, seriesId);
    expect(res.themesLearned).toBe(1);
    expect(markers(1, 1).intro_start).not.toBeNull();
  });
});
