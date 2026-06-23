import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { tryAcquire } from '../scan-lock.js';
import { shareGuard } from '../middleware/share-guard.js';
import {
  applyChoice,
  resolveAction,
  parseSeInput,
  absoluteToSe,
  candidatesToViews,
  type ReviewAction,
} from '../cli/review-core.js';
import { parseLink, rowToReviewItem } from '../manual-identify.js';
import * as tmdb from '../tmdb.js';

/** One row in the uncategorized list — a debug/catch-all surface over every
 *  alive `needs_review` entry. The `reason` is the raw scanner string shown
 *  only as a debugging aid (D3 — raw for v1). */
interface UncategorizedRow {
  path: string;
  reason: string;
  candidates: unknown[];
  addedAt: number;
  scannedAt: number;
}

/** Body for the rescue-by-path endpoint. Mirrors the episode route's union
 *  (`tmdbId+type` OR `link`, plus optional `season`/`episode`/`seInput`) and
 *  adds the target `path` — a `needs_review` entry has no integer row id, so it
 *  is keyed only by its on-disk path. */
const identifyBodySchema = z.intersection(
  z.object({
    path: z.string().min(1).max(1024),
    season: z.number().int().nonnegative().optional(),
    episode: z.number().int().nonnegative().optional(),
    seInput: z.string().min(1).max(40).optional(),
  }),
  z.union([
    z.object({
      tmdbId: z.number().int().positive(),
      type: z.union([z.literal('movie'), z.literal('series')]),
    }),
    z.object({ link: z.string().min(1).max(500) }),
  ]),
);

type TmdbDeps = {
  getMovie: typeof tmdb.getMovie;
  getSeries: typeof tmdb.getSeries;
  getEpisodes: typeof tmdb.getEpisodes;
  getMovieExternalIds: typeof tmdb.getMovieExternalIds;
  getSeriesExternalIds: typeof tmdb.getSeriesExternalIds;
  findByImdbId: typeof tmdb.findByImdbId;
  stillUrl: typeof tmdb.stillUrl;
  posterUrl: typeof tmdb.posterUrl;
};

let injectedTmdb: TmdbDeps | null = null;

/** Tests inject a fake TMDB client to avoid hitting the real API. */
export function setTmdbForTests(deps: TmdbDeps | null): void {
  injectedTmdb = deps;
}

function tmdbDeps(): TmdbDeps {
  return injectedTmdb ?? {
    getMovie: tmdb.getMovie,
    getSeries: tmdb.getSeries,
    getEpisodes: tmdb.getEpisodes,
    getMovieExternalIds: tmdb.getMovieExternalIds,
    getSeriesExternalIds: tmdb.getSeriesExternalIds,
    findByImdbId: tmdb.findByImdbId,
    stillUrl: tmdb.stillUrl,
    posterUrl: tmdb.posterUrl,
  };
}

/** ReviewAction kinds the rescue flow supports — excludes skip/quit/invalid. */
type ResolvableAction = Exclude<
  ReviewAction,
  { kind: 'skip' } | { kind: 'quit' } | { kind: 'invalid' }
>;

type IdentifyBody = z.infer<typeof identifyBodySchema>;

/** Normalize a `tmdbId+type` body OR a `link` body into a resolvable action.
 *  When the body carries an explicit type (the picker's choice), pass it through
 *  so resolution fetches only that media type — TMDB ids are per-type. */
function bodyToAction(body: IdentifyBody): ResolvableAction | null {
  if ('link' in body) return parseLink(body.link);
  return { kind: 'tmdb', id: body.tmdbId, type: body.type };
}

/** Resolve season/episode from explicit fields or a parsed `seInput` string.
 *  An absolute (series-wide) number is returned as `{ absolute }` for the caller
 *  to map once the show's season list is known (see absoluteToSe). */
function pickSeasonEpisode(
  body: IdentifyBody,
):
  | { season?: number; episode?: number }
  | { absolute: number }
  | { error: 'bad_se_input' } {
  if (body.seInput) {
    const parsed = parseSeInput(body.seInput);
    if (!parsed) return { error: 'bad_se_input' };
    if ('absolute' in parsed) return { absolute: parsed.absolute };
    return { season: parsed.season, episode: parsed.episode };
  }
  const out: { season?: number; episode?: number } = {};
  if (typeof body.season === 'number') out.season = body.season;
  if (typeof body.episode === 'number') out.episode = body.episode;
  return out;
}

