/**
 * DB access for skip intro / credits (0.2.1). Uses `db.raw` directly so the
 * main DbHandle interface doesn't grow a dozen theme-only methods.
 */

import type { DbHandle } from '../db.js';
import { decodeRaw, encodeFp, type ThemeKind } from './match.js';

export interface EpisodeFpRow {
  episodeId: number;
  path: string;
  season: number;
  episode: number;
  head: Uint32Array | null;
  tail: Uint32Array | null;
  tailOffsetS: number;
  markersVersion: number | null;
}

export interface ThemeRow {
  id: number;
  kind: ThemeKind;
  fingerprint: Uint32Array;
  durationS: number;
}

export interface Markers {
  introStart: number | null;
  introEnd: number | null;
  creditsStart: number | null;
  creditsEnd: number | null;
}

export interface SkipPrefs {
  autoIntro: boolean;
  autoCredits: boolean;
}

const toFp = (b: Buffer | null): Uint32Array | null => (b && b.length >= 4 ? decodeRaw(b) : null);

export interface NeedsFingerprintRow {
  id: number;
  path: string;
  mtime: number;
  seriesId: number;
  probeJson: string | null;
  season: number;
  episode: number;
  seriesTitle: string | null;
}

/** Alive episodes whose fingerprint is missing, stale, or from an older capture version. */
export function listEpisodesNeedingFingerprint(
  db: DbHandle,
  version: number,
): NeedsFingerprintRow[] {
  return db.raw
    .prepare(
      `SELECT e.id, e.path, e.mtime, e.series_id AS seriesId, e.probe_json AS probeJson,
              e.season, e.episode, m.title AS seriesTitle
       FROM episodes e
       JOIN media_items m ON m.id = e.series_id
       LEFT JOIN episode_fingerprints f ON f.episode_id = e.id
       WHERE e.deleted_at IS NULL
         AND (f.episode_id IS NULL OR f.mtime != e.mtime OR f.version < ?)
       ORDER BY e.series_id, e.season, e.episode`,
    )
    .all(version) as NeedsFingerprintRow[];
}

