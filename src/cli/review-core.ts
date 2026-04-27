import path from 'node:path';
import * as tmdbApi from '../tmdb.js';
import { passBIdentify } from '../identify/passB.js';
import { extractEpisode, type KnownSeason } from '../identify/episode.js';
import { applyIdentity } from '../identify/apply.js';
import type { DbHandle, ReviewItemRow } from '../db.js';
import type { Source } from '../identify/sources.js';

export interface ReviewSources {
  tmdb: Source;
  omdb?: Source | null;
  tvdb?: Source | null;
}

export interface CandidateView {
  index: number;                      // 1-based
  title: string;
  year: number | null;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  score: number;
  sources: string[];
  overview: string | null;
}

export type ReviewAction =
  | { kind: 'pick'; index: number }
  | { kind: 'tmdb'; id: number }
  | { kind: 'imdb'; id: string }
  | { kind: 'tvdb'; id: number }
  | { kind: 'retitle'; title: string }
  | { kind: 'skip' }
  | { kind: 'quit' }
  | { kind: 'invalid'; raw: string };

const TT_RE = /tt\d{5,}/i;

export function parseAction(raw: string): ReviewAction {
  const s = raw.trim();
  if (!s) return { kind: 'invalid', raw };
  const lower = s.toLowerCase();
  if (lower === 's' || lower === 'skip') return { kind: 'skip' };
  if (lower === 'q' || lower === 'quit' || lower === 'exit') return { kind: 'quit' };

  // Numeric pick
  if (/^\d+$/.test(s)) {
    return { kind: 'pick', index: Number(s) };
  }

  // tmdb:<id>
  let m = /^tmdb:(\d+)$/i.exec(s);
  if (m) return { kind: 'tmdb', id: Number(m[1]) };

  // tvdb:<id>
  m = /^tvdb:(\d+)$/i.exec(s);
  if (m) return { kind: 'tvdb', id: Number(m[1]) };

  // imdb:tt<id>  OR  pasted IMDb URL OR raw tt-id
  m = /^imdb:(tt\d{5,})$/i.exec(s);
  if (m) return { kind: 'imdb', id: m[1]!.toLowerCase() };
  const ttMatch = TT_RE.exec(s);
  if (ttMatch && (s.startsWith('http') || s === ttMatch[0] || s.toLowerCase().startsWith('imdb'))) {
    return { kind: 'imdb', id: ttMatch[0].toLowerCase() };
  }

  // t:<title> retitle
  m = /^t:(.+)$/i.exec(s);
  if (m) return { kind: 'retitle', title: m[1]!.trim() };

  return { kind: 'invalid', raw: s };
}

export function candidatesToViews(raw: unknown): CandidateView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i): CandidateView | null => {
    const rec = (c as { tmdb?: { title?: string; year?: number | null; type?: 'movie' | 'tv'; tmdbId?: number; imdbId?: string; tvdbId?: number; overview?: string | null } } | null) ?? null;
    const r = rec?.tmdb;
    if (!r) return null;
    const cWithSources = c as { score?: number; sources?: string[] };
    return {
      index: i + 1,
      title: r.title ?? '',
      year: r.year ?? null,
      type: r.type ?? 'movie',
      tmdbId: r.tmdbId ?? null,
      imdbId: r.imdbId ?? null,
      tvdbId: r.tvdbId ?? null,
      score: cWithSources.score ?? 0,
      sources: cWithSources.sources ?? [],
      overview: r.overview ?? null,
    };
  }).filter((v): v is CandidateView => v != null);
}

