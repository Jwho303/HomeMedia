import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

export interface MediaItemRow {
  id: number;
  path: string;
  type: 'movie' | 'series';
  tmdb_id: number | null;
  imdb_id: string | null;
  tvdb_id: number | null;
  title: string | null;
  year: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  confidence: number | null;
  identification_json: string | null;
  probe_json: string | null;
  /** JSON-stringified `string[]` of genre names; null when unknown. (0.1.3.2) */
  genres_json: string | null;
  /** Movies: TMDB runtime in seconds. Series: null (per-episode runtime lives on episodes). (0.1.3.2) */
  runtime_seconds: number | null;
  /** IMDb /10 rating from OMDb's `imdbRating`; null until populated. (0.1.8) */
  imdb_rating: number | null;
  /** IMDb vote count from OMDb's `imdbVotes`; null until populated. (0.1.8) */
  imdb_votes: number | null;
  mtime: number;
  scanned_at: number;
  /** 0.1.10 — set to the scan_runs.started_at of the run that observed this row's
   *  path missing from disk. NULL means "alive". Cleared on resurrection.
   *  Optional on the type to keep test fixtures concise; SQLite always populates
   *  it (defaulted to NULL on existing rows by the additive migration). */
  deleted_at?: number | null;
}

/** Per-item playback aggregate, returned by `listLibraryWithPlayback` (0.1.3.2).
 *  - movies: pulled from `playback_state` joined to the movie's path.
 *  - series: aggregated across all episode-level `playback_state` rows. */
export interface ItemPlaybackAggregate {
  position: number;
  duration: number;
  watched: boolean;
  watchedAt: number | null;
  lastPlayedAt: number | null;
}

export interface MediaItemWithPlayback {
  item: MediaItemRow;
  playback: ItemPlaybackAggregate;
}

/** One row in `GET /api/continue`. (0.1.3.2) */
export interface ContinueRow {
  type: 'movie' | 'series';
  itemId: number;
  title: string | null;
  posterUrl: string | null;
  /** The path to resume — the movie file itself, OR the specific in-progress episode file. */
  resumePath: string;
  position: number;
  duration: number;
  runtimeSeconds: number | null;
  /** "S{n} · E{n}" for series; null for movies. */
  resumeLabel: string | null;
  lastPlayedAt: number;
}

export interface MediaFileRow {
  id: number;
  item_id: number;
  path: string;
  mtime: number;
  scanned_at: number;
  /** 0.1.10 — soft-delete tombstone. NULL means "alive". */
  deleted_at?: number | null;
}

export interface UpsertMediaFileInput {
  item_id: number;
  path: string;
  mtime: number;
  scanned_at: number;
}

export interface EpisodeRow {
  id: number;
  series_id: number;
  path: string;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  still_url: string | null;
  confidence: number | null;
  identification_json: string | null;
  probe_json: string | null;
  runtime_seconds: number | null;
  mtime: number;
  scanned_at: number;
  /** 0.1.10 — soft-delete tombstone. NULL means "alive". */
  deleted_at?: number | null;
}

/** Episode joined with optional playback_state row, returned by getSeries (0.1.3.1). */
export interface EpisodeWithPlaybackRow extends EpisodeRow {
  playback: PlaybackRow | null;
}

export interface UpsertItemInput {
  path: string;
  type: 'movie' | 'series';
  tmdb_id: number | null;
  imdb_id?: string | null;
  tvdb_id?: number | null;
  title: string | null;
  year: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  confidence?: number | null;
  identification_json?: string | null;
  /** JSON-stringified `string[]` of genre names; undefined leaves any existing value. (0.1.3.2) */
  genres_json?: string | null;
  /** Movies: TMDB runtime in seconds. undefined leaves any existing value. (0.1.3.2) */
  runtime_seconds?: number | null;
  /** IMDb rating /10; undefined leaves any existing value. (0.1.8) */
  imdb_rating?: number | null;
  /** IMDb vote count; undefined leaves any existing value. (0.1.8) */
  imdb_votes?: number | null;
  mtime: number;
  scanned_at: number;
}

export interface ManualOverrideRow {
  path: string;
  tmdb_id: number;
  imdb_id: string | null;
  tvdb_id: number | null;
  type: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  reason: string;
  decided_at: number;
}

export interface ManualOverrideInput {
  path: string;
  tmdb_id: number;
  imdb_id?: string | null;
  tvdb_id?: number | null;
  type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  reason: string;
  decided_at: number;
}

export interface UpsertEpisodeInput {
  series_id: number;
  path: string;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  still_url: string | null;
  confidence?: number | null;
  identification_json?: string | null;
  runtime_seconds?: number | null;
  mtime: number;
  scanned_at: number;
}

export interface PlaybackRow {
  path: string;
  position_seconds: number;
  duration_seconds: number;
  watched: number;
  watched_at: number | null;
  updated_at: number;
}

export interface UpsertPlaybackInput {
  path: string;
  position: number;
  duration: number;
  /** When `true`, force watched=1 + watched_at=now regardless of position/duration ratio.
   *  When undefined or false, the legacy 95% threshold rule applies. */
  watched?: boolean;
  updated_at: number;
}

export interface ReviewItemInput {
  path: string;
  reason: string;
  candidates: string;     // JSON
  added_at: number;
  scanned_at: number;
}

export interface ReviewItemRow {
  path: string;
  reason: string;
  candidates: string;
  added_at: number;
  scanned_at: number;
  /** 0.1.10 — soft-delete tombstone. NULL means "alive". */
  deleted_at?: number | null;
}

