import { describe, it, expect } from 'vitest';
import { scoreCandidate, pickBest, ABSOLUTE_THRESHOLD, MARGIN, EARLY_BAIL } from '../../src/identify/score.js';
import { pathContext } from '../../src/identify/hypotheses.js';
import type { Hypothesis, SourceResult } from '../../src/identify/types.js';

const movieHyp: Hypothesis = {
  source: 'cleaned-prefix',
  title: 'Minority Report',
  year: 2002,
  season: null,
  episode: null,
  expectedType: 'movie',
  prior: 0.85,
};

const tmdbMovie2002: SourceResult = {
  id: 180,
  type: 'movie',
  title: 'Minority Report',
  year: 2002,
  posterPath: null,
  backdropPath: null,
  overview: null,
};

const tmdbTv2015: SourceResult = {
  id: 63175,
  type: 'tv',
  title: 'Minority Report',
  year: 2015,
  posterPath: null,
  backdropPath: null,
  overview: null,
};

describe('scoreCandidate', () => {
  it('returns score equal to weighted sum of breakdown', () => {
    const ctx = pathContext('Minority Report (2002).mp4');
    const c = scoreCandidate(movieHyp, tmdbMovie2002, ctx, 1);
    const b = c.scoreBreakdown;
    const expected =
      0.35 * b.titleSimilarity +
      0.2 * b.yearProximity +
      0.15 * b.typeAgreement +
      0.15 * b.pathContextFit +
      0.1 * b.hypothesisPrior +
      0.05 * b.tmdbRank;
    expect(c.score).toBeCloseTo(expected, 9);
  });

  it('Minority Report 2002 movie scores well above the 2015 series', () => {
    const ctx = pathContext('Minority Report (2002).mp4');
    const movieScore = scoreCandidate(movieHyp, tmdbMovie2002, ctx, 1).score;
    const tvScore = scoreCandidate(movieHyp, tmdbTv2015, ctx, 0).score;
    expect(movieScore).toBeGreaterThanOrEqual(0.85);
    expect(movieScore - tvScore).toBeGreaterThanOrEqual(MARGIN);
  });

  it('typeAgreement is 0 when hypothesis says movie and result is tv', () => {
    const ctx = pathContext('foo.mkv');
    const c = scoreCandidate(movieHyp, tmdbTv2015, ctx, 0);
    expect(c.scoreBreakdown.typeAgreement).toBe(0);
  });

  it('pathContextFit favors tv result under Season folder', () => {
    const ctx = pathContext('Show/Season 1/Show.S01E01.mkv');
    const seriesHyp: Hypothesis = { ...movieHyp, expectedType: 'series', title: 'Show', year: null };
    const tvResult: SourceResult = { ...tmdbTv2015, title: 'Show', year: null };
    const c = scoreCandidate(seriesHyp, tvResult, ctx, 0);
    expect(c.scoreBreakdown.pathContextFit).toBe(1);
  });

  it('yearProximity: exact = 1, ±1 = 0.5, else 0', () => {
    const ctx = pathContext('foo.mkv');
    expect(scoreCandidate(movieHyp, { ...tmdbMovie2002, year: 2002 }, ctx).scoreBreakdown.yearProximity).toBe(1);
    expect(scoreCandidate(movieHyp, { ...tmdbMovie2002, year: 2003 }, ctx).scoreBreakdown.yearProximity).toBe(0.5);
    expect(scoreCandidate(movieHyp, { ...tmdbMovie2002, year: 2010 }, ctx).scoreBreakdown.yearProximity).toBe(0);
  });
});

describe('pickBest', () => {
  it('returns no_results for empty input', () => {
    const r = pickBest([]);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('no_results');
  });

  it('returns low_score when top is below ABSOLUTE_THRESHOLD', () => {
    const ctx = pathContext('foo.mkv');
    // Synthesize a low-scoring candidate
    const c = scoreCandidate(
      { ...movieHyp, title: 'Foo', year: null, expectedType: 'unknown', prior: 0.4 },
      { id: 1, type: 'tv', title: 'Bar', year: null, posterPath: null, backdropPath: null, overview: null },
      ctx,
      3,
    );
    const r = pickBest([c]);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('low_score');
    expect(c.score).toBeLessThan(ABSOLUTE_THRESHOLD);
  });

  it('returns ambiguous when top - runner-up < MARGIN', () => {
    const ctx = pathContext('foo.mkv');
    const a = scoreCandidate(movieHyp, tmdbMovie2002, ctx, 0);
    // Same hypothesis, slightly different result; force a near-tie via patched score below.
    const b = scoreCandidate(movieHyp, tmdbMovie2002, ctx, 0);
    a.score = 0.8;
    b.score = 0.78; // 0.02 < MARGIN
    const r = pickBest([a, b]);
    expect(r.winner).toBeNull();
    expect(r.reason!.reason).toBe('ambiguous');
  });

  it('returns winner when score >= threshold and margin >= MARGIN', () => {
    const ctx = pathContext('Minority Report (2002).mp4');
    const winner = scoreCandidate(movieHyp, tmdbMovie2002, ctx, 1);
    const loser = scoreCandidate(movieHyp, tmdbTv2015, ctx, 0);
    const r = pickBest([loser, winner]);
    expect(r.winner).not.toBeNull();
    expect(r.winner!.tmdb.id).toBe(180);
  });

  it('top-3 best candidates are included in the failure reason', () => {
    const ctx = pathContext('foo.mkv');
    const cs = [0.3, 0.25, 0.22, 0.2].map((s, i) => {
      const c = scoreCandidate(movieHyp, { ...tmdbMovie2002, id: 100 + i }, ctx, 0);
      c.score = s;
      return c;
    });
    const r = pickBest(cs);
    expect(r.reason!.bestCandidates).toHaveLength(3);
    expect(r.reason!.bestCandidates.map((c) => c.score)).toEqual([0.3, 0.25, 0.22]);
  });

  it('thresholds are sane', () => {
    expect(ABSOLUTE_THRESHOLD).toBe(0.55);
    expect(MARGIN).toBe(0.1);
    expect(EARLY_BAIL).toBe(0.9);
  });
});
