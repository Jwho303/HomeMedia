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
  /** 0.1.9 — global ceiling on concurrent player instances. New /open
   *  requests beyond this are 503 capacity_exceeded. */
  MAX_CONCURRENT_PLAYERS: z.coerce.number().int().positive().default(3),
  /** 0.1.9 — per-identity (today: per-IP) ceiling. When 1, /open from an
   *  IP that already has a player adopts the existing player as a media
   *  swap; when >1, opens additional instances up to the cap. */
  MAX_PLAYERS_PER_IP: z.coerce.number().int().positive().default(1),
  /** 0.1.9 — encoder pacing target. ffmpeg is suspended when its emitted
   *  segments cover this many seconds past the client's reported position. */
  ENCODE_AHEAD_SECONDS: z.coerce.number().int().positive().default(30),
  /** 0.1.9 — encoder pacing resume threshold. Hysteresis vs ENCODE_AHEAD
   *  keeps the pace controller from flapping. */
  ENCODE_RESUME_SECONDS: z.coerce.number().int().positive().default(10),
  /** 0.1.9 — wipe a player's segments + state if no /state ping arrives
   *  for this long. Default 30 minutes. */
  PLAYER_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
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
  /** 0.1.9 caps + pacing knobs. */
  maxConcurrentPlayers: number;
  maxPlayersPerIp: number;
  encodeAheadSeconds: number;
  encodeResumeSeconds: number;
  playerIdleTimeoutSeconds: number;
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
    maxConcurrentPlayers: parsed.data.MAX_CONCURRENT_PLAYERS,
    maxPlayersPerIp: parsed.data.MAX_PLAYERS_PER_IP,
    encodeAheadSeconds: parsed.data.ENCODE_AHEAD_SECONDS,
    encodeResumeSeconds: parsed.data.ENCODE_RESUME_SECONDS,
    playerIdleTimeoutSeconds: parsed.data.PLAYER_IDLE_TIMEOUT_SECONDS,
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