export interface AudioStream {
  /** ffprobe global stream index — for diagnostics. */
  index: number;
  /** Local index within audio streams (used by ffmpeg `-map 0:a:<n>`). */
  audioIndex: number;
  codec: string;
  /** ISO 639 language tag from `tags.language`, or null. */
  language: string | null;
  /** Stream title from `tags.title`, or null. */
  title: string | null;
  channels: number;
  /** ffprobe `disposition.default`. */
  default: boolean;
  /** ffprobe `disposition.forced`. */
  forced: boolean;
}

export interface SubStream {
  /** ffprobe global stream index — for diagnostics. */
  index: number;
  /** Local index within subtitle streams (used by ffmpeg `-map 0:s:<n>`). */
  subIndex: number;
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  /** False for image-based subs (PGS/VobSub) — those need OCR to convert
   *  to text. The frontend filters them out of the picker for v1. */
  textBased: boolean;
}

export interface Chapter {
  /** 0-based index. */
  index: number;
  startSeconds: number;
  endSeconds: number;
  title: string | null;
}

export interface ProbeResult {
  container: string;
  videoCodec: string;
  audioCodec: string;
  durationSeconds: number;
  /** mtime of the file at the time the probe ran. Used by the prober's mtime
   *  gate. Optional for back-compat — older v1 blobs won't have it. (0.1.4.3) */
  probedAtMtime?: number;
  /** Every audio stream the file contains. (0.1.4.3) */
  audioStreams?: AudioStream[];
  /** Every subtitle stream the file contains. (0.1.4.3) */
  subStreams?: SubStream[];
  /** Chapter markers parsed from the file. (0.1.4.3) */
  chapters?: Chapter[];
}

/** 0.1.10 — one row per scan lifecycle. `started_at` is the canonical
 *  timestamp written into `deleted_at` columns when a path goes missing. */
export interface ScanRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'error';
  mode: string;
  files_walked: number | null;
  files_dirty: number | null;
  files_disappeared: number | null;
  files_resurrected: number | null;
  error_message: string | null;
}

/** Counts persisted on a successful scan_runs row close. (0.1.10) */
export interface ScanRunCounts {
  filesWalked?: number;
  filesDirty?: number;
  filesDisappeared?: number;
  filesResurrected?: number;
}

