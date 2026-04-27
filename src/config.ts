import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const defaultCacheDir = path.join(os.homedir(), '.cache', 'homemedia');
const defaultHlsCacheDir = path.join(
  process.env.PROGRAMDATA ?? os.tmpdir(),
  'HomeMedia',
  'hls-cache',
);

const Schema = z.object({
  TMDB_API_KEY: z.string().min(1, 'TMDB_API_KEY is required'),
  // Optional cross-source corroboration keys (0.1.1.3). Empty/missing → that source is skipped.
  OMDB_API_KEY: z.string().optional(),
  TVDB_API_KEY: z.string().optional(),
  TVDB_TOKEN_PATH: z.string().default('data/tvdb-token.json'),
  OMDB_BUDGET_PATH: z.string().default('data/budgets/omdb.json'),
  TVDB_BUDGET_PATH: z.string().default('data/budgets/tvdb.json'),
  MEDIA_ROOT: z.string().min(1, 'MEDIA_ROOT is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default('data/media.db'),
  /** 0.1.4.3 — root for derived caches (extracted embedded subs, future
   *  thumbnails, etc.). */
  CACHE_DIR: z.string().default(defaultCacheDir),
  /** 0.1.6 — root for HLS session caches. Per-session subdirectory holds
   *  `index.m3u8` + `seg-NNNNN.ts` files. Cleaned up on session teardown
   *  and on server startup (orphans from a hard crash). */
  HLS_CACHE_DIR: z.string().default(defaultHlsCacheDir),
  /** 0.1.6 D13 — feature flag gating the HLS player path. While false the
   *  legacy probe-and-decide path stays in effect for the client. The
   *  server registers the new HLS routes unconditionally. */
  HLS_PLAYER: z.string().default('false'),
  // Optional — only read on darwin for `mount volume` reconnect.
  SMB_HOST: z.string().optional(),
  SMB_SHARE: z.string().optional(),
});

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface Config {
  tmdbApiKey: string;
  omdbApiKey: string | null;
  tvdbApiKey: string | null;
  tvdbTokenPath: string;
  omdbBudgetPath: string;
  tvdbBudgetPath: string;
  mediaRoot: string;
  port: number;
  dbPath: string;
  cacheDir: string;
  hlsCacheDir: string;
  hlsPlayer: boolean;
  smbHost: string | null;
  smbShare: string | null;
}

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  cached = {
    tmdbApiKey: parsed.data.TMDB_API_KEY,
    omdbApiKey: parsed.data.OMDB_API_KEY?.trim() || null,
    tvdbApiKey: parsed.data.TVDB_API_KEY?.trim() || null,
    tvdbTokenPath: path.resolve(parsed.data.TVDB_TOKEN_PATH),
    omdbBudgetPath: path.resolve(parsed.data.OMDB_BUDGET_PATH),
    tvdbBudgetPath: path.resolve(parsed.data.TVDB_BUDGET_PATH),
    mediaRoot: path.resolve(parsed.data.MEDIA_ROOT),
    port: parsed.data.PORT,
    dbPath: path.resolve(parsed.data.DB_PATH),
    cacheDir: path.resolve(parsed.data.CACHE_DIR),
    hlsCacheDir: path.resolve(parsed.data.HLS_CACHE_DIR),
    hlsPlayer: parsed.data.HLS_PLAYER.toLowerCase() === 'true',
    smbHost: parsed.data.SMB_HOST?.trim() || null,
    smbShare: parsed.data.SMB_SHARE?.trim() || null,
  };
  return cached;
}

/** Tests use this to force the next `loadConfig()` call to re-read process.env. */
export function resetConfigForTests(): void {
  cached = null;
}

// Lazy proxy: any property access triggers loadConfig() on first read.
export const config = new Proxy({} as Config, {
  get(_t, prop) {
    return loadConfig()[prop as keyof Config];
  },
});
