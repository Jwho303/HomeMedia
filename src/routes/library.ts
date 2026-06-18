import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDb,
  type MediaItemRow,
  type EpisodeRow,
  type EpisodeWithPlaybackRow,
  type ItemPlaybackAggregate,
} from '../db.js';
import { config } from '../config.js';
import { toNativeAbsolute } from '../paths.js';
import { tryAcquire } from '../scan-lock.js';

interface LibraryItemDto {
  id: number;
  path: string;
  type: 'movie' | 'series';
  tmdbId: number | null;
  title: string | null;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  // 0.1.3.2 — home-screen metadata
  genres: string[];
  runtimeSeconds: number | null;
  // 0.1.3.2 — playback aggregate per item
  position: number;
  duration: number;
  watched: boolean;
  watchedAt: number | null;
  addedAt: number;
  lastPlayedAt: number | null;
  // 0.1.8 — IMDb rating /10 from OMDb. Null when unknown (no IMDb id mapped,
  // no OMDb key, OMDb has no rating, or rating fetch hasn't run yet). The
  // frontend renders a star pill in the top-left of the poster when present.
  imdbRating: number | null;
  imdbVotes: number | null;
  /** 0.1.10 — soft-delete tombstone (epoch ms). Null when alive. Search view
   *  uses this to render a dimmed "(not on disk)" tile and disable the play
   *  affordance. Default lists never include rows where this is non-null. */
  deletedAt: number | null;
}

