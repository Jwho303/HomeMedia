import { describe, it, expect } from 'vitest';
import { aggregateCandidates, AGREEMENT_BONUS_CAP, AGREEMENT_BONUS_PER_SOURCE } from '../../src/identify/aggregate.js';
import type { Candidate, Hypothesis, SourceResult } from '../../src/identify/types.js';

const dummyHyp: Hypothesis = {
  source: 'cleaned-prefix',
  title: 'X',
  year: null,
  season: null,
  episode: null,
  expectedType: 'unknown',
  prior: 0.7,
};

function c(opts: { id: string | number; score: number; imdbId?: string; tvdbId?: number; tmdbId?: number; type?: 'movie' | 'tv' }): Candidate {
  const result: SourceResult = {
    id: opts.id,
    imdbId: opts.imdbId,
    tvdbId: opts.tvdbId,
    tmdbId: opts.tmdbId,
    type: opts.type ?? 'movie',
    title: 'Title',
    year: 2020,
    posterPath: null,
    backdropPath: null,
    overview: null,
  };
  return {
    hypothesis: dummyHyp,
    tmdb: result,
    scoreBreakdown: {
      titleSimilarity: opts.score,
      yearProximity: 1,
      typeAgreement: 1,
      pathContextFit: 1,
      hypothesisPrior: 0.7,
      tmdbRank: 1,
    },
    score: opts.score,
  };
}

describe('aggregateCandidates', () => {
  it('merges candidates by IMDb id; bonus = +0.08 for two sources', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 121, tmdbId: 121, imdbId: 'tt0167261', score: 0.7 })]],
      ['omdb', [c({ id: 'tt0167261', imdbId: 'tt0167261', score: 0.5 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual(['omdb', 'tmdb']);
    expect(merged[0]!.agreementBonus).toBeCloseTo(AGREEMENT_BONUS_PER_SOURCE, 5);
    // base max = 0.7; bonus = 0.08 → merged 0.78
    expect(merged[0]!.score).toBeCloseTo(0.78, 5);
  });

  it('three-source agreement bumps to the cap (+0.16)', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 121, tmdbId: 121, imdbId: 'tt0167261', score: 0.7 })]],
      ['omdb', [c({ id: 'tt0167261', imdbId: 'tt0167261', score: 0.5 })]],
      ['tvdb', [c({ id: 'tvdb:5', tvdbId: 5, imdbId: 'tt0167261', score: 0.4 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual(['omdb', 'tmdb', 'tvdb']);
    expect(merged[0]!.agreementBonus).toBeCloseTo(AGREEMENT_BONUS_CAP, 5);
    expect(merged[0]!.score).toBeCloseTo(0.86, 5);
  });

  it('disagreement: each candidate stands alone, no bonus', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 100, tmdbId: 100, imdbId: 'tt100', score: 0.7 })]],
      ['omdb', [c({ id: 'tt200', imdbId: 'tt200', score: 0.6 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.score).toBe(0.7);
    expect(merged[0]!.agreementBonus).toBe(0);
  });

  it('falls back to TVDB id when IMDb id is missing on both sides', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 100, tmdbId: 100, tvdbId: 5, score: 0.7 })]],
      ['tvdb', [c({ id: 'tvdb:5', tvdbId: 5, score: 0.5 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual(['tmdb', 'tvdb']);
  });

  it('candidates with neither IMDb nor TVDB id never merge across sources', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 100, tmdbId: 100, score: 0.7 })]],
      ['omdb', [c({ id: 'tt-no-tmdb', score: 0.6 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged).toHaveLength(2);
  });

  it('caps bonus at +0.16 even with four+ sources', () => {
    const perSource = new Map<string, Candidate[]>([
      ['s1', [c({ id: 'a', imdbId: 'tt1', score: 0.5 })]],
      ['s2', [c({ id: 'a', imdbId: 'tt1', score: 0.4 })]],
      ['s3', [c({ id: 'a', imdbId: 'tt1', score: 0.4 })]],
      ['s4', [c({ id: 'a', imdbId: 'tt1', score: 0.4 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged[0]!.agreementBonus).toBeCloseTo(AGREEMENT_BONUS_CAP, 5);
  });

  it('preserves per-source scores in the breakdown for audit', () => {
    const perSource = new Map<string, Candidate[]>([
      ['tmdb', [c({ id: 100, tmdbId: 100, imdbId: 'tt1', score: 0.7 })]],
      ['omdb', [c({ id: 'tt1', imdbId: 'tt1', score: 0.5 })]],
    ]);
    const merged = aggregateCandidates(perSource);
    expect(merged[0]!.perSourceScores).toEqual({ tmdb: 0.7, omdb: 0.5 });
  });
});
