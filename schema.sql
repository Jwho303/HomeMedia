-- HomeMedia schema. Idempotent; safe to apply on every open.
-- Source of truth referenced by 0.1.1 D4.

-- 0.1.10 — every refresh opens a row here. `latestRunAt` is derived from
-- MAX(finished_at WHERE status='ok'); `deleted_at` timestamps on media rows
-- are set to the run's `started_at`, giving a stable cross-reference.
CREATE TABLE IF NOT EXISTS scan_runs (
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,                 -- NULL while running
  status             TEXT NOT NULL,           -- 'running' | 'ok' | 'error'
  mode               TEXT NOT NULL,           -- 'smart' | 'hard' | 'reprobe-item' | …
  files_walked       INTEGER,
  files_dirty        INTEGER,
  files_disappeared  INTEGER,
  files_resurrected  INTEGER,
  error_message      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);

CREATE TABLE IF NOT EXISTS media_items (
  id                  INTEGER PRIMARY KEY,
  path                TEXT UNIQUE NOT NULL,   -- POSIX relative, e.g. 'The Bear/S01E01.mkv' for movies, 'The Bear' for series
  type                TEXT NOT NULL,          -- 'movie' | 'series'
  tmdb_id             INTEGER,
  imdb_id             TEXT,                   -- cross-source primary key (0.1.1.3)
  tvdb_id             INTEGER,                -- TVDB id when known (0.1.1.3)
  title               TEXT,
  year                INTEGER,
  poster_url          TEXT,
  backdrop_url        TEXT,
  overview            TEXT,
  confidence          REAL,                   -- 0..1, winning candidate score (0.1.1.1)
  identification_json TEXT,                   -- JSON: full Candidate breakdown for audit (0.1.1.1)
  probe_json          TEXT,                   -- JSON: ffprobe result {container, videoCodec, audioCodec, durationSeconds} (0.1.4)
  genres_json         TEXT,                   -- JSON array of genre name strings from TMDB (0.1.3.2)
  runtime_seconds     INTEGER,                -- movies: TMDB runtime in seconds; null for series rows (0.1.3.2)
  imdb_rating         REAL,                   -- IMDb /10 rating from OMDb's `imdbRating` (0.1.8)
  imdb_votes          INTEGER,                -- IMDb vote count from OMDb's `imdbVotes` (0.1.8)
  mtime               INTEGER NOT NULL,
  scanned_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);

CREATE TABLE IF NOT EXISTS episodes (
  id                  INTEGER PRIMARY KEY,
  series_id           INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  path                TEXT UNIQUE NOT NULL,
  season              INTEGER NOT NULL,
  episode             INTEGER NOT NULL,
  title               TEXT,
  overview            TEXT,
  still_url           TEXT,
  confidence          REAL,                   -- (0.1.1.1)
  identification_json TEXT,                   -- (0.1.1.1)
  probe_json          TEXT,                   -- JSON: ffprobe result (0.1.4)
  runtime_seconds     INTEGER,                -- TMDB episode_run_time in seconds; null when unknown (0.1.3.1)
  mtime               INTEGER NOT NULL,
  scanned_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);
CREATE INDEX IF NOT EXISTS idx_episodes_season_ep ON episodes(series_id, season, episode);

-- Files we couldn't identify with high enough confidence. Consumed by 0.1.1.3 manual rescue.
CREATE TABLE IF NOT EXISTS needs_review (
  path        TEXT PRIMARY KEY,                -- POSIX-relative
  reason      TEXT NOT NULL,                   -- 'no_results' | 'low_score' | 'ambiguous' | 'tmdb_error' | 'episode_unresolved'
  candidates  TEXT NOT NULL,                   -- JSON array of top-3 Candidate objects
  added_at    INTEGER NOT NULL,
  scanned_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_needs_review_reason ON needs_review(reason);

CREATE TABLE IF NOT EXISTS playback_state (
  path              TEXT PRIMARY KEY,
  position_seconds  REAL NOT NULL,
  duration_seconds  REAL NOT NULL,
  watched           INTEGER NOT NULL DEFAULT 0,
  watched_at        INTEGER,
  updated_at        INTEGER NOT NULL
);

-- Playable files belonging to a media_items row. A movie can have multiple rips
-- (Nausicaä RM10/RM14); a series row owns no media_files (episodes carry their own
-- path). New in 0.1.1.2.
CREATE TABLE IF NOT EXISTS media_files (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  path        TEXT UNIQUE NOT NULL,            -- POSIX-relative; the actual playable file
  mtime       INTEGER NOT NULL,
  scanned_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_files_item ON media_files(item_id);

-- Manual-rescue overrides. When the user identifies a file via `npm run review`, we
-- persist their decision here. The scanner checks this table BEFORE any identification
-- logic (D4) — once set, automated identification can't overrule the user.
CREATE TABLE IF NOT EXISTS manual_overrides (
  path        TEXT PRIMARY KEY,                -- POSIX-relative
  tmdb_id     INTEGER NOT NULL,                -- the chosen identity
  imdb_id     TEXT,                            -- known cross-source id, if any
  tvdb_id     INTEGER,
  type        TEXT NOT NULL,                   -- 'movie' | 'series'
  season      INTEGER,                         -- nullable for movies
  episode     INTEGER,
  reason      TEXT NOT NULL,                   -- 'manual' | 'imdb-link' | 'retitled-search' | 'tvdb-link' | 'tmdb-link'
  decided_at  INTEGER NOT NULL
);