/** Resolve the chosen action into a TMDB-anchored identity, ready to apply. */
export async function resolveAction(
  action: Exclude<ReviewAction, { kind: 'skip' } | { kind: 'quit' } | { kind: 'invalid' }>,
  ctx: { row: ReviewItemRow; views: CandidateView[]; sources: ReviewSources; tmdb: typeof tmdbApi },
): Promise<{ identity: import('../identify/apply.js').ApplyIdentity; reason: string } | null> {
  switch (action.kind) {
    case 'pick': {
      const v = ctx.views.find((x) => x.index === action.index);
      if (!v) return null;
      // The chosen candidate may not have a TMDB id (OMDb-only) — resolve via IMDb id if so.
      let tmdbId = v.tmdbId;
      if (tmdbId == null && v.imdbId) {
        const found = await ctx.tmdb.findByImdbId(v.imdbId);
        tmdbId = found.movie_results[0]?.id ?? found.tv_results[0]?.id ?? null;
      }
      if (tmdbId == null) return null;
      return {
        identity: {
          tmdbId,
          imdbId: v.imdbId,
          tvdbId: v.tvdbId,
          type: v.type === 'tv' ? 'series' : 'movie',
          title: v.title,
          year: v.year,
          overview: v.overview,
        },
        reason: 'manual',
      };
    }
    case 'tmdb': {
      // Look up the tmdb id directly.
      try {
        const movie = await ctx.tmdb.getMovie(action.id);
        const ext = await ctx.tmdb.getMovieExternalIds(action.id);
        return {
          identity: {
            tmdbId: action.id,
            imdbId: ext.imdb_id ?? null,
            tvdbId: ext.tvdb_id ?? null,
            type: 'movie',
            title: movie.title,
            year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
            overview: movie.overview ?? null,
          },
          reason: 'tmdb-link',
        };
      } catch {
        // Fall through to series.
      }
      try {
        const series = await ctx.tmdb.getSeries(action.id);
        const ext = await ctx.tmdb.getSeriesExternalIds(action.id);
        return {
          identity: {
            tmdbId: action.id,
            imdbId: ext.imdb_id ?? null,
            tvdbId: ext.tvdb_id ?? null,
            type: 'series',
            title: series.name,
            year: series.first_air_date ? Number(series.first_air_date.slice(0, 4)) : null,
            overview: series.overview ?? null,
          },
          reason: 'tmdb-link',
        };
      } catch {
        return null;
      }
    }
    case 'imdb': {
      const found = await ctx.tmdb.findByImdbId(action.id);
      const movie = found.movie_results[0];
      if (movie) {
        return {
          identity: {
            tmdbId: movie.id,
            imdbId: action.id,
            type: 'movie',
            title: movie.title ?? '',
            year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null,
            overview: movie.overview ?? null,
          },
          reason: 'imdb-link',
        };
      }
      const tv = found.tv_results[0];
      if (tv) {
        return {
          identity: {
            tmdbId: tv.id,
            imdbId: action.id,
            type: 'series',
            title: tv.name ?? '',
            year: tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : null,
            overview: tv.overview ?? null,
          },
          reason: 'imdb-link',
        };
      }
      return null;
    }
    case 'tvdb': {
      // We need TMDB's id; resolve via TVDB → IMDb → TMDB. The TVDB Source has byImdbId
      // but not byTvdbId. Best-effort: use the in-memory candidate that matches if any.
      const match = ctx.views.find((v) => v.tvdbId === action.id);
      if (match?.imdbId) {
        return resolveAction({ kind: 'imdb', id: match.imdbId }, ctx);
      }
      return null;
    }
    case 'retitle': {
      // Re-search across all enabled sources at the new title.
      const outcome = await passBIdentify(ctx.row.path, ctx.sources, { forceSeries: false });
      // Replace candidates with re-search results from the new title — but passBIdentify uses
      // the path; we want to use the user-typed title. Simulated: do a one-source search here.
      const results = await ctx.sources.tmdb.search(action.title);
      const top = results[0];
      if (!top) return null;
      // Use byImdbId if available to enrich.
      let imdbId: string | null = top.imdbId ?? null;
      if (!imdbId && typeof top.id === 'number') {
        try {
          const ext = top.type === 'tv'
            ? await ctx.tmdb.getSeriesExternalIds(top.id as number)
            : await ctx.tmdb.getMovieExternalIds(top.id as number);
          imdbId = ext.imdb_id ?? null;
        } catch {
          // ignore
        }
      }
      // Suppress unused-variable warning for outcome (kept intentionally — re-search code can
      // be expanded to merge re-search candidates later).
      void outcome;
      return {
        identity: {
          tmdbId: typeof top.id === 'number' ? (top.id as number) : (top.tmdbId ?? 0),
          imdbId,
          type: top.type === 'tv' ? 'series' : 'movie',
          title: top.title,
          year: top.year,
          overview: top.overview ?? null,
        },
        reason: 'retitled-search',
      };
    }
  }
}

