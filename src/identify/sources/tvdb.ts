import { request } from 'undici';
import pThrottle from 'p-throttle';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Source } from '../sources.js';
import type { SourceResult } from '../types.js';
import type { BudgetTracker } from '../budget.js';

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TOKEN_TTL_MS = 25 * 24 * 60 * 60 * 1000;     // 25d (real TTL is 30d, leave margin)

export interface TvdbToken {
  value: string;
  obtainedAt: number;
}

export interface TvdbDeps {
  apiKey: string;
  budget: BudgetTracker;
  /** Disk path for cached bearer token. */
  tokenPath: string;
  fetch?: typeof request;
  /** Override throttle for tests. */
  throttle?: <Args extends unknown[], R>(fn: (...a: Args) => Promise<R>) => (...a: Args) => Promise<R>;
  /** Inject a clock for tests. */
  now?: () => number;
}

interface RawSearchEntry {
  tvdb_id?: string | number;
  id?: string | number;
  name?: string;
  type?: string;     // 'series' | 'movie' | ...
  year?: string | number;
  image_url?: string;
  overview?: string;
  remote_ids?: Array<{ id: string; sourceName: string }>;
}

interface TvdbSearchEnvelope { data?: RawSearchEntry[]; }
interface TvdbRemoteIdEnvelope {
  data?: Array<{
    series?: RawSearchEntry;
    movie?: RawSearchEntry;
  }>;
}
interface TvdbLoginEnvelope { data?: { token?: string }; }

function readTokenFromDisk(filePath: string): TvdbToken | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const t = JSON.parse(raw) as TvdbToken;
    if (t && typeof t.value === 'string' && typeof t.obtainedAt === 'number') return t;
  } catch {
    // ignore
  }
  return null;
}

function writeTokenToDisk(filePath: string, token: TvdbToken): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(token));
  } catch {
    // best-effort
  }
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createTvdbSource(deps: TvdbDeps): Source {
  const fetchFn = deps.fetch ?? request;
  const now = deps.now ?? Date.now;
  const limiter = pThrottle({ limit: 5, interval: 1000, strict: true });

  let tokenInMem: TvdbToken | null = null;

  async function login(): Promise<TvdbToken> {
    const res = await fetchFn(`${TVDB_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: deps.apiKey }),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text().catch(() => '');
      throw new Error(`TVDB login failed: ${res.statusCode} ${body.slice(0, 200)}`);
    }
    const env = (await res.body.json()) as TvdbLoginEnvelope;
    const value = env.data?.token;
    if (!value) throw new Error('TVDB login: no token in response');
    const t: TvdbToken = { value, obtainedAt: now() };
    writeTokenToDisk(deps.tokenPath, t);
    tokenInMem = t;
    return t;
  }

  async function ensureToken(): Promise<string> {
    if (tokenInMem && now() - tokenInMem.obtainedAt < TOKEN_TTL_MS) {
      return tokenInMem.value;
    }
    const cached = readTokenFromDisk(deps.tokenPath);
    if (cached && now() - cached.obtainedAt < TOKEN_TTL_MS) {
      tokenInMem = cached;
      return cached.value;
    }
    const fresh = await login();
    return fresh.value;
  }

  // Bare HTTP call (no throttling, no auth/budget); the throttled wrapper below adds those.
  async function rawAuthed(url: string, token: string): Promise<unknown> {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.statusCode === 401) {
      const e = new Error('TVDB 401') as Error & { code: number };
      e.code = 401;
      throw e;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text().catch(() => '');
      throw new Error(`TVDB ${res.statusCode}: ${body.slice(0, 200)}`);
    }
    return await res.body.json();
  }

  const throttledFetch = (deps.throttle ?? limiter)(rawAuthed);

  /** Wrap a TVDB GET so 401 → re-login + one retry. */
  async function authedGet(url: string): Promise<unknown> {
    let token = await ensureToken();
    try {
      return await throttledFetch(url, token);
    } catch (err) {
      const e = err as Error & { code?: number };
      if (e.code === 401) {
        // Force re-login.
        tokenInMem = null;
        token = (await login()).value;
        return await throttledFetch(url, token);
      }
      throw err;
    }
  }

  function normalize(d: RawSearchEntry): SourceResult {
    const imdbId = d.remote_ids?.find((r) => r.sourceName === 'IMDB')?.id;
    const tmdbIdRaw = d.remote_ids?.find((r) => r.sourceName === 'TheMovieDB.com')?.id;
    const tvdbId = toNumOrNull(d.tvdb_id ?? d.id);
    const isMovie = d.type === 'movie';
    return {
      id: tvdbId != null ? `tvdb:${tvdbId}` : (d.name ?? 'tvdb'),
      imdbId: imdbId,
      tmdbId: tmdbIdRaw ? Number(tmdbIdRaw) : undefined,
      tvdbId: tvdbId ?? undefined,
      type: isMovie ? 'movie' : 'tv',
      title: d.name ?? '',
      year: toNumOrNull(d.year),
      posterPath: d.image_url ?? null,
      backdropPath: null,
      overview: d.overview ?? null,
    };
  }

  const source: Source = {
    name: 'tvdb',

    async search(title, year, type) {
      if (!deps.budget.allow()) return [];
      const url = new URL(`${TVDB_BASE}/search`);
      url.searchParams.set('query', title);
      url.searchParams.set('type', type === 'movie' ? 'movie' : 'series');
      if (year) url.searchParams.set('year', String(year));
      let env: TvdbSearchEnvelope;
      try {
        env = (await authedGet(url.toString())) as TvdbSearchEnvelope;
        deps.budget.consume();
      } catch {
        return [];
      }
      const data = env.data ?? [];
      return data.slice(0, 5).map(normalize);
    },

    async byImdbId(imdbId) {
      if (!deps.budget.allow()) return null;
      let env: TvdbRemoteIdEnvelope;
      try {
        env = (await authedGet(`${TVDB_BASE}/search/remoteid/${imdbId}`)) as TvdbRemoteIdEnvelope;
        deps.budget.consume();
      } catch {
        return null;
      }
      const data = env.data ?? [];
      // Prefer series; fall back to movie.
      const seriesEntry = data.find((d) => d.series)?.series;
      if (seriesEntry) {
        return normalize({ ...seriesEntry, type: 'series', remote_ids: [...(seriesEntry.remote_ids ?? []), { id: imdbId, sourceName: 'IMDB' }] });
      }
      const movieEntry = data.find((d) => d.movie)?.movie;
      if (movieEntry) {
        return normalize({ ...movieEntry, type: 'movie', remote_ids: [...(movieEntry.remote_ids ?? []), { id: imdbId, sourceName: 'IMDB' }] });
      }
      return null;
    },
  };

  return source;
}

// Exposed for tests.
export const __test = { readTokenFromDisk, writeTokenToDisk };