function parseGenres(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function toDto(
  row: MediaItemRow,
  pb: ItemPlaybackAggregate = { position: 0, duration: 0, watched: false, watchedAt: null, lastPlayedAt: null },
  playablePath?: string,
): LibraryItemDto {
  return {
    id: row.id,
    // For movies, prefer the playable file path from media_files when the
    // item path is a folder (foldered single-file rips, multi-rip cohorts).
    // Series keep the item.path — series clicks navigate, not play.
    path: playablePath ?? row.path,
    type: row.type,
    tmdbId: row.tmdb_id,
    title: row.title,
    year: row.year,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    overview: row.overview,
    genres: parseGenres(row.genres_json),
    runtimeSeconds: row.runtime_seconds,
    position: pb.position,
    duration: pb.duration,
    watched: pb.watched,
    watchedAt: pb.watchedAt,
    addedAt: row.mtime,
    lastPlayedAt: pb.lastPlayedAt,
    imdbRating: row.imdb_rating,
    imdbVotes: row.imdb_votes,
    deletedAt: row.deleted_at ?? null,
  };
}

const VIDEO_EXT_RE = /\.(mkv|mp4|m4v|avi|mov|webm)$/i;

/** When `media_items.path` for a movie is a folder (no video extension) but
 *  `media_files` has a real file row, return the file path so the home grid's
 *  playHref points at something the stream route can actually serve. */
function resolvePlayablePathForMovie(
  row: MediaItemRow,
  files: { path: string }[],
): string | undefined {
  if (row.type !== 'movie') return undefined;
  if (VIDEO_EXT_RE.test(row.path)) return undefined;
  const first = files[0];
  return first?.path;
}

interface EpisodeDto {
  id: number;
  path: string;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  stillUrl: string | null;
  /** Expected runtime in seconds: TMDB episode_run_time → ffprobe cache → null. (0.1.3.1) */
  runtimeSeconds: number | null;
  /** Resume position in seconds; 0 when no playback row. (0.1.3.1) */
  position: number;
  /** Player-reported duration in seconds; 0 when never played. (0.1.3.1) */
  duration: number;
  /** True iff playback_state.watched = 1. (0.1.3.1) */
  watched: boolean;
  /** Epoch ms; null if never watched. (0.1.3.1) */
  watchedAt: number | null;
}

/** Resolve the runtime to advertise on the duration badge.
 *  Order: scanner-stored TMDB runtime → ffprobe cache → null. (0.1.3.1 D3) */
export function resolveRuntime(row: EpisodeRow): number | null {
  if (row.runtime_seconds != null) return row.runtime_seconds;
  if (row.probe_json) {
    try {
      const probe = JSON.parse(row.probe_json) as { durationSeconds?: number };
      if (typeof probe.durationSeconds === 'number' && probe.durationSeconds > 0) {
        return Math.round(probe.durationSeconds);
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  return null;
}

function toEpisodeDto(row: EpisodeWithPlaybackRow): EpisodeDto {
  const pb = row.playback;
  return {
    id: row.id,
    path: row.path,
    season: row.season,
    episode: row.episode,
    title: row.title,
    overview: row.overview,
    stillUrl: row.still_url,
    runtimeSeconds: resolveRuntime(row),
    position: pb ? pb.position_seconds : 0,
    duration: pb ? pb.duration_seconds : 0,
    watched: pb ? pb.watched === 1 : false,
    watchedAt: pb ? pb.watched_at : null,
  };
}

const libraryQuerySchema = z.object({
  includeStale: z.union([z.literal('true'), z.literal('false')]).optional(),
});

const seriesParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/library', async (req, reply) => {
    const parsed = libraryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_query' });
    }
    const includeStale = parsed.data.includeStale === 'true';
    const db = getDb();
    const rows = db.listLibraryWithPlayback({ includeStale });
    const movies: LibraryItemDto[] = [];
    const series: LibraryItemDto[] = [];
    for (const r of rows) {
      let playable: string | undefined;
      if (r.item.type === 'movie') {
        const files = db.getMediaFilesForItem(r.item.id);
        playable = resolvePlayablePathForMovie(r.item, files);
      }
      (r.item.type === 'movie' ? movies : series).push(
        toDto(r.item, r.playback, playable),
      );
    }
    return { movies, series };
  });

  app.get('/api/series/:id', async (req, reply) => {
    const parsed = seriesParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    const db = getDb();
    const result = db.getSeries(parsed.data.id);
    if (!result) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return {
      series: toDto(result.item),
      episodes: result.episodes.map(toEpisodeDto),
    };
  });

  // Continue Watching — unified, recency-ordered list of in-progress items. (0.1.3.2)
  app.get('/api/continue', async (_req, _reply) => {
    const db = getDb();
    const rows = db.getContinueWatching(25);
    return { items: rows };
  });

  // Mark a movie or series item watched / unwatched in one shot. For series
  // this fans out across every episode; for movies it's the movie's own
  // playback row. (0.1.3.2)
  app.post('/api/items/:id/watched', async (req, reply) => {
    const idParsed = seriesParamsSchema.safeParse(req.params);
    if (!idParsed.success) return reply.code(400).send({ error: 'bad_id' });
    const bodyParsed = z
      .object({ watched: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!bodyParsed.success) return reply.code(400).send({ error: 'bad_body' });

    const db = getDb();
    const item = db.raw
      .prepare<[number], { id: number; type: 'movie' | 'series'; path: string }>(
        `SELECT id, type, path FROM media_items WHERE id = ?`,
      )
      .get(idParsed.data.id);
    if (!item) return reply.code(404).send({ error: 'not_found' });

    const now = Date.now();
    if (item.type === 'movie') {
      // For movies, paths to mark are every media_files row (multi-rip movies),
      // falling back to the item path itself.
      const files = db.getMediaFilesForItem(item.id);
      const paths = files.length > 0 ? files.map((f) => f.path) : [item.path];
      for (const p of paths) {
        if (bodyParsed.data.watched) db.setWatched(p, true, now);
        else db.clearPlayback(p);
      }
    } else {
      const paths = db.listEpisodePathsForSeries(item.id);
      for (const p of paths) {
        if (bodyParsed.data.watched) db.setWatched(p, true, now);
        else db.clearPlayback(p);
      }
    }
    return reply.code(204).send();
  });

  // 0.1.14 — Hidden-items recovery surface (Settings → Library health).
  //
  // A movie/series can be tombstoned (deleted_at != NULL) yet still have its
  // file on disk — the LOTR cross-wiring bug being the motivating case. The
  // home grid hides these, and re-scan alone won't surface them (the file is
  // "alive" on disk, just attached to the wrong item). These endpoints let a
  // non-technical user see and recover them without a full library reset.

  // List tombstoned items whose representative file STILL EXISTS on disk. The
  // disk check runs on request (accurate, modest cost for a settings screen).
  app.get('/api/library/hidden', async () => {
    const db = getDb();
    const root = config.mediaRoot;
    const rows = db.raw
      .prepare<[], MediaItemRow>(
        `SELECT * FROM media_items WHERE deleted_at IS NOT NULL ORDER BY title ASC`,
      )
      .all();

    const out: Array<{
      id: number;
      type: 'movie' | 'series';
      title: string | null;
      year: number | null;
      posterUrl: string | null;
      path: string;
      deletedAt: number | null;
    }> = [];

    for (const row of rows) {
      // The path to probe on disk: for movies, the playable file (the item's
      // own path, or any media_files row — even tombstoned ones still record
      // the path); for series, the most recent episode path.
      const probePath = await firstExistingPath(db, row, root);
      if (!probePath) continue; // genuinely gone from disk — correctly hidden.
      out.push({
        id: row.id,
        type: row.type,
        title: row.title,
        year: row.year,
        posterUrl: row.poster_url,
        path: probePath,
        deletedAt: row.deleted_at ?? null,
      });
    }
    return { items: out };
  });

  // Restore a hidden item cheaply: re-parent any on-disk file that belongs to
  // it by path, clear the tombstone, and revive its on-disk children. No TMDB
  // calls — the item keeps its existing (already-correct) metadata. Use this
  // when the item just needs to reappear; use manual-identify to re-identify.
  app.post('/api/library/hidden/:id/restore', async (req, reply) => {
    const parsed = seriesParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_id' });

    const release = tryAcquire();
    if (!release) return reply.code(409).send({ error: 'scan_in_progress' });
    try {
      const db = getDb();
      const item = db.raw
        .prepare<[number], MediaItemRow>(`SELECT * FROM media_items WHERE id = ?`)
        .get(parsed.data.id);
      if (!item) return reply.code(404).send({ error: 'not_found' });

      const root = config.mediaRoot;
      const restored = db.raw.transaction(() => {
        if (item.type === 'movie') {
          // Re-point any media_files row whose path equals this item's own path
          // (the mis-parent case) back to this item, then revive its files.
          db.raw
            .prepare<[number, string]>(
              `UPDATE media_files SET item_id = ?, deleted_at = NULL WHERE path = ?`,
            )
            .run(item.id, item.path);
          db.raw
            .prepare<[number]>(
              `UPDATE media_files SET deleted_at = NULL WHERE item_id = ?`,
            )
            .run(item.id);
        } else {
          db.raw
            .prepare<[number]>(
              `UPDATE episodes SET deleted_at = NULL WHERE series_id = ?`,
            )
            .run(item.id);
        }
        db.raw
          .prepare<[number]>(`UPDATE media_items SET deleted_at = NULL WHERE id = ?`)
          .run(item.id);
      });
      restored();

      // Confirm the item actually has a live, on-disk child now; if not, the
      // restore was cosmetic and the next scan would re-tombstone it. Report
      // that honestly rather than claiming success.
      const onDisk = await firstExistingPath(
        db,
        db.raw.prepare<[number], MediaItemRow>(`SELECT * FROM media_items WHERE id = ?`).get(item.id)!,
        root,
      );
      return { ok: true, restored: onDisk != null, id: item.id };
    } finally {
      release();
    }
  });
}

/** Resolve the first path belonging to `row` that still exists on disk, or
 *  null if none do. Movies: the item path + every media_files path (including
 *  tombstoned ones — we're checking disk, not DB aliveness). Series: every
 *  episode path. */
async function firstExistingPath(
  db: ReturnType<typeof getDb>,
  row: MediaItemRow,
  root: string,
): Promise<string | null> {
  const candidates: string[] = [];
  if (row.type === 'movie') {
    candidates.push(row.path);
    const files = db.raw
      .prepare<[number], { path: string }>(`SELECT path FROM media_files WHERE item_id = ?`)
      .all(row.id);
    for (const f of files) candidates.push(f.path);
  } else {
    const eps = db.raw
      .prepare<[number], { path: string }>(
        `SELECT path FROM episodes WHERE series_id = ? ORDER BY season DESC, episode DESC`,
      )
      .all(row.id);
    for (const e of eps) candidates.push(e.path);
  }
  for (const rel of candidates) {
    const abs = toNativeAbsolute(rel, root);
    try {
      await fs.stat(abs);
      return rel;
    } catch {
      /* not on disk — try next */
    }
  }
  return null;
}
