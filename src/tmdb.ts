import { request } from 'undici';
import pThrottle from 'p-throttle';
import { config } from './config.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const STILL_BASE = 'https://image.tmdb.org/t/p/w300';

const throttle = pThrottle({ limit: 3, interval: 1000, strict: true });

async function rawFetch<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', config.tmdbApiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await request(url.toString(), { method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text().catch(() => '');
    throw new Error(`TMDB ${res.statusCode} ${path}: ${body.slice(0, 200)}`);
  }
  return (await res.body.json()) as T;
}

const fetchThrottled = throttle(rawFetch);

export interface TmdbSearchMultiResult {
  page: number;
  results: Array<{
    id: number;
    media_type: 'movie' | 'tv' | 'person';
    title?: string | null;          // movie
    name?: string | null;           // tv
    release_date?: string | null;   // movie YYYY-MM-DD
    first_air_date?: string | null; // tv
    overview?: string | null;
    poster_path?: string | null;
    backdrop_path?: string | null;
  }>;
  total_results: number;
}

export interface TmdbMovie {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  /** Movie runtime in MINUTES, when TMDB has it. (0.1.3.2) */
  runtime?: number | null;
  /** Genre list from /movie/:id. (0.1.3.2) */
  genres?: Array<{ id: number; name: string }>;
}

export interface TmdbSeries {
  id: number;
  name: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  /** TMDB returns this on /tv/:id; episode_count per season validates episode-extraction. */
  seasons?: Array<{ season_number: number; episode_count: number }>;
  /** Genre list from /tv/:id. (0.1.3.2) */
  genres?: Array<{ id: number; name: string }>;
}

export interface TmdbEpisode {
  id: number;
  name?: string | null;
  overview?: string | null;
  still_path?: string | null;
  season_number: number;
  episode_number: number;
  /** Per-episode runtime in MINUTES, when TMDB has it. (0.1.3.1) */
  runtime?: number | null;
}

export interface TmdbSeason {
  id: number;
  season_number: number;
  episodes: TmdbEpisode[];
}

export interface TmdbFindResult {
  movie_results: Array<{
    id: number;
    title?: string;
    release_date?: string;
    overview?: string | null;
    poster_path?: string | null;
    backdrop_path?: string | null;
  }>;
  tv_results: Array<{
    id: number;
    name?: string;
    first_air_date?: string;
    overview?: string | null;
    poster_path?: string | null;
    backdrop_path?: string | null;
  }>;
  person_results: Array<unknown>;
}

export interface TmdbExternalIds {
  imdb_id?: string | null;
  tvdb_id?: number | null;
}

export function searchMulti(query: string, year?: number): Promise<TmdbSearchMultiResult> {
  return fetchThrottled<TmdbSearchMultiResult>('/search/multi', { query, year });
}

export function getMovie(id: number): Promise<TmdbMovie> {
  return fetchThrottled<TmdbMovie>(`/movie/${id}`);
}

export function getSeries(id: number): Promise<TmdbSeries> {
  return fetchThrottled<TmdbSeries>(`/tv/${id}`);
}

export function getEpisodes(seriesId: number, season: number): Promise<TmdbSeason> {
  return fetchThrottled<TmdbSeason>(`/tv/${seriesId}/season/${season}`);
}

/** Resolve an IMDb id (tt0123456) → matching TMDB movie/tv records. */
export function findByImdbId(imdbId: string): Promise<TmdbFindResult> {
  return fetchThrottled<TmdbFindResult>(`/find/${imdbId}`, { external_source: 'imdb_id' });
}

export function getMovieExternalIds(id: number): Promise<TmdbExternalIds> {
  return fetchThrottled<TmdbExternalIds>(`/movie/${id}/external_ids`);
}

export function getSeriesExternalIds(id: number): Promise<TmdbExternalIds> {
  return fetchThrottled<TmdbExternalIds>(`/tv/${id}/external_ids`);
}

export function posterUrl(p: string | null | undefined): string | null {
  return p ? POSTER_BASE + p : null;
}

export function stillUrl(p: string | null | undefined): string | null {
  return p ? STILL_BASE + p : null;
}
