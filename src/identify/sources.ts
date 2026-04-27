import * as tmdb from '../tmdb.js';
import type { SourceResult } from './types.js';

/**
 * A pluggable identification source. Returns normalized results so the scorer
 * doesn't care whether they came from TMDB, TVDB, or Wikipedia.
 */
export interface Source {
  readonly name: string;
  /** Search by title, optionally constrained by year and media type. */
  search(title: string, year?: number, type?: 'movie' | 'tv'): Promise<SourceResult[]>;
  /** Look up by IMDb id (most sources support this). Optional. */
  byImdbId?(imdbId: string): Promise<SourceResult | null>;
}

export interface TmdbSearch {
  searchMulti: typeof tmdb.searchMulti;
  findByImdbId?: typeof tmdb.findByImdbId;
  getMovie?: typeof tmdb.getMovie;
  getSeries?: typeof tmdb.getSeries;
  getMovieExternalIds?: typeof tmdb.getMovieExternalIds;
  getSeriesExternalIds?: typeof tmdb.getSeriesExternalIds;
}

/** Adapt the existing TMDB module to the Source interface. */
export function tmdbSource(deps: TmdbSearch): Source {
  return {
    name: 'tmdb',
    async search(title, year, _type) {
      const res = await deps.searchMulti(title, year);
      const out: SourceResult[] = [];
      for (const r of res.results) {
        if (r.media_type !== 'movie' && r.media_type !== 'tv') continue;
        const date = r.release_date ?? r.first_air_date ?? null;
        const yr = date ? Number(date.slice(0, 4)) : null;
        out.push({
          id: r.id,
          tmdbId: r.id,
          type: r.media_type,
          title: (r.title ?? r.name ?? '').toString(),
          year: Number.isFinite(yr) ? (yr as number) : null,
          posterPath: r.poster_path ?? null,
          backdropPath: r.backdrop_path ?? null,
          overview: r.overview ?? null,
        });
      }
      return out;
    },
    async byImdbId(imdbId: string): Promise<SourceResult | null> {
      if (!deps.findByImdbId) return null;
      const res = await deps.findByImdbId(imdbId);
      const movie = res.movie_results?.[0];
      if (movie) {
        const date = movie.release_date ?? null;
        const yr = date ? Number(date.slice(0, 4)) : null;
        return {
          id: movie.id,
          tmdbId: movie.id,
          imdbId,
          type: 'movie',
          title: (movie.title ?? '').toString(),
          year: Number.isFinite(yr) ? (yr as number) : null,
          posterPath: movie.poster_path ?? null,
          backdropPath: movie.backdrop_path ?? null,
          overview: movie.overview ?? null,
        };
      }
      const tv = res.tv_results?.[0];
      if (tv) {
        const date = tv.first_air_date ?? null;
        const yr = date ? Number(date.slice(0, 4)) : null;
        return {
          id: tv.id,
          tmdbId: tv.id,
          imdbId,
          type: 'tv',
          title: (tv.name ?? '').toString(),
          year: Number.isFinite(yr) ? (yr as number) : null,
          posterPath: tv.poster_path ?? null,
          backdropPath: tv.backdrop_path ?? null,
          overview: tv.overview ?? null,
        };
      }
      return null;
    },
  };
}
