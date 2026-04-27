import type { Candidate } from './types.js';

export const AGREEMENT_BONUS_PER_SOURCE = 0.08;
export const AGREEMENT_BONUS_CAP = 0.16;     // 3-source unanimous

export interface AggregatedCandidate extends Candidate {
  /** Sources that returned this same identity. */
  sources: string[];
  /** Per-source raw score, before the aggregation bonus. */
  perSourceScores: Record<string, number>;
  /** Bonus added on top of max(perSourceScores). */
  agreementBonus: number;
}

/**
 * Stable cross-source key for grouping candidates from different sources.
 * Order: IMDb id → TVDB id → source-local fallback. Candidates that fall back
 * to the source-local key never merge with other sources.
 */
function crossSourceKey(c: Candidate, sourceName: string): string {
  const r = c.tmdb;     // historical name on Candidate; it holds the SourceResult
  if (r.imdbId) return `imdb:${r.imdbId}`;
  if (r.tvdbId != null) return `tvdb:${r.tvdbId}`;
  if (r.tmdbId != null) return `tmdb:${r.tmdbId}`;
  // No cross-source identifier — pin to this source so it can't merge with others.
  return `${sourceName}:${r.id}:${r.type}`;
}

/**
 * Merge candidates from multiple sources. When N sources independently land on the same
 * identity (matched by IMDb/TVDB/TMDB id), boost the merged score by 0.08 per extra
 * source, capped at +0.16. Disagreement isn't punished — just no bonus.
 */
export function aggregateCandidates(
  perSource: Map<string, Candidate[]>,
): AggregatedCandidate[] {
  const groups = new Map<string, { winner: Candidate; sources: Set<string>; perSourceScores: Record<string, number> }>();

  for (const [sourceName, candidates] of perSource) {
    for (const c of candidates) {
      const key = crossSourceKey(c, sourceName);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          winner: c,
          sources: new Set([sourceName]),
          perSourceScores: { [sourceName]: c.score },
        });
      } else {
        existing.sources.add(sourceName);
        // Keep the per-source-best for diagnostics; max wins ties so the boundaries are predictable.
        const prev = existing.perSourceScores[sourceName];
        if (prev == null || c.score > prev) existing.perSourceScores[sourceName] = c.score;
        // Winner = candidate with the highest base score.
        if (c.score > existing.winner.score) existing.winner = c;
      }
    }
  }

  const out: AggregatedCandidate[] = [];
  for (const g of groups.values()) {
    const sources = Array.from(g.sources).sort();
    const baseMax = Math.max(...Object.values(g.perSourceScores));
    const extras = Math.max(0, sources.length - 1);
    const bonus = Math.min(AGREEMENT_BONUS_CAP, AGREEMENT_BONUS_PER_SOURCE * extras);
    const merged = Math.min(1, baseMax + bonus);
    out.push({
      ...g.winner,
      score: merged,
      sources,
      perSourceScores: g.perSourceScores,
      agreementBonus: bonus,
    });
  }
  // Sort by merged score descending; stable on cross-source key for determinism.
  out.sort((a, b) => b.score - a.score);
  return out;
}