export async function registerUncategorizedRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (s) => {
    s.addHook('onRequest', shareGuard);

    // List endpoint — alive needs_review rows, newest first. Read-only, so no
    // scan-lock (concurrent reads are safe).
    s.get('/api/library/uncategorized', async () => {
      const db = getDb();
      const rows = db.listReview();
      const items: UncategorizedRow[] = rows.map((r) => ({
        path: r.path,
        reason: r.reason,
        // candidates is stored as a JSON string; surface it parsed (may be []).
        candidates: candidatesToViews(safeParseJson(r.candidates)),
        addedAt: r.added_at,
        scannedAt: r.scanned_at,
      }));
      return { items };
    });

    // Rescue-by-path — wires the existing review-core onto a needs_review entry
    // keyed by path. Scan-locked like the manual-identify Apply routes.
    s.post('/api/library/uncategorized/identify', async (req, reply) => {
      const parsed = identifyBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_body' });
      const body = parsed.data;

      const seResult = pickSeasonEpisode(body);
      if ('error' in seResult) return reply.code(400).send({ error: seResult.error });

      const release = tryAcquire();
      if (!release) return reply.code(409).send({ error: 'scan_in_progress' });
      try {
        const db = getDb();
        const row = db.getReviewItem(body.path);
        if (!row || row.deleted_at != null) {
          return reply.code(404).send({ error: 'not_found' });
        }

        const action = bodyToAction(body);
        if (!action) return reply.code(400).send({ error: 'unresolvable_link' });

        const t = tmdbDeps();
        const reviewItem = rowToReviewItem({
          path: row.path,
          mtime: 0,
          scanned_at: row.scanned_at,
        });
        const resolved = await resolveAction(action, {
          row: reviewItem,
          views: [],
          sources: { tmdb: { name: 'tmdb', search: async () => [] } },
          tmdb: t as never,
        });
        if (!resolved) return reply.code(404).send({ error: 'unresolvable_link' });

        // Guard the mis-classification that produced the "Theodora" bug: the
        // user supplied an episode (season/episode/seInput) — an unambiguous
        // "this is a series episode" signal — but the id/link resolved to a
        // MOVIE. A bare TMDB id resolves movie-first (review-core tries getMovie
        // before getSeries), so a wrong/movie id would otherwise be silently
        // gated as a movie with the S/E discarded. Refuse instead of guessing.
        const suppliedSe =
          'absolute' in seResult || seResult.season != null || seResult.episode != null;
        if (suppliedSe && resolved.identity.type === 'movie') {
          return reply.code(400).send({ error: 'episode_requires_series' });
        }

        // If the caller stated an explicit type (the modal sends the picked
        // candidate's type), enforce it. A bare TMDB id resolves movie-first, so
        // an id that is valid as BOTH a movie and a series could otherwise be
        // gated as the wrong kind. Honour the user's stated intent over the guess.
        if ('type' in body && resolved.identity.type !== body.type) {
          return reply.code(400).send({ error: 'type_mismatch' });
        }

        // Resolve an absolute (series-wide) episode number against the show's
        // season list — anime ripped as "220" maps to whichever season it falls
        // in. Only reachable when the identity is a series (the suppliedSe guard
        // above already rejected a movie).
        let explicitSe: { season?: number; episode?: number };
        if ('absolute' in seResult) {
          const series = await t.getSeries(resolved.identity.tmdbId);
          const mapped = absoluteToSe(seResult.absolute, series.seasons);
          if (!mapped) return reply.code(400).send({ error: 'absolute_out_of_range' });
          explicitSe = mapped;
        } else {
          explicitSe = seResult;
        }

        // The on-disk mtime feeds the upserted media_items/episodes row. Stat
        // the file (also confirms it still exists under the media root).
        let mtime: number;
        try {
          const abs = await resolveStreamPath(row.path, config.mediaRoot);
          const st = await fs.stat(abs);
          mtime = Math.floor(st.mtimeMs);
        } catch (err) {
          if (err instanceof BadPathError) return reply.code(400).send({ error: 'bad_path' });
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return reply.code(404).send({ error: 'file_missing' });
          }
          throw err;
        }

        await applyChoice(
          {
            row: reviewItem,
            identity: resolved.identity,
            reason: resolved.reason,
            season: explicitSe.season,
            episode: explicitSe.episode,
            mtime,
            decidedAt: Date.now(),
          },
          db,
          { getEpisodes: t.getEpisodes, stillUrl: t.stillUrl, getSeries: t.getSeries },
        );

        if (resolved.identity.type === 'movie') {
          const item = db.getByPath(row.path) ?? null;
          return { ok: true, item };
        }
        const episode = db.getEpisodeByPath(row.path) ?? null;
        return { ok: true, episode };
      } catch (err) {
        req.log.warn({ err }, 'uncategorized identify failed');
        return reply.code(500).send({ error: 'internal' });
      } finally {
        release();
      }
    });
  });
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export type { UncategorizedRow };
export type UncategorizedIdentifyBody = IdentifyBody;
