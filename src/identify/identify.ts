import { generateHypotheses } from './hypotheses.js';
import { EARLY_BAIL, pickBest, scoreCandidate } from './score.js';
import type { Source } from './sources.js';
import type { Candidate, IdentifyResult, PathContext } from './types.js';

const TOP_RESULTS_PER_HYPOTHESIS = 3;

export interface IdentifyOptions {
  /** Disable early-bail; evaluate all hypotheses. Used by --aggressive re-scans. */
  aggressive?: boolean;
}

/**
 * Identify a single file by generating hypotheses, scoring TMDB results, and picking the best.
 */
export async function identify(
  relPosix: string,
  ctx: PathContext,
  source: Source,
  opts: IdentifyOptions = {},
): Promise<IdentifyResult> {
  const hypotheses = generateHypotheses(relPosix, ctx);
  if (hypotheses.length === 0) {
    return { winner: null, reason: { bestCandidates: [], reason: 'no_results' } };
  }

  const candidates: Candidate[] = [];
  let tmdbErrored = false;

  for (const h of hypotheses) {
    let results;
    try {
      results = await source.search(h.title, h.year ?? undefined);
    } catch {
      tmdbErrored = true;
      continue;
    }

    const top = results.slice(0, TOP_RESULTS_PER_HYPOTHESIS);
    for (let i = 0; i < top.length; i++) {
      candidates.push(scoreCandidate(h, top[i]!, ctx, i));
    }

    if (!opts.aggressive && candidates.length > 0) {
      const best = candidates.reduce((a, b) => (a.score > b.score ? a : b));
      if (best.score >= EARLY_BAIL) break;
    }
  }

  if (candidates.length === 0) {
    return {
      winner: null,
      reason: { bestCandidates: [], reason: tmdbErrored ? 'tmdb_error' : 'no_results' },
    };
  }
  return pickBest(candidates);
}
