import { similarity } from './strings.js';
import type { Candidate, Hypothesis, IdentifyResult, PathContext, SourceResult } from './types.js';

export const ABSOLUTE_THRESHOLD = 0.55;
export const MARGIN = 0.1;
export const EARLY_BAIL = 0.9;

const W_TITLE = 0.35;
const W_YEAR = 0.2;
const W_TYPE = 0.15;
const W_PATH = 0.15;
const W_PRIOR = 0.1;
const W_RANK = 0.05;

function yearProximity(hyp: number | null, res: number | null): number {
  if (hyp == null || res == null) return 0.5; // no year info → neutral, doesn't hurt or help
  const diff = Math.abs(hyp - res);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  return 0;
}

function pathContextFit(resultType: 'movie' | 'tv', ctx: PathContext): number {
  const seriesCues = ctx.underSeasonFolder || ctx.hasExplicitSE;
  if (resultType === 'tv' && seriesCues) return 1;
  if (resultType === 'movie' && !seriesCues) return 0.9;
  if (resultType === 'tv' && !seriesCues) return 0.3;
  if (resultType === 'movie' && seriesCues) return 0.1;
  return 0.5;
}

function typeAgreement(expected: Hypothesis['expectedType'], actual: 'movie' | 'tv'): number {
  if (expected === 'unknown') return 0.5;
  if (expected === 'movie' && actual === 'movie') return 1;
  if (expected === 'series' && actual === 'tv') return 1;
  return 0;
}

function rankPenalty(rank0: number): number {
  // 0 → 1.0, 1 → 0.7, 2 → 0.5, 3+ → 0.3
  if (rank0 <= 0) return 1;
  if (rank0 === 1) return 0.7;
  if (rank0 === 2) return 0.5;
  return 0.3;
}

export function scoreCandidate(
  hypothesis: Hypothesis,
  result: SourceResult,
  ctx: PathContext,
  rank0 = 0,
): Candidate {
  const titleSimilarity = similarity(hypothesis.title, result.title);
  const yearProx = yearProximity(hypothesis.year, result.year);
  const typeAgr = typeAgreement(hypothesis.expectedType, result.type);
  const pathFit = pathContextFit(result.type, ctx);
  const prior = hypothesis.prior;
  const rank = rankPenalty(rank0);

  const score =
    W_TITLE * titleSimilarity +
    W_YEAR * yearProx +
    W_TYPE * typeAgr +
    W_PATH * pathFit +
    W_PRIOR * prior +
    W_RANK * rank;

  return {
    hypothesis,
    tmdb: result,
    scoreBreakdown: {
      titleSimilarity,
      yearProximity: yearProx,
      typeAgreement: typeAgr,
      pathContextFit: pathFit,
      hypothesisPrior: prior,
      tmdbRank: rank,
    },
    score,
  };
}

/**
 * Pick the winning candidate, or null with a reason if no candidate clears the bar.
 * `bestCandidates` contains the top 3 by score regardless of outcome.
 */
export function pickBest(candidates: Candidate[]): IdentifyResult {
  if (candidates.length === 0) {
    return { winner: null, reason: { bestCandidates: [], reason: 'no_results' } };
  }
  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  const top = sorted[0]!;
  if (top.score < ABSOLUTE_THRESHOLD) {
    return { winner: null, reason: { bestCandidates: top3, reason: 'low_score' } };
  }
  const runnerUp = sorted[1];
  if (runnerUp && top.score - runnerUp.score < MARGIN) {
    return { winner: null, reason: { bestCandidates: top3, reason: 'ambiguous' } };
  }
  return { winner: top };
}
