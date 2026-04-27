import path from 'node:path';
import { extractEpisode, type KnownSeason } from './episode.js';
import * as tmdb from '../tmdb.js';
import type { DbHandle, MediaItemRow } from '../db.js';

export interface ApplyIdentity {
  tmdbId: number;
  imdbId?: string | null;
  tvdbId?: number | null;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
  /** Genre name list from TMDB. (0.1.3.2) */
  genres?: string[] | null;
  /** Movie runtime in seconds; ignored for series. (0.1.3.2) */
  runtimeSeconds?: number | null;
}

export interface ApplyOptions {
  /** Confidence to record on the row. */
  confidence: number;
  /** Free-form audit JSON. */
  identificationJson?: string | undefined;
  /** When set, manually-supplied season/episode (skips extractor). */
  season?: number | undefined;
  episode?: number | undefined;
  /** mtime of the file on disk; used as the row mtime. */
  mtime: number;
  scannedAt: number;
}

export interface ApplyDeps {
  db: DbHandle;
  /** Optional TMDB helpers; absent → no enrichment of episode metadata, just S/E. */
  tmdb?: {
    getEpisodes: typeof tmdb.getEpisodes;
    stillUrl: typeof tmdb.stillUrl;
    getSeries?: typeof tmdb.getSeries;
  };
}

export type ApplyResult =
  | { kind: 'movie'; itemId: number }
  | { kind: 'episode'; seriesId: number; season: number; episode: number };

/**
 * Persist an identified file into `media_items` (movies) or `media_items` + `episodes` (series).
 *
 * For series, the season+episode are determined from the file path unless explicit `season`/
 * `episode` are passed. If extraction fails AND no explicit S/E was provided, throws.
 */
export async function applyIdentity(
  relPosix: string,
  identity: ApplyIdentity,
  opts: ApplyOptions,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  if (identity.type === 'movie') {
    return applyMovie(relPosix, identity, opts, deps);
  }
  return applySeriesEpisode(relPosix, identity, opts, deps);
}

function applyMovie(
  relPosix: string,
  identity: ApplyIdentity,
  opts: ApplyOptions,
  deps: ApplyDeps,
): ApplyResult {
  const existing = deps.db.getByTmdbId(identity.tmdbId, 'movie');
  const genresJson =
    identity.genres && identity.genres.length > 0
      ? JSON.stringify(identity.genres)
      : null;
  const runtimeSeconds = identity.runtimeSeconds ?? null;
  let itemId: number;
  if (existing) {
    deps.db.raw
      .prepare(
        `UPDATE media_items
         SET title = ?, year = ?, imdb_id = COALESCE(?, imdb_id), tvdb_id = COALESCE(?, tvdb_id),
             poster_url = COALESCE(?, poster_url), backdrop_url = COALESCE(?, backdrop_url),
             overview = COALESCE(?, overview),
             confidence = ?, identification_json = ?,
             genres_json = COALESCE(?, genres_json),
             runtime_seconds = COALESCE(?, runtime_seconds),
             scanned_at = ?
         WHERE id = ?`,
      )
      .run(
        identity.title,
        identity.year,
        identity.imdbId ?? null,
        identity.tvdbId ?? null,
        identity.posterUrl ?? null,
        identity.backdropUrl ?? null,
        identity.overview ?? null,
        opts.confidence,
        opts.identificationJson ?? null,
        genresJson,
        runtimeSeconds,
        opts.scannedAt,
        existing.id,
      );
    itemId = existing.id;
  } else {
    const row = deps.db.upsertItem({
      path: relPosix,
      type: 'movie',
      tmdb_id: identity.tmdbId,
      imdb_id: identity.imdbId ?? null,
      tvdb_id: identity.tvdbId ?? null,
      title: identity.title,
      year: identity.year,
      poster_url: identity.posterUrl ?? null,
      backdrop_url: identity.backdropUrl ?? null,
      overview: identity.overview ?? null,
      confidence: opts.confidence,
      identification_json: opts.identificationJson ?? null,
      genres_json: genresJson,
      runtime_seconds: runtimeSeconds,
      mtime: opts.mtime,
      scanned_at: opts.scannedAt,
    });
    itemId = row.id;
  }
  deps.db.upsertMediaFile({
    item_id: itemId,
    path: relPosix,
    mtime: opts.mtime,
    scanned_at: opts.scannedAt,
  });
  if (deps.db.getReviewItem(relPosix)) deps.db.clearReviewItem(relPosix);
  return { kind: 'movie', itemId };
}

