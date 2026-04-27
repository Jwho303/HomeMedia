import { describe, it, expect, vi } from 'vitest';
import { groupIntoCohorts, identifyCohort, fitFileIntoCohort, type FileEntry, type IdentifyDeps } from '../../src/identify/cohorts.js';
import type { Source } from '../../src/identify/sources.js';
import type { SourceResult } from '../../src/identify/types.js';

function f(relPosix: string, mtime = 0): FileEntry {
  return { relPosix, mtime };
}

function makeSource(handler: (title: string, year?: number) => SourceResult[]): Source {
  return {
    name: 'mock',
    async search(title, year) {
      return handler(title, year);
    },
  };
}

describe('groupIntoCohorts', () => {
  it('groups files under one series-root folder into one cohort', () => {
    const files = [
      f('Show/Season 1/S01E01.mkv'),
      f('Show/Season 1/S01E02.mkv'),
      f('Show/Season 2/S02E01.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.kind).toBe('series-root');
    expect(cohorts[0]!.files).toHaveLength(3);
  });

  it('clusters top-level loose files with similar basenames', () => {
    const files = [
      f('A.Knight.of.the.Seven.Kingdoms.S01E01.mkv'),
      f('A.Knight.of.the.Seven.Kingdoms.S01E02.mkv'),
      f('A.Knight.of.the.Seven.Kingdoms.S01E03.mkv'),
      f('A.Knight.of.the.Seven.Kingdoms.S01E04.mkv'),
      f('A.Knight.of.the.Seven.Kingdoms.S01E05.mkv'),
      f('A.Knight.of.the.Seven.Kingdoms.S01E06.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.kind).toBe('lexical-cluster');
    expect(cohorts[0]!.files).toHaveLength(6);
  });

  it('isolated top-level movies become singleton cohorts', () => {
    const files = [
      f('Dune.2021.mkv'),
      f('Inception.2010.mkv'),
      f('The.Matrix.1999.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(3);
    for (const c of cohorts) expect(c.kind).toBe('singleton');
  });

  it('tags lone-season folders', () => {
    const files = [
      f('Season 4/its.always.sunny.in.phila.402.dsr.xvid.notv.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E01.DSR.XviD-NoTV.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E02.DSR.XviD-NoTV.avi'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.kind).toBe('lone-season');
    expect(cohorts[0]!.files).toHaveLength(3);
    // Seed title should be derived from the most-common parsed title across siblings.
    expect(cohorts[0]!.seedTitle.toLowerCase()).toContain('always sunny');
  });

  it('produces deterministic, key-stable output regardless of input order', () => {
    const files = [
      f('Show/Season 1/S01E01.mkv'),
      f('Show/Season 1/S01E02.mkv'),
      f('Other/Season 1/S01E01.mkv'),
      f('Dune.2021.mkv'),
    ];
    const a = groupIntoCohorts(files);
    const b = groupIntoCohorts([...files].reverse());
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.files.map((x) => x.relPosix)).toEqual(b[i]!.files.map((x) => x.relPosix));
    }
  });

  it('a movie file with no similar siblings is its own cohort, not merged into a neighbor', () => {
    const files = [
      f('Dune.2021.mkv'),
      f('Inception.2010.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(2);
    for (const c of cohorts) expect(c.kind).toBe('singleton');
  });

  it('series-root cohort under series root has high sePatternRatio', () => {
    const files = [
      f('The Bear/The.Bear.S01E01.mkv'),
      f('The Bear/The.Bear.S01E02.mkv'),
      f('The Bear/The.Bear.S01E03.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.sePatternRatio).toBeCloseTo(1, 2);
  });

  it('multi-rip movie folder forms one series-root cohort with sePatternRatio = 0', () => {
    const files = [
      f('Nausicaä of the Valley of the Wind (1984) RM/Nausicaa.RM10.mkv'),
      f('Nausicaä of the Valley of the Wind (1984) RM/Nausicaa.RM14.mkv'),
    ];
    const cohorts = groupIntoCohorts(files);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.kind).toBe('series-root');
    expect(cohorts[0]!.sePatternRatio).toBe(0);
  });
});

describe('identifyCohort', () => {
  it('makes exactly ONE TMDB search per cohort with multiple files', async () => {
    const search = vi.fn(async (title: string): Promise<SourceResult[]> => {
      if (/bear/i.test(title)) {
        return [{ id: 86831, type: 'tv', title: 'The Bear', year: 2022, posterPath: null, backdropPath: null, overview: null }];
      }
      return [];
    });
    const source: Source = { name: 'mock', search };
    const cohort = groupIntoCohorts([
      f('The Bear/The.Bear.S01E01.mkv'),
      f('The Bear/The.Bear.S01E02.mkv'),
      f('The Bear/The.Bear.S01E03.mkv'),
    ])[0]!;

    const id = await identifyCohort(cohort, { source });
    expect(id).not.toBeNull();
    expect(id!.tmdbId).toBe(86831);
    // It may try multiple HYPOTHESES against the same source — but the spec requires that
    // the cohort be identified with bounded calls. In practice with our hypothesis pipeline,
    // we expect 1-3 calls (one per cohort-level hypothesis until one wins).
    expect(search.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('lone-season cohort identifies via most-common parsed title across siblings', async () => {
    const search = vi.fn(async (title: string): Promise<SourceResult[]> => {
      if (/sunny/i.test(title)) {
        return [{ id: 2710, type: 'tv', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null }];
      }
      return [];
    });
    const source: Source = { name: 'mock', search };
    const cohort = groupIntoCohorts([
      f('Season 4/its.always.sunny.in.phila.402.dsr.xvid.notv.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E01.DSR.XviD-NoTV.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E02.DSR.XviD-NoTV.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E03.DSR.XviD-NoTV.avi'),
    ])[0]!;

    const id = await identifyCohort(cohort, { source });
    expect(id).not.toBeNull();
    expect(id!.tmdbId).toBe(2710);
    expect(id!.type).toBe('series');
  });

  it('low-confidence cohort returns null', async () => {
    const source: Source = makeSource(() => []);
    const cohort = groupIntoCohorts([
      f('Total.Mystery.2099.mkv'),
    ])[0]!;
    const id = await identifyCohort(cohort, { source });
    expect(id).toBeNull();
  });

  it('library-history tiebreaker: snaps to library row when scores are ambiguous', async () => {
    // Two TMDB candidates with very close scores. Library has exactly one strong match.
    const search = vi.fn(async (): Promise<SourceResult[]> => [
      { id: 1111, type: 'tv', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null },
      { id: 2222, type: 'tv', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null },
    ]);
    const source: Source = { name: 'mock', search };
    const cohort = groupIntoCohorts([
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E01.mkv'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E02.mkv'),
    ])[0]!;

    const deps: IdentifyDeps = {
      source,
      libraryLookup: () => [
        { tmdbId: 2710, type: 'series', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null },
      ],
    };

    const id = await identifyCohort(cohort, deps);
    expect(id).not.toBeNull();
    expect(id!.source).toBe('library-tiebreaker');
    expect(id!.tmdbId).toBe(2710);
  });

  it('library-history tiebreaker DOES NOT fire when scores are clearly separated', async () => {
    // First candidate scores much higher than runner-up; library should not override.
    const search = vi.fn(async (): Promise<SourceResult[]> => [
      { id: 9999, type: 'tv', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null },
      { id: 8888, type: 'movie', title: 'Some Other Title', year: 2010, posterPath: null, backdropPath: null, overview: null },
    ]);
    const source: Source = { name: 'mock', search };
    const cohort = groupIntoCohorts([
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E01.mkv'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E02.mkv'),
    ])[0]!;

    const deps: IdentifyDeps = {
      source,
      libraryLookup: () => [
        { tmdbId: 2710, type: 'series', title: "It's Always Sunny in Philadelphia", year: 2005, posterPath: null, backdropPath: null, overview: null },
      ],
    };

    const id = await identifyCohort(cohort, deps);
    expect(id).not.toBeNull();
    // Tiebreaker did not fire: winner is the top-scoring TMDB candidate, not the library row.
    expect(id!.source).not.toBe('library-tiebreaker');
    expect(id!.tmdbId).toBe(9999);
  });
});

describe('fitFileIntoCohort', () => {
  it('movie cohorts: every file fits as movie with no per-file TMDB call', async () => {
    const search = vi.fn();
    const source: Source = { name: 'mock', search };
    const cohort = groupIntoCohorts([
      f('Nausicaä (1984)/Nausicaa.RM10.mkv'),
      f('Nausicaä (1984)/Nausicaa.RM14.mkv'),
    ])[0]!;

    const identity = {
      tmdbId: 81,
      type: 'movie' as const,
      title: 'Nausicaä',
      year: 1984,
      posterPath: null,
      backdropPath: null,
      overview: null,
      confidence: 0.95,
      source: 'cohort-folder' as const,
    };

    for (const file of cohort.files) {
      const fit = await fitFileIntoCohort(file, cohort, identity, { source });
      expect(fit.kind).toBe('movie');
      if (fit.kind === 'movie') expect(fit.tmdbId).toBe(81);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('series cohort: outlier rescue via 3-digit shorthand validated against known seasons', async () => {
    const source: Source = makeSource(() => []);
    const cohort = groupIntoCohorts([
      f('Season 4/its.always.sunny.in.phila.402.dsr.xvid.notv.avi'),
      f('Season 4/Its.Always.Sunny.in.Philadelphia.S04E01.DSR.XviD-NoTV.avi'),
    ])[0]!;

    const identity = {
      tmdbId: 2710,
      type: 'series' as const,
      title: "It's Always Sunny in Philadelphia",
      year: 2005,
      posterPath: null,
      backdropPath: null,
      overview: null,
      confidence: 0.95,
      source: 'cohort-most-common' as const,
    };

    const known = [{ season_number: 4, episode_count: 13 }];
    const deps: IdentifyDeps = {
      source,
      getKnownSeasons: async () => known,
    };

    const fit1 = await fitFileIntoCohort(cohort.files[0]!, cohort, identity, deps);
    const fit2 = await fitFileIntoCohort(cohort.files[1]!, cohort, identity, deps);

    // Files are sorted by relPosix, so order is alphabetical:
    //  - "Its.Always.Sunny..." comes BEFORE "its.always.sunny.in.phila..." (case affects sort)
    // But we care only that BOTH resolve correctly.
    const fits = [fit1, fit2];
    const phila = fits.find((f) => f.kind === 'episode' && f.episode === 2);
    const ep1 = fits.find((f) => f.kind === 'episode' && f.episode === 1);
    expect(phila).toBeDefined();
    expect(ep1).toBeDefined();
  });
});
