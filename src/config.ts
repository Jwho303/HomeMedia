import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const defaultCacheDir = path.join(os.homedir(), '.cache', 'homemedia');
const defaultHlsCacheDir = path.join(
  process.env.PROGRAMDATA ?? os.tmpdir(),
  'HomeMedia',
  'hls-cache',
);

const Schema = z.object({
  // 0.1.13 — media-critical fields. A fresh clone with no `.env` and no
  // `data/settings.json` must still boot (in "needs setup" mode) so the FTUE
  // wizard can collect these. They are therefore OPTIONAL at the schema level;
  // their required-ness is enforced at the route guard via `isConfigured()`.
  // The settings POST still validates a *required* field is non-empty (see
  // `requireConfigured()` / the settings route), so clearing TMDB via the
  // editor is still rejected.
  TMDB_API_KEY: z.string().optional(),
  // Optional cross-source corroboration keys (0.1.1.3). Empty/missing → that source is skipped.
  OMDB_API_KEY: z.string().optional(),
  TVDB_API_KEY: z.string().optional(),
  TVDB_TOKEN_PATH: z.string().default('data/tvdb-token.json'),
  OMDB_BUDGET_PATH: z.string().default('data/budgets/omdb.json'),
  TVDB_BUDGET_PATH: z.string().default('data/budgets/tvdb.json'),
  // 0.1.13 — optional at boot (see TMDB_API_KEY note above).
  MEDIA_ROOT: z.string().optional(),
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
  /** 0.1.13 — empty string when not yet configured (fresh clone / cleared in
   *  Settings). Boot tolerates this; `isConfigured()` gates media routes.
   *  Call sites that reach TMDB run behind that guard, so they see a real key. */
  tmdbApiKey: string;
  omdbApiKey: string | null;
  tvdbApiKey: string | null;
  tvdbTokenPath: string;
  omdbBudgetPath: string;
  tvdbBudgetPath: string;
  /** 0.1.13 — empty string when not yet configured. See `tmdbApiKey`. */
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

/** 0.1.12 — the four user-editable fields persisted in `data/settings.json`.
 *  These overlay `.env`, which overlays schema defaults. Keep this list in
 *  sync with the settings UI / route. */
export const SETTINGS_FIELDS = [
  'TMDB_API_KEY',
  'OMDB_API_KEY',
  'TVDB_API_KEY',
  'MEDIA_ROOT',
] as const;

export type SettingsField = (typeof SETTINGS_FIELDS)[number];

/** 0.1.12 — additional overlay keys that are NOT key-like (no mask/test/signup
 *  semantics) but still persist to `settings.json` so the UI can edit them
 *  without `.env`. PORT only takes effect on the next server start. */
export const OVERLAY_EXTRA_FIELDS = ['PORT'] as const;
export type OverlayExtraField = (typeof OVERLAY_EXTRA_FIELDS)[number];

/** Every key the settings overlay file may carry. */
export type OverlayField = SettingsField | OverlayExtraField;

/** Resolve the on-disk path for the runtime settings overlay. Mirrors
 *  `DB_PATH`'s default location (`data/`), overridable via `SETTINGS_PATH`
 *  for tests / non-standard installs. */
export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.SETTINGS_PATH ?? 'data/settings.json');
}

/** Read the four in-scope fields from `data/settings.json`, if present.
 *  Never throws — a missing or malformed file simply yields no overlay, so
 *  the maintainer's `.env`/defaults still apply. Empty strings are dropped
 *  so a blank optional key falls through rather than overriding `.env`. */
export function readSettingsOverlay(env: NodeJS.ProcessEnv = process.env): Partial<Record<OverlayField, string>> {
  // Under tests, ignore a developer's real `data/settings.json` unless the
  // test explicitly points `SETTINGS_PATH` at its own fixture. Otherwise a
  // stray local overlay (e.g. a saved MEDIA_ROOT) would override the env that
  // route tests set and make the suite non-hermetic.
  if (env.NODE_ENV === 'test' && !env.SETTINGS_PATH) return {};
  let raw: string;
  try {
    raw = readFileSync(settingsFilePath(env), 'utf8');
  } catch {
    return {};
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<Record<OverlayField, string>> = {};
  for (const field of [...SETTINGS_FIELDS, ...OVERLAY_EXTRA_FIELDS]) {
    const v = obj[field];
    // PORT may be stored as a number; coerce to string so the merged env
    // matches Zod's `z.coerce.number()`.
    if (typeof v === 'string' && v.length > 0) out[field] = v;
    else if (typeof v === 'number') out[field] = String(v);
  }
  return out;
}

/** Build the env object Zod parses: `defaults < .env < settings.json`. The
 *  overlay is applied on top of a shallow copy so `process.env` is never
 *  mutated. */
function mergedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...readSettingsOverlay(env) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(mergedEnv(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  // 0.1.13 — media-critical fields are optional at boot. Normalize an
  // absent/blank value to '' so `isConfigured()` and call sites have a single
  // "unset" sentinel. MEDIA_ROOT is only path-resolved when actually present.
  const tmdbApiKey = parsed.data.TMDB_API_KEY?.trim() || '';
  const mediaRootRaw = parsed.data.MEDIA_ROOT?.trim() || '';
  cached = {
    tmdbApiKey,
    omdbApiKey: parsed.data.OMDB_API_KEY?.trim() || null,
    tvdbApiKey: parsed.data.TVDB_API_KEY?.trim() || null,
    tvdbTokenPath: path.resolve(parsed.data.TVDB_TOKEN_PATH),
    omdbBudgetPath: path.resolve(parsed.data.OMDB_BUDGET_PATH),
    tvdbBudgetPath: path.resolve(parsed.data.TVDB_BUDGET_PATH),
    mediaRoot: mediaRootRaw ? path.resolve(mediaRootRaw) : '',
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

/** 0.1.12 — re-run the layered merge + parse and replace the cache, so a
 *  settings save takes effect live without a server restart. Throws
 *  `ConfigError` if the merged result is now invalid (e.g. a required key
 *  was cleared) — callers persisting settings should validate before/after
 *  and roll back on failure. */
export function reloadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached = null;
  return loadConfig(env);
}

/** Tests use this to force the next `loadConfig()` call to re-read process.env. */
export function resetConfigForTests(): void {
  cached = null;
}

/** 0.1.13 — whether the media-critical settings are present, i.e. whether
 *  library / scan / playback operations are allowed. A fresh clone with no
 *  `.env` and no `data/settings.json` boots with these unset; the FTUE wizard
 *  collects them and the route guard (`requireConfigured`) keeps media routes
 *  closed (503 `not_configured`) until both exist. Reads through the live
 *  config so a settings save flips it without a restart. */
export function isConfigured(): boolean {
  const c = loadConfig();
  return c.tmdbApiKey.length > 0 && c.mediaRoot.length > 0;
}

// Lazy proxy: any property access triggers loadConfig() on first read.
export const config = new Proxy({} as Config, {
  get(_t, prop) {
    return loadConfig()[prop as keyof Config];
  },
});