async function applySeriesEpisode(
  relPosix: string,
  identity: ApplyIdentity,
  opts: ApplyOptions,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  // Resolve / create the series row.
  let series: MediaItemRow | undefined = deps.db.getByTmdbId(identity.tmdbId, 'series');
  const seriesPath = identity.title;     // path key for synthesized series rows; collisions impossible because tmdb_id keys are checked first
  const genresJson =
    identity.genres && identity.genres.length > 0
      ? JSON.stringify(identity.genres)
      : null;
  if (series) {
    deps.db.raw
      .prepare(
        `UPDATE media_items
         SET title = ?, year = ?, imdb_id = COALESCE(?, imdb_id), tvdb_id = COALESCE(?, tvdb_id),
             poster_url = COALESCE(?, poster_url), backdrop_url = COALESCE(?, backdrop_url),
             overview = COALESCE(?, overview),
             confidence = MAX(COALESCE(confidence, 0), ?),
             identification_json = ?,
             genres_json = COALESCE(?, genres_json),
             scanned_at = ?
         WHERE id = ?`,
      )
      .run(
        identity.title,
        identity.year,
        identity.imdbId ?? null,
        identity.tvdbId ?? null,
        identity.posterUrl ?? null,
        identity.backdropUrl ?? null,
        identity.overview ?? null,
        opts.confidence,
        opts.identificationJson ?? null,
        genresJson,
        opts.scannedAt,
        series.id,
      );
  } else {
    series = deps.db.upsertItem({
      path: seriesPath,
      type: 'series',
      tmdb_id: identity.tmdbId,
      imdb_id: identity.imdbId ?? null,
      tvdb_id: identity.tvdbId ?? null,
      title: identity.title,
      year: identity.year,
      poster_url: identity.posterUrl ?? null,
      backdrop_url: identity.backdropUrl ?? null,
      overview: identity.overview ?? null,
      confidence: opts.confidence,
      identification_json: opts.identificationJson ?? null,
      genres_json: genresJson,
      mtime: 0,
      scanned_at: opts.scannedAt,
    });
  }

  // Determine season & episode.
  let season: number | null = opts.season ?? null;
  let episode: number | null = opts.episode ?? null;
  if (season == null || episode == null) {
    let known: KnownSeason[] | null = null;
    if (deps.tmdb?.getSeries) {
      try {
        const s = await deps.tmdb.getSeries(identity.tmdbId);
        known = s.seasons ? s.seasons.map((sn) => ({ season_number: sn.season_number, episode_count: sn.episode_count })) : null;
      } catch {
        known = null;
      }
    }
    const ep = extractEpisode(relPosix, identity.title, known);
    if (!ep) {
      throw new Error(`could not extract season/episode from path: ${relPosix}`);
    }
    season = ep.season;
    episode = ep.episode;
  }

  // Optional episode metadata enrichment.
  let epTitle: string | null = null;
  let epOverview: string | null = null;
  let epStill: string | null = null;
  let epRuntimeSeconds: number | null = null;
  if (deps.tmdb?.getEpisodes) {
    try {
      const seasonData = await deps.tmdb.getEpisodes(identity.tmdbId, season);
      const e = seasonData.episodes.find((x) => x.episode_number === episode);
      if (e) {
        epTitle = e.name ?? null;
        epOverview = e.overview ?? null;
        epStill = deps.tmdb.stillUrl(e.still_path) ?? null;
        if (typeof e.runtime === 'number' && e.runtime > 0) {
          epRuntimeSeconds = Math.round(e.runtime * 60);
        }
      }
    } catch {
      // Ignore — episode metadata is nice-to-have.
    }
  }

  deps.db.upsertEpisode({
    series_id: series.id,
    path: relPosix,
    season,
    episode,
    title: epTitle,
    overview: epOverview,
    still_url: epStill,
    confidence: opts.confidence,
    identification_json: opts.identificationJson ?? null,
    runtime_seconds: epRuntimeSeconds,
    mtime: opts.mtime,
    scanned_at: opts.scannedAt,
  });

  if (deps.db.getReviewItem(relPosix)) deps.db.clearReviewItem(relPosix);
  return { kind: 'episode', seriesId: series.id, season, episode };
}

/** Used by extras-folder logic; mirrors scan.ts EXTRAS_FOLDER. */
export function dirOf(relPosix: string): string {
  return path.posix.dirname(relPosix);
}
