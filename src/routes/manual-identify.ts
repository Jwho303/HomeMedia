import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, type MediaItemRow, type EpisodeRow } from '../db.js';
import { tryAcquire } from '../scan-lock.js';
import { shareGuard } from '../middleware/share-guard.js';
import {
  applyChoice,
  resolveAction,
  parseSeInput,
  type ReviewAction,
} from '../cli/review-core.js';
import {
  parseLink,
  rowToReviewItem,
  getItemById,
  getEpisodeById,
} from '../manual-identify.js';
import * as tmdb from '../tmdb.js';

interface CandidateView {
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  type: 'movie' | 'series';
  overview: string | null;
  posterUrl: string | null;
  score: number;
  sources: string[];
}

const itemBodySchema = z.union([
  z.object({
    tmdbId: z.number().int().positive(),
    type: z.union([z.literal('movie'), z.literal('series')]),
  }),
  z.object({ link: z.string().min(1).max(500) }),
]);

const episodeBodySchema = z.union([
  z.object({
    tmdbId: z.number().int().positive(),
    type: z.union([z.literal('movie'), z.literal('series')]),
    season: z.number().int().nonnegative().optional(),
    episode: z.number().int().nonnegative().optional(),
    seInput: z.string().min(1).max(40).optional(),
  }),
  z.object({
    link: z.string().min(1).max(500),
    season: z.number().int().nonnegative().optional(),
    episode: z.number().int().nonnegative().optional(),
    seInput: z.string().min(1).max(40).optional(),
  }),
]);

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const searchQuerySchema = z.object({
  q: z.string(),
  type: z.union([z.literal('movie'), z.literal('series')]).optional(),
});

type TmdbDeps = {
  searchMulti: typeof tmdb.searchMulti;
  getMovie: typeof tmdb.getMovie;
  getSeries: typeof tmdb.getSeries;
  getEpisodes: typeof tmdb.getEpisodes;
  getMovieExternalIds: typeof tmdb.getMovieExternalIds;
  getSeriesExternalIds: typeof tmdb.getSeriesExternalIds;
  findByImdbId: typeof tmdb.findByImdbId;
  posterUrl: typeof tmdb.posterUrl;
  stillUrl: typeof tmdb.stillUrl;
};

let injectedTmdb: TmdbDeps | null = null;

/** Tests inject a fake TMDB client to avoid hitting the real API. */
export function setTmdbForTests(deps: TmdbDeps | null): void {
  injectedTmdb = deps;
}

function tmdbDeps(): TmdbDeps {
  return injectedTmdb ?? {
    searchMulti: tmdb.searchMulti,
    getMovie: tmdb.getMovie,
    getSeries: tmdb.getSeries,
    getEpisodes: tmdb.getEpisodes,
    getMovieExternalIds: tmdb.getMovieExternalIds,
    getSeriesExternalIds: tmdb.getSeriesExternalIds,
    findByImdbId: tmdb.findByImdbId,
    posterUrl: tmdb.posterUrl,
    stillUrl: tmdb.stillUrl,
  };
}

/** ReviewAction kinds the modal supports — excludes skip/quit/invalid. */
type ResolvableAction = Exclude<
  ReviewAction,
  { kind: 'skip' } | { kind: 'quit' } | { kind: 'invalid' }
>;

/** Normalize a `tmdbId+type` body OR a `link` body into a resolvable ReviewAction.
 *  parseLink() already filters out non-resolvable kinds. */
function bodyToAction(
  body: { tmdbId: number; type: 'movie' | 'series' } | { link: string },
): ResolvableAction | null {
  if ('link' in body) return parseLink(body.link);
  return { kind: 'tmdb', id: body.tmdbId };
}

/** Resolve season/episode from explicit fields or a parsed `seInput` string. */
function pickSeasonEpisode(input: {
  season?: number | undefined;
  episode?: number | undefined;
  seInput?: string | undefined;
}): { season?: number; episode?: number } | { error: 'bad_se_input' } {
  if (input.seInput) {
    const parsed = parseSeInput(input.seInput);
    if (!parsed) return { error: 'bad_se_input' };
    return { season: parsed.season, episode: parsed.episode };
  }
  const out: { season?: number; episode?: number } = {};
  if (typeof input.season === 'number') out.season = input.season;
  if (typeof input.episode === 'number') out.episode = input.episode;
  return out;
}

/** `resolveAction` returns identity with title/year/overview but not posterUrl
 *  (review-core was designed for the CLI flow where a subsequent scan
 *  populates artwork). Manual-identify writes directly to `media_items`, so we
 *  fetch poster + backdrop here and merge them in. Without this, a successful
 *  Apply blanks the card's artwork because applyMovie writes
 *  `poster_url = excluded.poster_url` (= null) on the path-keyed UPSERT. */
