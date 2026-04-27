import path from 'node:path';
import { generateHypotheses, pathContext } from './hypotheses.js';
import { ABSOLUTE_THRESHOLD, scoreCandidate } from './score.js';
import { aggregateCandidates, type AggregatedCandidate } from './aggregate.js';
import type { Source } from './sources.js';
import type { Candidate, Hypothesis, PathContext, SourceResult } from './types.js';

const TOP_RESULTS_PER_HYPOTHESIS = 3;

export interface PassBSources {
  tmdb: Source;
  omdb?: Source | null;
  tvdb?: Source | null;
}

export interface PassBOptions {
  /** Force series-routing for the file (overrides heuristic). */
  forceSeries?: boolean;
}

export interface PassBOutcome {
  winner: AggregatedCandidate | null;
  /** Top 3 aggregated candidates regardless of outcome (for needs_review.candidates). */
  candidates: AggregatedCandidate[];
  /** Names of sources that actually fired. */
  sourcesQueried: string[];
}

/**
 * Heuristic for whether to route TVDB on this file. TVDB is type-gated to series (D9):
 *   - explicit S/E in the path,
 *   - under a Season-marker folder,
 *   - or caller asked for series routing.
 */
export function looksLikeSeries(relPosix: string, ctx: PathContext, opts: PassBOptions = {}): boolean {
  if (opts.forceSeries) return true;
  if (ctx.hasExplicitSE || ctx.underSeasonFolder) return true;
  // Last-ditch: parent-folder name says season N.
  const parent = path.posix.basename(path.posix.dirname(relPosix));
  if (/^(season|series)[\s._-]*\d{1,2}$/i.test(parent)) return true;
  return false;
}

/** Run identification against one source for an ordered hypothesis list. */
async function searchSource(source: Source, hypotheses: Hypothesis[], ctx: PathContext): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const h of hypotheses) {
    let results: SourceResult[] = [];
    try {
      results = await source.search(
        h.title,
        h.year ?? undefined,
        h.expectedType === 'series' ? 'tv' : h.expectedType === 'movie' ? 'movie' : undefined,
      );
    } catch {
      continue;
    }
    const top = results.slice(0, TOP_RESULTS_PER_HYPOTHESIS);
    for (let i = 0; i < top.length; i++) {
      out.push(scoreCandidate(h, top[i]!, ctx, i));
    }
  }
  return out;
}

/**
 * Re-run identification across TMDB + OMDb (always) + TVDB (when type-routed) for one file.
 * Returns the merged candidate set and the winner, if any clears ABSOLUTE_THRESHOLD.
 */
export async function passBIdentify(
  relPosix: string,
  sources: PassBSources,
  opts: PassBOptions = {},
): Promise<PassBOutcome> {
  const ctx = pathContext(relPosix);
  const hypotheses = generateHypotheses(relPosix, ctx);
  if (hypotheses.length === 0) {
    return { winner: null, candidates: [], sourcesQueried: [] };
  }

  const perSource = new Map<string, Candidate[]>();

  // TMDB always.
  const tmdbCands = await searchSource(sources.tmdb, hypotheses, ctx);
  if (tmdbCands.length > 0) perSource.set('tmdb', tmdbCands);

  // OMDb always (when configured).
  if (sources.omdb) {
    const omdbCands = await searchSource(sources.omdb, hypotheses, ctx);
    if (omdbCands.length > 0) perSource.set('omdb', omdbCands);
  }

  // TVDB only when the file looks like a series (D9).
  if (sources.tvdb && looksLikeSeries(relPosix, ctx, opts)) {
    const tvdbCands = await searchSource(sources.tvdb, hypotheses, ctx);
    if (tvdbCands.length > 0) perSource.set('tvdb', tvdbCands);
  }

  const sourcesQueried = Array.from(perSource.keys());
  if (perSource.size === 0) {
    return { winner: null, candidates: [], sourcesQueried };
  }

  const merged = aggregateCandidates(perSource);
  const top3 = merged.slice(0, 3);
  const winner = merged[0] && merged[0].score >= ABSOLUTE_THRESHOLD ? merged[0] : null;
  return { winner, candidates: top3, sourcesQueried };
}