export function saveEpisodeFingerprint(
  db: DbHandle,
  input: { episodeId: number; mtime: number; version: number; head: Uint32Array | null; tail: Uint32Array | null; tailOffsetS: number | null },
): void {
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO episode_fingerprints (episode_id, mtime, version, head_fp, tail_fp, tail_offset_s, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(episode_id) DO UPDATE SET
           mtime = excluded.mtime, version = excluded.version, head_fp = excluded.head_fp,
           tail_fp = excluded.tail_fp, tail_offset_s = excluded.tail_offset_s, created_at = excluded.created_at`,
      )
      .run(
        input.episodeId,
        input.mtime,
        input.version,
        input.head ? encodeFp(input.head) : null,
        input.tail ? encodeFp(input.tail) : null,
        input.tailOffsetS,
        Date.now(),
      );
    // New audio → markers must be recomputed.
    db.raw.prepare(`UPDATE episodes SET markers_version = NULL WHERE id = ?`).run(input.episodeId);
  });
  tx();
}

/** Series with at least one alive episode whose markers are missing or from an older version. */
export function listSeriesNeedingMarkers(db: DbHandle, version: number): number[] {
  const rows = db.raw
    .prepare(
      `SELECT DISTINCT e.series_id AS id FROM episodes e
       JOIN episode_fingerprints f ON f.episode_id = e.id
       WHERE e.deleted_at IS NULL AND (e.markers_version IS NULL OR e.markers_version != ?)`,
    )
    .all(version) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

export function listSeriesEpisodeFps(db: DbHandle, seriesId: number): EpisodeFpRow[] {
  const rows = db.raw
    .prepare(
      `SELECT e.id, e.path, e.season, e.episode, e.markers_version AS mv,
              f.head_fp AS head, f.tail_fp AS tail, f.tail_offset_s AS tailOffset
       FROM episodes e
       JOIN episode_fingerprints f ON f.episode_id = e.id
       WHERE e.series_id = ? AND e.deleted_at IS NULL
       ORDER BY e.season, e.episode`,
    )
    .all(seriesId) as Array<{ id: number; path: string; season: number; episode: number; mv: number | null; head: Buffer | null; tail: Buffer | null; tailOffset: number | null }>;
  return rows.map((r) => ({
    episodeId: r.id,
    path: r.path,
    season: r.season,
    episode: r.episode,
    head: toFp(r.head),
    tail: toFp(r.tail),
    tailOffsetS: r.tailOffset ?? 0,
    markersVersion: r.mv,
  }));
}

export function listThemes(db: DbHandle, seriesId: number, kind: ThemeKind): ThemeRow[] {
  const rows = db.raw
    .prepare(`SELECT id, kind, fingerprint, duration_s FROM theme_fingerprints WHERE series_id = ? AND kind = ? ORDER BY id`)
    .all(seriesId, kind) as Array<{ id: number; kind: ThemeKind; fingerprint: Buffer; duration_s: number }>;
  return rows.map((r) => ({ id: r.id, kind: r.kind, fingerprint: decodeRaw(r.fingerprint), durationS: r.duration_s }));
}

export function listSeasonThemeIds(db: DbHandle, seriesId: number, season: number, kind: ThemeKind): number[] {
  const rows = db.raw
    .prepare(
      `SELECT st.fingerprint_id AS id FROM season_themes st
       JOIN theme_fingerprints t ON t.id = st.fingerprint_id
       WHERE st.series_id = ? AND st.season = ? AND t.kind = ? ORDER BY st.fingerprint_id`,
    )
    .all(seriesId, season, kind) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

export function insertTheme(
  db: DbHandle,
  input: { seriesId: number; kind: ThemeKind; fingerprint: Uint32Array; durationS: number; learnedFrom: number | null },
): number {
  const r = db.raw
    .prepare(
      `INSERT INTO theme_fingerprints (series_id, kind, fingerprint, duration_s, learned_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.seriesId, input.kind, encodeFp(input.fingerprint), input.durationS, input.learnedFrom, Date.now());
  return Number(r.lastInsertRowid);
}

export function linkSeasonTheme(db: DbHandle, seriesId: number, season: number, fingerprintId: number): void {
  db.raw
    .prepare(`INSERT OR IGNORE INTO season_themes (series_id, season, fingerprint_id) VALUES (?, ?, ?)`)
    .run(seriesId, season, fingerprintId);
}

export function writeMarkers(db: DbHandle, episodeId: number, m: Markers, version: number): void {
  db.raw
    .prepare(
      `UPDATE episodes SET intro_start = ?, intro_end = ?, credits_start = ?, credits_end = ?, markers_version = ? WHERE id = ?`,
    )
    .run(m.introStart, m.introEnd, m.creditsStart, m.creditsEnd, version, episodeId);
}

/** Forget a show's learned themes and markers. Fingerprints are kept, so re-learning needs no ffmpeg. */
export function clearSeriesThemes(db: DbHandle, seriesId: number): void {
  const tx = db.raw.transaction(() => {
    db.raw.prepare(`DELETE FROM season_themes WHERE series_id = ?`).run(seriesId);
    db.raw.prepare(`DELETE FROM theme_fingerprints WHERE series_id = ?`).run(seriesId);
    db.raw
      .prepare(
        `UPDATE episodes SET intro_start = NULL, intro_end = NULL, credits_start = NULL, credits_end = NULL, markers_version = NULL
         WHERE series_id = ?`,
      )
      .run(seriesId);
  });
  tx();
}

export function getMarkersByPath(db: DbHandle, relPath: string): Markers | null {
  const r = db.raw
    .prepare(
      `SELECT intro_start, intro_end, credits_start, credits_end, markers_version FROM episodes WHERE path = ?`,
    )
    .get(relPath) as
    | { intro_start: number | null; intro_end: number | null; credits_start: number | null; credits_end: number | null; markers_version: number | null }
    | undefined;
  if (!r || r.markers_version == null) return null;
  if (r.intro_start == null && r.credits_start == null) return null;
  return { introStart: r.intro_start, introEnd: r.intro_end, creditsStart: r.credits_start, creditsEnd: r.credits_end };
}

export function getSkipPrefs(db: DbHandle, seriesId: number): SkipPrefs {
  const r = db.raw
    .prepare(`SELECT auto_intro, auto_credits FROM series_skip_prefs WHERE series_id = ?`)
    .get(seriesId) as { auto_intro: number; auto_credits: number } | undefined;
  return { autoIntro: !!r?.auto_intro, autoCredits: !!r?.auto_credits };
}

export function setSkipPrefs(db: DbHandle, seriesId: number, patch: Partial<SkipPrefs>): SkipPrefs {
  const cur = getSkipPrefs(db, seriesId);
  const next: SkipPrefs = {
    autoIntro: patch.autoIntro ?? cur.autoIntro,
    autoCredits: patch.autoCredits ?? cur.autoCredits,
  };
  db.raw
    .prepare(
      `INSERT INTO series_skip_prefs (series_id, auto_intro, auto_credits, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET auto_intro = excluded.auto_intro, auto_credits = excluded.auto_credits, updated_at = excluded.updated_at`,
    )
    .run(seriesId, next.autoIntro ? 1 : 0, next.autoCredits ? 1 : 0, Date.now());
  return next;
}