async function enrichArtwork(
  identity: import('../identify/apply.js').ApplyIdentity,
  t: TmdbDeps,
): Promise<import('../identify/apply.js').ApplyIdentity> {
  if (identity.posterUrl != null && identity.backdropUrl != null) return identity;
  try {
    if (identity.type === 'movie') {
      const m = await t.getMovie(identity.tmdbId);
      return {
        ...identity,
        posterUrl: identity.posterUrl ?? t.posterUrl(m.poster_path ?? null),
        backdropUrl: identity.backdropUrl ?? t.posterUrl(m.backdrop_path ?? null),
      };
    }
    const s = await t.getSeries(identity.tmdbId);
    return {
      ...identity,
      posterUrl: identity.posterUrl ?? t.posterUrl(s.poster_path ?? null),
      backdropUrl: identity.backdropUrl ?? t.posterUrl(s.backdrop_path ?? null),
    };
  } catch {
    return identity;
  }
}

function toCandidateViewFromMulti(
  r: tmdb.TmdbSearchMultiResult['results'][number],
  t: TmdbDeps,
  index: number,
): CandidateView | null {
  if (r.media_type !== 'movie' && r.media_type !== 'tv') return null;
  const isMovie = r.media_type === 'movie';
  const title = (isMovie ? r.title : r.name) ?? '';
  const dateStr = isMovie ? r.release_date : r.first_air_date;
  const year = dateStr ? Number(dateStr.slice(0, 4)) : null;
  return {
    tmdbId: r.id,
    imdbId: null,
    tvdbId: null,
    title,
    year: Number.isFinite(year) ? year : null,
    type: isMovie ? 'movie' : 'series',
    overview: r.overview ?? null,
    posterUrl: t.posterUrl(r.poster_path ?? null),
    score: 1 - index / 100,
    sources: ['tmdb'],
  };
}