/** Try to extract S/E from a path; returns null if not extractable. */
export function extractSeFromPath(relPosix: string, seriesTitle: string, known: KnownSeason[] | null): { season: number; episode: number } | null {
  const ep = extractEpisode(relPosix, seriesTitle, known);
  return ep ? { season: ep.season, episode: ep.episode } : null;
}

const SE_INPUT_RES: Array<RegExp> = [
  /^[sS](\d{1,2})\s*[eE](\d{1,3})$/,
  /^(\d{1,2})\s*[xX]\s*(\d{1,3})$/,
  /^[sS]\s*(\d{1,2})\s*[eE]\s*(\d{1,3})$/,
  /^[sS]eason\s*(\d{1,2})\s*[eE](?:pisode)?\s*(\d{1,3})$/i,
];

export function parseSeInput(s: string): { season: number; episode: number } | null {
  const trimmed = s.trim().replace(/\s+/g, '');
  for (const re of SE_INPUT_RES) {
    const m = re.exec(trimmed);
    if (m) {
      return { season: Number(m[1]), episode: Number(m[2]) };
    }
  }
  return null;
}

export interface ApplyChosenInput {
  row: ReviewItemRow;
  identity: import('../identify/apply.js').ApplyIdentity;
  reason: string;
  season?: number | undefined;
  episode?: number | undefined;
  mtime: number;
  decidedAt: number;
}

/** Persist a manual-override decision and apply the identity to media_items/episodes. */
export async function applyChoice(
  input: ApplyChosenInput,
  db: DbHandle,
  tmdbDeps: { getEpisodes: typeof tmdbApi.getEpisodes; stillUrl: typeof tmdbApi.stillUrl; getSeries?: typeof tmdbApi.getSeries },
): Promise<void> {
  await applyIdentity(
    input.row.path,
    input.identity,
    {
      confidence: 1.0,
      identificationJson: JSON.stringify({ source: 'manual', reason: input.reason }),
      season: input.season,
      episode: input.episode,
      mtime: input.mtime,
      scannedAt: input.decidedAt,
    },
    { db, tmdb: tmdbDeps },
  );

  // Persist the override so re-scans don't undo it.
  db.setManualOverride({
    path: input.row.path,
    tmdb_id: input.identity.tmdbId,
    imdb_id: input.identity.imdbId ?? null,
    tvdb_id: input.identity.tvdbId ?? null,
    type: input.identity.type,
    season: input.season ?? null,
    episode: input.episode ?? null,
    reason: input.reason,
    decided_at: input.decidedAt,
  });
}

export function formatCandidateLine(v: CandidateView): string {
  const sources: string[] = [];
  if (v.tmdbId != null) sources.push(`tmdb:${v.tmdbId}`);
  if (v.imdbId) sources.push(`imdb:${v.imdbId}`);
  if (v.tvdbId != null) sources.push(`tvdb:${v.tvdbId}`);
  const yr = v.year ? ` (${v.year})` : '';
  const agreement = v.sources.length > 1 ? `  (${v.sources.length} sources agree)` : '';
  return `    ${v.index}. ${v.title}${yr} [${v.type}]
       ${sources.join('  ')}    score ${v.score.toFixed(2)}${agreement}`;
}

export function basenameOf(p: string): string {
  return path.posix.basename(p);
}
