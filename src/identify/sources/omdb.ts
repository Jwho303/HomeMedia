import { request } from 'undici';
import pThrottle from 'p-throttle';
import type { Source } from '../sources.js';
import type { SourceResult } from '../types.js';
import type { BudgetTracker } from '../budget.js';

const OMDB_BASE = 'https://www.omdbapi.com/';

interface OmdbLite {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster?: string;
}

interface OmdbSearchEnvelope {
  Search?: OmdbLite[];
  Response: 'True' | 'False';
  Error?: string;
}

interface OmdbFull {
  Title: string;
  Year: string;
  Type: string;          // 'movie' | 'series' | 'episode'
  imdbID: string;
  Plot?: string;
  Poster?: string;
  Response: 'True' | 'False';
  Error?: string;
}

export interface OmdbDeps {
  apiKey: string;
  budget: BudgetTracker;
  fetch?: typeof request;
  /** Override throttle for tests. */
  throttle?: <Args extends unknown[], R>(fn: (...a: Args) => Promise<R>) => (...a: Args) => Promise<R>;
}

function parseYear(y: string | undefined): number | null {
  if (!y) return null;
  // OMDb returns "2003–" or "2003" or "2003-2007". Take the first 4 digits.
  const m = /^(\d{4})/.exec(y);
  return m ? Number(m[1]) : null;
}

function clean(s: string | undefined | null): string | null {
  return s && s !== 'N/A' ? s : null;
}

export function createOmdbSource(deps: OmdbDeps): Source {
  const fetchFn = deps.fetch ?? request;
  const limiter = pThrottle({ limit: 5, interval: 1000, strict: true });
  const throttledRaw = (deps.throttle ?? limiter)(async (params: URLSearchParams): Promise<unknown> => {
    const url = OMDB_BASE + '?' + params.toString();
    const res = await fetchFn(url, { method: 'GET' });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text().catch(() => '');
      throw new Error(`OMDb ${res.statusCode}: ${body.slice(0, 200)}`);
    }
    return await res.body.json();
  });

  function normalizeFull(data: OmdbFull, requestedImdbId?: string): SourceResult | null {
    if (data.Response === 'False') return null;
    const imdbId = data.imdbID || requestedImdbId;
    return {
      id: imdbId ?? data.Title,
      imdbId: imdbId,
      tmdbId: undefined,
      type: data.Type === 'series' ? 'tv' : 'movie',
      title: data.Title,
      year: parseYear(data.Year),
      posterPath: clean(data.Poster),
      backdropPath: null,
      overview: clean(data.Plot),
    };
  }

  const source: Source = {
    name: 'omdb',

    async search(title: string, year?: number, type?: 'movie' | 'tv'): Promise<SourceResult[]> {
      if (!deps.budget.allow()) return [];
      const params = new URLSearchParams({ apikey: deps.apiKey, s: title });
      if (year) params.set('y', String(year));
      if (type) params.set('type', type === 'tv' ? 'series' : 'movie');

      let envelope: OmdbSearchEnvelope;
      try {
        envelope = (await throttledRaw(params)) as OmdbSearchEnvelope;
        deps.budget.consume();
      } catch {
        return [];
      }
      if (envelope.Response !== 'True' || !envelope.Search) return [];

      // OMDb's search returns lite results; the full record (overview, accurate poster) requires
      // a per-imdbID lookup. Fetch the top 5 in parallel — they're independent throttled calls.
      const top = envelope.Search.slice(0, 5);
      const out: SourceResult[] = [];
      for (const lite of top) {
        const full = await source.byImdbId!(lite.imdbID);
        if (full) out.push(full);
      }
      return out;
    },

    async byImdbId(imdbId: string): Promise<SourceResult | null> {
      if (!deps.budget.allow()) return null;
      const params = new URLSearchParams({ apikey: deps.apiKey, i: imdbId, plot: 'short' });
      let data: OmdbFull;
      try {
        data = (await throttledRaw(params)) as OmdbFull;
        deps.budget.consume();
      } catch {
        return null;
      }
      return normalizeFull(data, imdbId);
    },
  };

  return source;
}