export async function registerManualIdentifyRoutes(app: FastifyInstance): Promise<void> {
  // Search — share-guarded only (no scan-lock; concurrent reads are safe).
  app.register(async (s) => {
    s.addHook('onRequest', shareGuard);

    s.get('/api/manual-identify/search', async (req, reply) => {
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_query' });
      const raw = parsed.data.q.trim();
      if (raw.length === 0 || raw.length > 200) {
        return reply.code(400).send({ error: 'bad_query' });
      }
      const yearMatch = /\((\d{4})\)/.exec(raw);
      const year = yearMatch ? Number(yearMatch[1]) : undefined;
      const cleaned = raw.replace(/\s*\(\d{4}\)\s*/, '').trim();
      const t = tmdbDeps();
      let result: tmdb.TmdbSearchMultiResult;
      try {
        result = await t.searchMulti(cleaned, year);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('429')) return reply.code(429).send({ error: 'tmdb_busy' });
        return reply.code(502).send({ error: 'tmdb_failed' });
      }
      const wantType = parsed.data.type;
      const out: CandidateView[] = [];
      for (let i = 0; i < result.results.length && out.length < 20; i++) {
        const v = toCandidateViewFromMulti(result.results[i]!, t, i);
        if (!v) continue;
        if (wantType && v.type !== wantType) continue;
        out.push(v);
      }
      return { candidates: out };
    });
  });

  // Apply endpoints — share-guarded + scan-locked.
  app.register(async (s) => {
    s.addHook('onRequest', shareGuard);

    s.post('/api/manual-identify/item/:id', async (req, reply) => {
      const idParsed = idParamSchema.safeParse(req.params);
      if (!idParsed.success) return reply.code(400).send({ error: 'bad_id' });
      const bodyParsed = itemBodySchema.safeParse(req.body);
      if (!bodyParsed.success) return reply.code(400).send({ error: 'bad_body' });

      const release = tryAcquire();
      if (!release) return reply.code(409).send({ error: 'scan_in_progress' });
      try {
        const db = getDb();
        const row = getItemById(db, idParsed.data.id);
        if (!row) return reply.code(404).send({ error: 'not_found' });

        const action = bodyToAction(bodyParsed.data);
        if (!action) return reply.code(400).send({ error: 'unresolvable_link' });

        const t = tmdbDeps();
        const resolved = await resolveAction(action, {
          row: rowToReviewItem(row),
          views: [],
          sources: { tmdb: { name: 'tmdb', search: async () => [] } },
          tmdb: t as never,
        });
        if (!resolved) return reply.code(404).send({ error: 'unresolvable_link' });

        const identity = await enrichArtwork(resolved.identity, t);
        const decidedAt = Date.now();
        if (identity.type === 'movie') {
          // Movie → applyChoice does the right thing (keyed by file path).
          await applyChoice(
            {
              row: rowToReviewItem(row),
              identity,
              reason: resolved.reason,
              mtime: row.mtime,
              decidedAt,
            },
            db,
            { getEpisodes: t.getEpisodes, stillUrl: t.stillUrl, getSeries: t.getSeries },
          );
        } else {
          // Series → update the series row directly. applyChoice's series path
          // goes through episode-extraction, which doesn't apply when the user
          // is identifying the *show* itself from a series tile / series
          // detail kebab.
          db.raw
            .prepare(
              `UPDATE media_items
               SET type = 'series', tmdb_id = ?, imdb_id = ?, tvdb_id = ?,
                   title = ?, year = ?, overview = COALESCE(?, overview),
                   poster_url = COALESCE(?, poster_url),
                   backdrop_url = COALESCE(?, backdrop_url),
                   confidence = 1.0,
                   identification_json = ?,
                   scanned_at = ?
               WHERE id = ?`,
            )
            .run(
              identity.tmdbId,
              identity.imdbId ?? null,
              identity.tvdbId ?? null,
              identity.title,
              identity.year,
              identity.overview ?? null,
              identity.posterUrl ?? null,
              identity.backdropUrl ?? null,
              JSON.stringify({ source: 'manual', reason: resolved.reason }),
              decidedAt,
              row.id,
            );
          db.setManualOverride({
            path: row.path,
            tmdb_id: identity.tmdbId,
            imdb_id: identity.imdbId ?? null,
            tvdb_id: identity.tvdbId ?? null,
            type: 'series',
            reason: resolved.reason,
            decided_at: decidedAt,
          });
        }

        const updated = getItemById(db, idParsed.data.id) ??
          db.getByTmdbId(resolved.identity.tmdbId, resolved.identity.type) ??
          db.getByPath(row.path);
        return { item: updated ?? null };
      } catch (err) {
        req.log.warn({ err }, 'manual-identify item failed');
        return reply.code(500).send({ error: 'internal' });
      } finally {
        release();
      }
    });

    s.post('/api/manual-identify/episode/:id', async (req, reply) => {
      const idParsed = idParamSchema.safeParse(req.params);
      if (!idParsed.success) return reply.code(400).send({ error: 'bad_id' });
      const bodyParsed = episodeBodySchema.safeParse(req.body);
      if (!bodyParsed.success) return reply.code(400).send({ error: 'bad_body' });

      const release = tryAcquire();
      if (!release) return reply.code(409).send({ error: 'scan_in_progress' });
      try {
        const db = getDb();
        const ep = getEpisodeById(db, idParsed.data.id);
        if (!ep) return reply.code(404).send({ error: 'not_found' });

        const seResult = pickSeasonEpisode(bodyParsed.data);
        if ('error' in seResult) return reply.code(400).send({ error: seResult.error });

        const action = bodyToAction(bodyParsed.data);
        if (!action) return reply.code(400).send({ error: 'unresolvable_link' });

        const t = tmdbDeps();
        const synthetic = rowToReviewItem(ep);
        const resolved = await resolveAction(action, {
          row: synthetic,
          views: [],
          sources: { tmdb: { name: 'tmdb', search: async () => [] } },
          tmdb: t as never,
        });
        if (!resolved) return reply.code(404).send({ error: 'unresolvable_link' });
        // Episode kebab always identifies the parent series, never a movie.
        if (resolved.identity.type !== 'series') {
          return reply.code(400).send({ error: 'episode_requires_series' });
        }

        const identity = await enrichArtwork(resolved.identity, t);

        // Fall back to the episode's existing S/E if neither was supplied. Both
        // the re-parent case (different tmdbId, same S/E) and the S/E-correction
        // case work this way.
        const season = seResult.season ?? ep.season;
        const episode = seResult.episode ?? ep.episode;

        await applyChoice(
          {
            row: synthetic,
            identity,
            reason: resolved.reason,
            season,
            episode,
            mtime: ep.mtime,
            decidedAt: Date.now(),
          },
          db,
          { getEpisodes: t.getEpisodes, stillUrl: t.stillUrl, getSeries: t.getSeries },
        );

        const updatedEp = db.getEpisodeByPath(ep.path) ?? null;
        const updatedSeries = updatedEp
          ? db.raw
              .prepare<[number], MediaItemRow>('SELECT * FROM media_items WHERE id = ?')
              .get(updatedEp.series_id) ?? null
          : null;
        return { episode: updatedEp, item: updatedSeries };
      } catch (err) {
        req.log.warn({ err }, 'manual-identify episode failed');
        return reply.code(500).send({ error: 'internal' });
      } finally {
        release();
      }
    });
  });
}

export type { CandidateView };
// Re-exports so tests can drive the same shapes the route uses.
export type ManualIdentifyItemBody = z.infer<typeof itemBodySchema>;
export type ManualIdentifyEpisodeBody = z.infer<typeof episodeBodySchema>;
// Suppress unused-type warning when the row alias above is only needed for the
// inner prepared statement.
export type _EpisodeRowAlias = EpisodeRow;
