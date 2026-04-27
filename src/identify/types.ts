/** One candidate interpretation of a file. */
export interface Hypothesis {
  source:
    | 'basename'
    | 'parent-folder'
    | 'series-root'
    | 'cleaned-prefix'
    | 'normalized'
    | 'fallback-stripped';

  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  expectedType: 'movie' | 'series' | 'unknown';
  /** 0–1 prior — how much we trust this hypothesis before checking TMDB. */
  prior: number;
}

/** Path-derived context, computed once per file. */
export interface PathContext {
  /** Each segment of the relative path; filename is the last entry. */
  segments: string[];
  underSeasonFolder: boolean;
  hasExplicitSE: boolean;
  /** Sibling file basenames in the same directory (used in 0.1.1.2). */
  siblingNames: string[];
}

/** A normalized result from any identification source (TMDB today, others later). */
export interface SourceResult {
  /** Source-native id (TMDB id for tmdb, IMDb id string for omdb, TVDB id for tvdb). */
  id: number | string;
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  /** Cross-source identifiers — IMDb ID is the lingua franca. */
  imdbId?: string | undefined;       // tt0123456
  tmdbId?: number | undefined;       // present iff TMDB-sourced or resolved
  tvdbId?: number | undefined;       // present iff TVDB-sourced or resolved
}

export interface Candidate {
  hypothesis: Hypothesis;
  tmdb: SourceResult;
  scoreBreakdown: {
    titleSimilarity: number;
    yearProximity: number;
    typeAgreement: number;
    pathContextFit: number;
    hypothesisPrior: number;
    tmdbRank: number;
  };
  score: number;
}

export type UnidentifiedReasonCode =
  | 'no_results'
  | 'low_score'
  | 'ambiguous'
  | 'tmdb_error'
  | 'episode_unresolved';

export interface UnidentifiedReason {
  bestCandidates: Candidate[];
  reason: UnidentifiedReasonCode;
}

export interface IdentifyResult {
  winner: Candidate | null;
  reason?: UnidentifiedReason;
}