export interface DbHandle {
  raw: Database.Database;
  getByPath(path: string): MediaItemRow | undefined;
  getByTmdbId(tmdbId: number, type: 'movie' | 'series'): MediaItemRow | undefined;
  getEpisodeByPath(path: string): EpisodeRow | undefined;
  upsertItem(input: UpsertItemInput): MediaItemRow;
  upsertEpisode(input: UpsertEpisodeInput): EpisodeRow;
  getSeries(id: number): { item: MediaItemRow; episodes: EpisodeWithPlaybackRow[] } | undefined;
  listLibrary(opts?: { includeStale?: boolean }): MediaItemRow[];
  /** Like `listLibrary` but each row carries a per-item playback aggregate. (0.1.3.2) */
  listLibraryWithPlayback(opts?: { includeStale?: boolean }): MediaItemWithPlayback[];
  /** In-progress items, mixed movies + series, ordered by recency. (0.1.3.2) */
  getContinueWatching(limit?: number): ContinueRow[];
  /** 0.1.10 — `MAX(scan_runs.finished_at WHERE status='ok')` (or 0). Replaces
   *  the legacy `MAX(media_items.scanned_at)` freshness reference. */
  latestRunAt(): number;
  upsertReviewItem(input: ReviewItemInput): ReviewItemRow;
  getReviewItem(path: string): ReviewItemRow | undefined;
  clearReviewItem(path: string): void;
  listReview(): ReviewItemRow[];
  getManualOverride(path: string): ManualOverrideRow | undefined;
  setManualOverride(input: ManualOverrideInput): ManualOverrideRow;
  deleteManualOverride(path: string): void;
  listManualOverrides(): ManualOverrideRow[];
  getProbe(path: string): ProbeResult | undefined;
  setProbe(path: string, probe: ProbeResult): void;
  getPlayback(path: string): PlaybackRow | undefined;
  upsertPlayback(input: UpsertPlaybackInput): PlaybackRow;
  /** Wipe playback for a path. Used by "Mark unwatched" / "Reset progress". (0.1.3.2) */
  clearPlayback(path: string): void;
  /** List all episode paths for a series, used to bulk-mark a whole show watched/unwatched. (0.1.3.2) */
  listEpisodePathsForSeries(seriesId: number): string[];
  /** Force-set watched (with watched_at = now) on an existing or new playback row. */
  setWatched(path: string, watched: boolean, now: number): void;
  /** Upsert a playable file. Replaces any existing row keyed by path. */
  upsertMediaFile(input: UpsertMediaFileInput): MediaFileRow;
  getMediaFilesForItem(itemId: number): MediaFileRow[];
  getMediaFileByPath(path: string): MediaFileRow | undefined;
  deleteMediaFile(path: string): void;
  /** 0.1.10 — open a scan_runs row with status='running'. Returns the row id. */
  openScanRun(mode: string): number;
  /** 0.1.10 — close a scan_runs row with status='ok' and finished_at=now. */
  closeScanRunOk(runId: number, counts: ScanRunCounts): void;
  /** 0.1.10 — close a scan_runs row with status='error' and finished_at=now. */
  closeScanRunError(runId: number, message: string): void;
  /** 0.1.10 — fetch a scan_runs row by id (mostly for tests). */
  getScanRun(runId: number): ScanRunRow | undefined;
  /**
   * Wipe library data in one transaction. Two scopes:
   *   - 'library': clears scanned/identified/probed data (media_items, episodes,
   *     media_files, needs_review, scan_runs). The next scan re-identifies and
   *     re-probes everything. PRESERVES manual_overrides (the user's title fixes)
   *     and playback_state (watch history / resume positions).
   *   - 'all': also clears manual_overrides and playback_state — a brand-new DB.
   * Returns the number of rows deleted per table for the confirmation message.
   */
  wipe(scope: 'library' | 'all'): Record<string, number>;
  close(): void;
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openDb(dbPath: string): DbHandle {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  // Additive migration for existing DBs (created before 0.1.1.1). The schema above adds
  // `confidence` and `identification_json` to media_items/episodes, but CREATE TABLE
  // IF NOT EXISTS won't apply column changes to a table that already exists.
  ensureColumn(db, 'media_items', 'confidence', 'REAL');
  ensureColumn(db, 'media_items', 'identification_json', 'TEXT');
  ensureColumn(db, 'episodes', 'confidence', 'REAL');
  ensureColumn(db, 'episodes', 'identification_json', 'TEXT');
  // 0.1.1.3 cross-source identifier columns.
  ensureColumn(db, 'media_items', 'imdb_id', 'TEXT');
  ensureColumn(db, 'media_items', 'tvdb_id', 'INTEGER');
  // 0.1.4 cached ffprobe result.
  ensureColumn(db, 'media_items', 'probe_json', 'TEXT');
  ensureColumn(db, 'episodes', 'probe_json', 'TEXT');
  // 0.1.3.1 TMDB episode_run_time cache.
  ensureColumn(db, 'episodes', 'runtime_seconds', 'INTEGER');
  // 0.1.3.2 home-screen metadata: genres + per-movie runtime.
  ensureColumn(db, 'media_items', 'genres_json', 'TEXT');
  ensureColumn(db, 'media_items', 'runtime_seconds', 'INTEGER');
  // 0.1.8 IMDb rating cache from OMDb.
  ensureColumn(db, 'media_items', 'imdb_rating', 'REAL');
  ensureColumn(db, 'media_items', 'imdb_votes', 'INTEGER');
  // 0.1.10 soft-delete tombstones. Default NULL on existing rows = "alive".
  ensureColumn(db, 'media_items', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'episodes', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'media_files', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'needs_review', 'deleted_at', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_items_deleted_at ON media_items(deleted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_deleted_at    ON episodes(deleted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_files_deleted_at ON media_files(deleted_at)`);

  // 0.1.10 — sweep orphan running rows from a previous server crash. A
  // status='running' row at startup means the server died mid-scan and
  // never closed it; mark as error so latestRunAt() (which only counts
  // 'ok') stays accurate.
  db.prepare(
    `UPDATE scan_runs
     SET status = 'error', error_message = 'server_restart', finished_at = ?
     WHERE status = 'running'`,
  ).run(Date.now());

  // 0.1.1.2 backfill: every existing movie media_items row gets a media_files row at the
  // same path. Series rows DO NOT (their playable files live in `episodes`). Idempotent
  // via WHERE NOT EXISTS — running this on an already-migrated DB is a no-op.
  // The second NOT EXISTS guards against pre-existing media_files rows that already
  // squat on the same path under a different item_id (stale data from an older scan);
  // without it the UNIQUE constraint on media_files.path would crash openDb.
  db.exec(`
    INSERT INTO media_files (item_id, path, mtime, scanned_at)
    SELECT mi.id, mi.path, mi.mtime, mi.scanned_at
    FROM media_items mi
    WHERE mi.type = 'movie'
      AND NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.item_id = mi.id)
      AND NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.path = mi.path);
  `);

  const stmts = {
    getByPath: db.prepare<[string], MediaItemRow>(`SELECT * FROM media_items WHERE path = ?`),
    getByTmdbId: db.prepare<[number, string], MediaItemRow>(
      `SELECT * FROM media_items WHERE tmdb_id = ? AND type = ?`,
    ),
    getEpisodeByPath: db.prepare<[string], EpisodeRow>(`SELECT * FROM episodes WHERE path = ?`),

    upsertItem: db.prepare<UpsertItemInput, MediaItemRow>(`
      INSERT INTO media_items (path, type, tmdb_id, imdb_id, tvdb_id, title, year, poster_url, backdrop_url, overview, confidence, identification_json, genres_json, runtime_seconds, imdb_rating, imdb_votes, mtime, scanned_at)
      VALUES (@path, @type, @tmdb_id, @imdb_id, @tvdb_id, @title, @year, @poster_url, @backdrop_url, @overview, @confidence, @identification_json, @genres_json, @runtime_seconds, @imdb_rating, @imdb_votes, @mtime, @scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        type                = excluded.type,
        tmdb_id             = excluded.tmdb_id,
        imdb_id             = COALESCE(excluded.imdb_id, media_items.imdb_id),
        tvdb_id             = COALESCE(excluded.tvdb_id, media_items.tvdb_id),
        title               = excluded.title,
        year                = excluded.year,
        poster_url          = excluded.poster_url,
        backdrop_url        = excluded.backdrop_url,
        overview            = excluded.overview,
        confidence          = excluded.confidence,
        identification_json = excluded.identification_json,
        genres_json         = COALESCE(excluded.genres_json, media_items.genres_json),
        runtime_seconds     = COALESCE(excluded.runtime_seconds, media_items.runtime_seconds),
        imdb_rating         = COALESCE(excluded.imdb_rating, media_items.imdb_rating),
        imdb_votes          = COALESCE(excluded.imdb_votes, media_items.imdb_votes),
        mtime               = excluded.mtime,
        scanned_at          = excluded.scanned_at,
        deleted_at          = NULL
      RETURNING *
    `),

    upsertEpisode: db.prepare<UpsertEpisodeInput, EpisodeRow>(`
      INSERT INTO episodes (series_id, path, season, episode, title, overview, still_url, confidence, identification_json, runtime_seconds, mtime, scanned_at)
      VALUES (@series_id, @path, @season, @episode, @title, @overview, @still_url, @confidence, @identification_json, @runtime_seconds, @mtime, @scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        series_id           = excluded.series_id,
        season              = excluded.season,
        episode             = excluded.episode,
        title               = excluded.title,
        overview            = excluded.overview,
        still_url           = excluded.still_url,
        confidence          = excluded.confidence,
        identification_json = excluded.identification_json,
        runtime_seconds     = COALESCE(excluded.runtime_seconds, episodes.runtime_seconds),
        mtime               = excluded.mtime,
        scanned_at          = excluded.scanned_at,
        deleted_at          = NULL
      RETURNING *
    `),

    upsertReview: db.prepare<ReviewItemInput, ReviewItemRow>(`
      INSERT INTO needs_review (path, reason, candidates, added_at, scanned_at)
      VALUES (@path, @reason, @candidates, @added_at, @scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        reason     = excluded.reason,
        candidates = excluded.candidates,
        scanned_at = excluded.scanned_at,
        deleted_at = NULL
      RETURNING *
    `),
    getReview: db.prepare<[string], ReviewItemRow>(`SELECT * FROM needs_review WHERE path = ?`),
    clearReview: db.prepare<[string]>(`DELETE FROM needs_review WHERE path = ?`),
    listReview: db.prepare<[], ReviewItemRow>(
      `SELECT * FROM needs_review WHERE deleted_at IS NULL ORDER BY added_at DESC`,
    ),

    getSeriesItem: db.prepare<[number], MediaItemRow>(
      `SELECT * FROM media_items WHERE id = ? AND type = 'series' AND deleted_at IS NULL`,
    ),
    getEpisodes: db.prepare<[number], EpisodeRow>(
      `SELECT * FROM episodes WHERE series_id = ? AND deleted_at IS NULL ORDER BY season ASC, episode ASC`,
    ),
    /** Episodes for a series, joined with their playback_state row (if any). The
     *  playback columns are aliased so they remain distinguishable from episode columns.
     *  0.1.10 — filters `deleted_at IS NULL` so soft-deleted episodes don't appear
     *  in the series-detail view. */
    getEpisodesWithPlayback: db.prepare<
      [number],
      EpisodeRow & {
        pb_path: string | null;
        pb_position_seconds: number | null;
        pb_duration_seconds: number | null;
        pb_watched: number | null;
        pb_watched_at: number | null;
        pb_updated_at: number | null;
      }
    >(`
      SELECT e.*,
             ps.path             AS pb_path,
             ps.position_seconds AS pb_position_seconds,
             ps.duration_seconds AS pb_duration_seconds,
             ps.watched          AS pb_watched,
             ps.watched_at       AS pb_watched_at,
             ps.updated_at       AS pb_updated_at
      FROM episodes e
      LEFT JOIN playback_state ps ON ps.path = e.path
      WHERE e.series_id = ? AND e.deleted_at IS NULL
      ORDER BY e.season ASC, e.episode ASC
    `),

    upsertMediaFile: db.prepare<UpsertMediaFileInput, MediaFileRow>(`
      INSERT INTO media_files (item_id, path, mtime, scanned_at)
      VALUES (@item_id, @path, @mtime, @scanned_at)
      ON CONFLICT(path) DO UPDATE SET
        item_id    = excluded.item_id,
        mtime      = excluded.mtime,
        scanned_at = excluded.scanned_at,
        deleted_at = NULL
      RETURNING *
    `),
    getMediaFilesForItem: db.prepare<[number], MediaFileRow>(
      `SELECT * FROM media_files WHERE item_id = ? AND deleted_at IS NULL ORDER BY path`,
    ),
    getMediaFileByPath: db.prepare<[string], MediaFileRow>(
      `SELECT * FROM media_files WHERE path = ?`,
    ),
    deleteMediaFile: db.prepare<[string]>(`DELETE FROM media_files WHERE path = ?`),

    getPlayback: db.prepare<[string], PlaybackRow>(
      `SELECT * FROM playback_state WHERE path = ?`,
    ),
    upsertPlayback: db.prepare<
      { path: string; position: number; duration: number; watched: number; watched_at: number | null; updated_at: number },
      PlaybackRow
    >(`
      INSERT INTO playback_state (path, position_seconds, duration_seconds, watched, watched_at, updated_at)
      VALUES (@path, @position, @duration, @watched, @watched_at, @updated_at)
      ON CONFLICT(path) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        watched          = excluded.watched,
        watched_at       = excluded.watched_at,
        updated_at       = excluded.updated_at
      RETURNING *
    `),
    deletePlayback: db.prepare<[string]>(`DELETE FROM playback_state WHERE path = ?`),
    listEpisodePathsForSeries: db.prepare<[number], { path: string }>(
      `SELECT path FROM episodes WHERE series_id = ?`,
    ),

    /** 0.1.10 — `listAll` returns every row including soft-deleted (used by
     *  search/admin via `includeStale=true`). The default home path uses
     *  `listAlive` which filters `deleted_at IS NULL`. */
    listAll: db.prepare<[], MediaItemRow>(`SELECT * FROM media_items ORDER BY title ASC`),
    listAlive: db.prepare<[], MediaItemRow>(
      `SELECT * FROM media_items WHERE deleted_at IS NULL ORDER BY title ASC`,
    ),
    /** 0.1.10 — freshness reference is the latest successful scan_runs row. */
    latestRunAt: db.prepare<[], { v: number | null }>(
      `SELECT MAX(finished_at) AS v FROM scan_runs WHERE status = 'ok'`,
    ),

    /**
     * Per-item playback aggregate, joined to all media_items rows.
     *   - Movies: LEFT JOIN onto playback_state by path.
     *   - Series: aggregate over all episode-level playback rows for that series.
     *
     * Each row carries the same MediaItemRow columns plus aggregate columns:
     *   pb_position / pb_duration:    movies → that row; series → 0 (resume lives in /api/continue)
     *   pb_watched:                   movies → playback.watched; series → 1 iff every episode is watched
     *   pb_watched_at:                most recent watched_at across the item's playback rows
     *   pb_last_played_at:            movies → playback_state.updated_at; series → MAX over episodes
     * 0.1.10: the alive/all distinction is `deleted_at IS NULL` rather than the
     * legacy `scanned_at >= MAX(scanned_at)` predicate. Series episode aggregates
     * also gate on `e.deleted_at IS NULL` so soft-deleted episodes don't count
     * against a series's watched-totals.
     * (0.1.3.2)
     */
    listLibraryAggAll: db.prepare<
      [],
      MediaItemRow & {
        pb_position: number | null;
        pb_duration: number | null;
        pb_watched: number | null;
        pb_watched_at: number | null;
        pb_last_played_at: number | null;
        ep_total: number | null;
        ep_watched: number | null;
      }
    >(`
      SELECT mi.*,
             CASE WHEN mi.type = 'movie' THEN ps_mov.position_seconds ELSE 0 END AS pb_position,
             CASE WHEN mi.type = 'movie' THEN ps_mov.duration_seconds ELSE 0 END AS pb_duration,
             CASE
               WHEN mi.type = 'movie' THEN COALESCE(ps_mov.watched, 0)
               WHEN ep_agg.total IS NOT NULL AND ep_agg.total > 0
                    AND ep_agg.watched_count = ep_agg.total THEN 1
               ELSE 0
             END AS pb_watched,
             CASE
               WHEN mi.type = 'movie' THEN ps_mov.watched_at
               ELSE ep_agg.max_watched_at
             END AS pb_watched_at,
             CASE
               WHEN mi.type = 'movie' THEN ps_mov.updated_at
               ELSE ep_agg.max_updated_at
             END AS pb_last_played_at,
             ep_agg.total          AS ep_total,
             ep_agg.watched_count  AS ep_watched
      FROM media_items mi
      LEFT JOIN playback_state ps_mov ON mi.type = 'movie' AND ps_mov.path = mi.path
      LEFT JOIN (
        SELECT e.series_id,
               COUNT(*)              AS total,
               SUM(CASE WHEN ps.watched = 1 THEN 1 ELSE 0 END) AS watched_count,
               MAX(ps.watched_at)    AS max_watched_at,
               MAX(ps.updated_at)    AS max_updated_at
        FROM episodes e
        LEFT JOIN playback_state ps ON ps.path = e.path
        WHERE e.deleted_at IS NULL
        GROUP BY e.series_id
      ) ep_agg ON mi.type = 'series' AND ep_agg.series_id = mi.id
      ORDER BY mi.title ASC
    `),
    listLibraryAggAlive: db.prepare<
      [],
      MediaItemRow & {
        pb_position: number | null;
        pb_duration: number | null;
        pb_watched: number | null;
        pb_watched_at: number | null;
        pb_last_played_at: number | null;
        ep_total: number | null;
        ep_watched: number | null;
      }
    >(`
      SELECT mi.*,
             CASE WHEN mi.type = 'movie' THEN ps_mov.position_seconds ELSE 0 END AS pb_position,
             CASE WHEN mi.type = 'movie' THEN ps_mov.duration_seconds ELSE 0 END AS pb_duration,
             CASE
               WHEN mi.type = 'movie' THEN COALESCE(ps_mov.watched, 0)
               WHEN ep_agg.total IS NOT NULL AND ep_agg.total > 0
                    AND ep_agg.watched_count = ep_agg.total THEN 1
               ELSE 0
             END AS pb_watched,
             CASE
               WHEN mi.type = 'movie' THEN ps_mov.watched_at
               ELSE ep_agg.max_watched_at
             END AS pb_watched_at,
             CASE
               WHEN mi.type = 'movie' THEN ps_mov.updated_at
               ELSE ep_agg.max_updated_at
             END AS pb_last_played_at,
             ep_agg.total          AS ep_total,
             ep_agg.watched_count  AS ep_watched
      FROM media_items mi
      LEFT JOIN playback_state ps_mov ON mi.type = 'movie' AND ps_mov.path = mi.path
      LEFT JOIN (
        SELECT e.series_id,
               COUNT(*)              AS total,
               SUM(CASE WHEN ps.watched = 1 THEN 1 ELSE 0 END) AS watched_count,
               MAX(ps.watched_at)    AS max_watched_at,
               MAX(ps.updated_at)    AS max_updated_at
        FROM episodes e
        LEFT JOIN playback_state ps ON ps.path = e.path
        WHERE e.deleted_at IS NULL
        GROUP BY e.series_id
      ) ep_agg ON mi.type = 'series' AND ep_agg.series_id = mi.id
      WHERE mi.deleted_at IS NULL
      ORDER BY mi.title ASC
    `),

    /**
     * Continue Watching — unified, recency-ordered list of in-progress items.
     *
     * Movies: an item qualifies iff playback exists AND 0 < position < duration*0.9 AND watched=0.
     * Series: collapse to one row per series; the resume row is the most-recently-updated
     *         in-progress episode (same predicate as movies). The series-level title/posterUrl
     *         comes from the series's media_items row.
     * Order: lastPlayedAt (i.e. updated_at) DESC. (0.1.3.2)
     */
    continueWatching: db.prepare<
      [number],
      {
        type: 'movie' | 'series';
        item_id: number;
        title: string | null;
        poster_url: string | null;
        resume_path: string;
        position: number;
        duration: number;
        runtime_seconds: number | null;
        season: number | null;
        episode: number | null;
        last_played_at: number;
      }
    >(`
      WITH movie_rows AS (
        SELECT 'movie'                AS type,
               mi.id                  AS item_id,
               mi.title               AS title,
               mi.poster_url          AS poster_url,
               mi.path                AS resume_path,
               ps.position_seconds    AS position,
               ps.duration_seconds    AS duration,
               mi.runtime_seconds     AS runtime_seconds,
               NULL                   AS season,
               NULL                   AS episode,
               ps.updated_at          AS last_played_at
        FROM media_items mi
        JOIN playback_state ps ON ps.path = mi.path
        WHERE mi.type = 'movie'
          AND mi.deleted_at IS NULL
          AND ps.watched = 0
          AND ps.duration_seconds > 0
          AND ps.position_seconds > 0
          AND ps.position_seconds < ps.duration_seconds * 0.9
      ),
      series_eps AS (
        SELECT mi.id                  AS item_id,
               mi.title               AS title,
               mi.poster_url          AS poster_url,
               e.path                 AS resume_path,
               ps.position_seconds    AS position,
               ps.duration_seconds    AS duration,
               e.runtime_seconds      AS runtime_seconds,
               e.season               AS season,
               e.episode              AS episode,
               ps.updated_at          AS last_played_at
        FROM media_items mi
        JOIN episodes e ON e.series_id = mi.id
        JOIN playback_state ps ON ps.path = e.path
        WHERE mi.type = 'series'
          AND mi.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND ps.watched = 0
          AND ps.duration_seconds > 0
          AND ps.position_seconds > 0
          AND ps.position_seconds < ps.duration_seconds * 0.9
      ),
      series_rows AS (
        SELECT 'series' AS type, se.*
        FROM series_eps se
        WHERE se.last_played_at = (
          SELECT MAX(se2.last_played_at)
          FROM series_eps se2
          WHERE se2.item_id = se.item_id
        )
      )
      SELECT * FROM movie_rows
      UNION ALL
      SELECT * FROM series_rows
      ORDER BY last_played_at DESC
      LIMIT ?
    `),

    getOverride: db.prepare<[string], ManualOverrideRow>(
      `SELECT * FROM manual_overrides WHERE path = ?`,
    ),
    setOverride: db.prepare<ManualOverrideInput, ManualOverrideRow>(`
      INSERT INTO manual_overrides (path, tmdb_id, imdb_id, tvdb_id, type, season, episode, reason, decided_at)
      VALUES (@path, @tmdb_id, @imdb_id, @tvdb_id, @type, @season, @episode, @reason, @decided_at)
      ON CONFLICT(path) DO UPDATE SET
        tmdb_id    = excluded.tmdb_id,
        imdb_id    = excluded.imdb_id,
        tvdb_id    = excluded.tvdb_id,
        type       = excluded.type,
        season     = excluded.season,
        episode    = excluded.episode,
        reason     = excluded.reason,
        decided_at = excluded.decided_at
      RETURNING *
    `),
    deleteOverride: db.prepare<[string]>(`DELETE FROM manual_overrides WHERE path = ?`),
    listOverrides: db.prepare<[], ManualOverrideRow>(
      `SELECT * FROM manual_overrides ORDER BY decided_at DESC`,
    ),

    getProbeItem: db.prepare<[string], { probe_json: string | null }>(
      `SELECT probe_json FROM media_items WHERE path = ?`,
    ),
    getProbeEpisode: db.prepare<[string], { probe_json: string | null }>(
      `SELECT probe_json FROM episodes WHERE path = ?`,
    ),
    getProbeMediaFile: db.prepare<[string], { probe_json: string | null }>(
      `SELECT mi.probe_json AS probe_json FROM media_files mf
       JOIN media_items mi ON mi.id = mf.item_id
       WHERE mf.path = ?`,
    ),
    setProbeItem: db.prepare<[string, string]>(
      `UPDATE media_items SET probe_json = ? WHERE path = ?`,
    ),
    setProbeEpisode: db.prepare<[string, string]>(
      `UPDATE episodes SET probe_json = ? WHERE path = ?`,
    ),
    setProbeMediaFile: db.prepare<[string, string]>(
      `UPDATE media_items SET probe_json = ?
       WHERE id = (SELECT item_id FROM media_files WHERE path = ?)`,
    ),

    // 0.1.10 — scan_runs lifecycle.
    insertScanRun: db.prepare<[number, string], { id: number }>(
      `INSERT INTO scan_runs (started_at, status, mode) VALUES (?, 'running', ?)
       RETURNING id`,
    ),
    closeScanRunOk: db.prepare<
      [number, number | null, number | null, number | null, number | null, number]
    >(
      `UPDATE scan_runs
       SET finished_at = ?, status = 'ok',
           files_walked = ?, files_dirty = ?,
           files_disappeared = ?, files_resurrected = ?
       WHERE id = ?`,
    ),
    closeScanRunError: db.prepare<[number, string, number]>(
      `UPDATE scan_runs
       SET finished_at = ?, status = 'error', error_message = ?
       WHERE id = ?`,
    ),
    getScanRun: db.prepare<[number], ScanRunRow>(
      `SELECT * FROM scan_runs WHERE id = ?`,
    ),
  };

  const handle: DbHandle = {
    raw: db,
    getByPath: (p) => stmts.getByPath.get(p),
    getByTmdbId: (id, type) => stmts.getByTmdbId.get(id, type),
    getEpisodeByPath: (p) => stmts.getEpisodeByPath.get(p),
    upsertItem: (input) => {
      const row = stmts.upsertItem.get({
        ...input,
        imdb_id: input.imdb_id ?? null,
        tvdb_id: input.tvdb_id ?? null,
        confidence: input.confidence ?? null,
        identification_json: input.identification_json ?? null,
        genres_json: input.genres_json ?? null,
        runtime_seconds: input.runtime_seconds ?? null,
        imdb_rating: input.imdb_rating ?? null,
        imdb_votes: input.imdb_votes ?? null,
      });
      if (!row) throw new Error(`upsertItem returned no row for path=${input.path}`);
      return row;
    },
    upsertEpisode: (input) => {
      const row = stmts.upsertEpisode.get({
        ...input,
        confidence: input.confidence ?? null,
        identification_json: input.identification_json ?? null,
        runtime_seconds: input.runtime_seconds ?? null,
      });
      if (!row) throw new Error(`upsertEpisode returned no row for path=${input.path}`);
      return row;
    },
    upsertReviewItem: (input) => {
      const row = stmts.upsertReview.get(input);
      if (!row) throw new Error(`upsertReviewItem returned no row for path=${input.path}`);
      return row;
    },
    getReviewItem: (p) => stmts.getReview.get(p),
    clearReviewItem: (p) => {
      stmts.clearReview.run(p);
    },
    listReview: () => stmts.listReview.all(),
    upsertMediaFile: (input) => {
      const row = stmts.upsertMediaFile.get(input);
      if (!row) throw new Error(`upsertMediaFile returned no row for path=${input.path}`);
      return row;
    },
    getProbe: (p) => {
      const row =
        stmts.getProbeItem.get(p) ??
        stmts.getProbeEpisode.get(p) ??
        stmts.getProbeMediaFile.get(p);
      if (!row || !row.probe_json) return undefined;
      try {
        return JSON.parse(row.probe_json) as ProbeResult;
      } catch {
        return undefined;
      }
    },
    setProbe: (p, probe) => {
      const json = JSON.stringify(probe);
      const r1 = stmts.setProbeItem.run(json, p);
      if (r1.changes > 0) return;
      const r2 = stmts.setProbeEpisode.run(json, p);
      if (r2.changes > 0) return;
      stmts.setProbeMediaFile.run(json, p);
    },
    getPlayback: (p) => stmts.getPlayback.get(p),
    upsertPlayback: (input) => {
      // Watched resolution:
      //   - explicit `watched: true` from the client (0.1.3) forces watched=1
      //   - else the legacy 95%-threshold auto-marks
      //   - else preserve the existing watched/watched_at row so a late seek backwards
      //     doesn't un-watch a previously-watched item
      const existing = stmts.getPlayback.get(input.path);
      const auto = input.duration > 0 && input.position >= input.duration * 0.95;
      let watched: number;
      let watchedAt: number | null;
      if (input.watched === true || auto) {
        watched = 1;
        watchedAt = input.updated_at;
      } else if (existing) {
        watched = existing.watched;
        watchedAt = existing.watched_at;
      } else {
        watched = 0;
        watchedAt = null;
      }
      const row = stmts.upsertPlayback.get({
        path: input.path,
        position: input.position,
        duration: input.duration,
        watched,
        watched_at: watchedAt,
        updated_at: input.updated_at,
      });
      if (!row) throw new Error(`upsertPlayback returned no row for path=${input.path}`);
      return row;
    },
    clearPlayback: (p) => {
      stmts.deletePlayback.run(p);
    },
    listEpisodePathsForSeries: (id) => stmts.listEpisodePathsForSeries.all(id).map((r) => r.path),
    setWatched: (p, watched, now) => {
      // Forces watched=1 (or =0) regardless of position/duration. We preserve
      // any existing position/duration so a "mark watched" doesn't reset
      // resume positions on the file.
      const existing = stmts.getPlayback.get(p);
      stmts.upsertPlayback.run({
        path: p,
        position: existing?.position_seconds ?? 0,
        duration: existing?.duration_seconds ?? 0,
        watched: watched ? 1 : 0,
        watched_at: watched ? now : null,
        updated_at: now,
      });
    },
    getMediaFilesForItem: (id) => stmts.getMediaFilesForItem.all(id),
    getMediaFileByPath: (p) => stmts.getMediaFileByPath.get(p),
    deleteMediaFile: (p) => {
      stmts.deleteMediaFile.run(p);
    },
    getSeries: (id) => {
      const item = stmts.getSeriesItem.get(id);
      if (!item) return undefined;
      const rows = stmts.getEpisodesWithPlayback.all(id);
      const episodes: EpisodeWithPlaybackRow[] = rows.map((r) => {
        const playback: PlaybackRow | null =
          r.pb_path != null
            ? {
                path: r.pb_path,
                position_seconds: r.pb_position_seconds ?? 0,
                duration_seconds: r.pb_duration_seconds ?? 0,
                watched: r.pb_watched ?? 0,
                watched_at: r.pb_watched_at,
                updated_at: r.pb_updated_at ?? 0,
              }
            : null;
        // Strip the pb_* fields from the episode row before returning.
        const {
          pb_path: _p,
          pb_position_seconds: _pos,
          pb_duration_seconds: _dur,
          pb_watched: _w,
          pb_watched_at: _wa,
          pb_updated_at: _ua,
          ...epRow
        } = r;
        return { ...epRow, playback };
      });
      return { item, episodes };
    },
    listLibrary: (opts) => {
      if (opts?.includeStale) return stmts.listAll.all();
      return stmts.listAlive.all();
    },
    listLibraryWithPlayback: (opts) => {
      const rows = opts?.includeStale
        ? stmts.listLibraryAggAll.all()
        : stmts.listLibraryAggAlive.all();
      return rows.map((r) => {
        const {
          pb_position,
          pb_duration,
          pb_watched,
          pb_watched_at,
          pb_last_played_at,
          ep_total: _t,
          ep_watched: _w,
          ...itemRow
        } = r;
        const playback: ItemPlaybackAggregate = {
          position: pb_position ?? 0,
          duration: pb_duration ?? 0,
          watched: pb_watched === 1,
          watchedAt: pb_watched_at ?? null,
          lastPlayedAt: pb_last_played_at ?? null,
        };
        return { item: itemRow as MediaItemRow, playback };
      });
    },
    getContinueWatching: (limit = 25) => {
      const rows = stmts.continueWatching.all(limit);
      return rows.map((r) => {
        const resumeLabel: string | null =
          r.type === 'series' && r.season != null && r.episode != null
            ? `S${r.season} · E${r.episode}`
            : null;
        const out: ContinueRow = {
          type: r.type,
          itemId: r.item_id,
          title: r.title,
          posterUrl: r.poster_url,
          resumePath: r.resume_path,
          position: r.position,
          duration: r.duration,
          runtimeSeconds: r.runtime_seconds,
          resumeLabel,
          lastPlayedAt: r.last_played_at,
        };
        return out;
      });
    },
    latestRunAt: () => stmts.latestRunAt.get()?.v ?? 0,
    openScanRun: (mode) => {
      const row = stmts.insertScanRun.get(Date.now(), mode);
      if (!row) throw new Error(`openScanRun: no id returned`);
      return row.id;
    },
    closeScanRunOk: (runId, counts) => {
      stmts.closeScanRunOk.run(
        Date.now(),
        counts.filesWalked ?? null,
        counts.filesDirty ?? null,
        counts.filesDisappeared ?? null,
        counts.filesResurrected ?? null,
        runId,
      );
    },
    closeScanRunError: (runId, message) => {
      stmts.closeScanRunError.run(Date.now(), message, runId);
    },
    getScanRun: (id) => stmts.getScanRun.get(id),
    getManualOverride: (p) => stmts.getOverride.get(p),
    setManualOverride: (input) => {
      const row = stmts.setOverride.get({
        ...input,
        imdb_id: input.imdb_id ?? null,
        tvdb_id: input.tvdb_id ?? null,
        season: input.season ?? null,
        episode: input.episode ?? null,
      });
      if (!row) throw new Error(`setManualOverride returned no row for path=${input.path}`);
      return row;
    },
    deleteManualOverride: (p) => {
      stmts.deleteOverride.run(p);
    },
    listManualOverrides: () => stmts.listOverrides.all(),
    wipe: (scope) => {
      // Order matters: child tables (FK references to media_items) first, then
      // media_items, so the deletes don't depend on ON DELETE CASCADE firing.
      // 'all' additionally clears the user-owned tables.
      const libraryTables = [
        'media_files',
        'episodes',
        'needs_review',
        'media_items',
        'scan_runs',
      ];
      const userTables = ['manual_overrides', 'playback_state'];
      const tables = scope === 'all' ? [...libraryTables, ...userTables] : libraryTables;
      const counts: Record<string, number> = {};
      const run = db.transaction(() => {
        for (const t of tables) {
          const r = db.prepare(`DELETE FROM ${t}`).run();
          counts[t] = r.changes;
        }
      });
      run();
      // Reclaim the freed pages so the .db file actually shrinks after a wipe.
      // VACUUM can't run inside a transaction, so it follows the txn above.
      db.exec('VACUUM');
      return counts;
    },
    close: () => db.close(),
  };

  return handle;
}

let singleton: DbHandle | null = null;

export function getDb(): DbHandle {
  if (!singleton) singleton = openDb(config.dbPath);
  return singleton;
}

/** Override the process-wide DB handle. Tests use this to point at an in-memory DB. */
export function setDb(handle: DbHandle | null): void {
  singleton = handle;
}
