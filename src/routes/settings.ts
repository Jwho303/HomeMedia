/**
 * Settings routes (0.1.12).
 *
 * Lets a non-programmer supply their own API keys + media path through the
 * gear-menu Settings screen — no `.env` editing, no restart. Three endpoints:
 *
 *   GET  /api/settings        — current state for the form (masked; never
 *                               returns a raw key).
 *   POST /api/settings/test   — verify a single key/path WITHOUT saving. The
 *                               handler validates the value sent in the body,
 *                               not saved config, so the user can test before
 *                               committing.
 *   POST /api/settings        — persist the four editable fields to
 *                               `data/settings.json` (atomic), invalidate the
 *                               cached TVDB token if its key changed, then
 *                               `reloadConfig()` so the change is live.
 *
 * Security: raw key values are write-only over the API. This is a single-user
 * LAN admin surface; no auth is added in this version (known limitation —
 * any device that can reach the server can change keys).
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { request } from 'undici';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SETTINGS_FIELDS,
  type SettingsField,
  type OverlayField,
  settingsFilePath,
  readSettingsOverlay,
  reloadConfig,
  loadConfig,
  ConfigError,
  config,
} from '../config.js';

const SIGNUP_LINKS: Record<SettingsField, string | null> = {
  TMDB_API_KEY: 'https://www.themoviedb.org/settings/api',
  OMDB_API_KEY: 'https://www.omdbapi.com/apikey.aspx',
  TVDB_API_KEY: 'https://thetvdb.com/dashboard/account/apikey',
  MEDIA_ROOT: null,
};

const REQUIRED: Record<SettingsField, boolean> = {
  TMDB_API_KEY: true,
  OMDB_API_KEY: false,
  TVDB_API_KEY: false,
  MEDIA_ROOT: true,
};

/** API-key fields are secrets — returned only masked. MEDIA_ROOT is a path,
 *  returned in full so the field can be edited. */
const SECRET_FIELDS: ReadonlySet<SettingsField> = new Set([
  'TMDB_API_KEY',
  'OMDB_API_KEY',
  'TVDB_API_KEY',
]);

/** Map a settings field to its currently-effective value (settings.json over
 *  .env over default), read through the live config. */
function effectiveValue(field: SettingsField): string | null {
  switch (field) {
    case 'TMDB_API_KEY':
      return config.tmdbApiKey || null;
    case 'OMDB_API_KEY':
      return config.omdbApiKey;
    case 'TVDB_API_KEY':
      return config.tvdbApiKey;
    case 'MEDIA_ROOT':
      return config.mediaRoot || null;
  }
}

/** "•••• 7f3a" — last 4 of a secret, or null when unset. */
function mask(value: string | null): string | null {
  if (!value) return null;
  const tail = value.slice(-4);
  return `•••• ${tail}`;
}

interface FieldState {
  set: boolean;
  required: boolean;
  signupUrl: string | null;
  /** Secret fields: masked hint only. */
  masked?: string | null;
  /** Non-secret fields (MEDIA_ROOT): the editable value. */
  value?: string;
}

function settingsState(): Record<SettingsField, FieldState> {
  const out = {} as Record<SettingsField, FieldState>;
  for (const field of SETTINGS_FIELDS) {
    const value = effectiveValue(field);
    const state: FieldState = {
      set: value != null && value.length > 0,
      required: REQUIRED[field],
      signupUrl: SIGNUP_LINKS[field],
    };
    if (SECRET_FIELDS.has(field)) {
      state.masked = mask(value);
    } else {
      state.value = value ?? '';
    }
    out[field] = state;
  }
  return out;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

/** Verify a single field's value by making a real lightweight call. Never
 *  throws — network / unexpected errors are folded into `{ ok: false }`. */
export async function testField(
  field: SettingsField,
  value: string,
  fetchFn: typeof request = request,
): Promise<TestResult> {
  const v = value.trim();
  if (!v) return { ok: false, error: 'Empty value' };

  try {
    switch (field) {
      case 'TMDB_API_KEY': {
        const url = `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(v)}`;
        const res = await fetchFn(url, { method: 'GET' });
        if (res.statusCode === 401) return { ok: false, error: 'Invalid API key (401)' };
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return { ok: false, error: `TMDB error (${res.statusCode})` };
        }
        return { ok: true };
      }
      case 'OMDB_API_KEY': {
        const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(v)}&i=tt0111161`;
        const res = await fetchFn(url, { method: 'GET' });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return { ok: false, error: `OMDb error (${res.statusCode})` };
        }
        const body = (await res.body.json().catch(() => null)) as
          | { Response?: string; Error?: string }
          | null;
        if (!body || body.Response !== 'True') {
          return { ok: false, error: body?.Error ?? 'Invalid API key' };
        }
        return { ok: true };
      }
      case 'TVDB_API_KEY': {
        const res = await fetchFn('https://api4.thetvdb.com/v4/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apikey: v }),
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return { ok: false, error: `Invalid API key (${res.statusCode})` };
        }
        const body = (await res.body.json().catch(() => null)) as
          | { data?: { token?: string } }
          | null;
        if (!body?.data?.token) return { ok: false, error: 'No token returned' };
        return { ok: true };
      }
      case 'MEDIA_ROOT': {
        const stat = await fs.stat(v).catch(() => null);
        if (!stat) return { ok: false, error: 'Path does not exist' };
        if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory' };
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'Request failed' };
  }
}

/** Write the overlay file atomically (temp + rename) so a crash mid-write
 *  can't leave a half-written JSON that breaks every later boot. */
async function writeSettingsFile(
  contents: Partial<Record<OverlayField, string>>,
): Promise<void> {
  const target = settingsFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(contents, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

interface PostBody {
  TMDB_API_KEY?: string;
  OMDB_API_KEY?: string;
  TVDB_API_KEY?: string;
  MEDIA_ROOT?: string;
}

/** Enumerate the non-internal IPv4 addresses this host is reachable at, so the
 *  Settings screen can show remote devices a URL to connect to. The browser
 *  itself can't know the server's LAN IP (it only knows the host it dialed), so
 *  the server reports its own interfaces. */
function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      // node <18 typed `family` as string '4'; >=18 uses number 4. Accept both.
      const isV4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (isV4 && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Whether `value` parses as a usable TCP port (1–65535). */
function parsePort(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => settingsState());

  app.post('/api/settings/test', async (req, reply) => {
    const body = (req.body ?? {}) as { field?: string; value?: string };
    const field = body.field as SettingsField | undefined;
    if (!field || !SETTINGS_FIELDS.includes(field)) {
      return reply.code(400).send({ ok: false, error: 'Unknown field' });
    }
    // A non-empty `value` tests the typed candidate before saving. An absent or
    // empty `value` means "verify the key that's already saved" — so the user
    // can confirm a previously-stored key still works without re-pasting it
    // (secrets are never sent back to the client, so the UI can't supply it).
    const candidate = typeof body.value === 'string' ? body.value.trim() : '';
    const valueToTest = candidate || effectiveValue(field) || '';
    if (!valueToTest) {
      return reply.code(400).send({ ok: false, error: 'No value set to test' });
    }
    return testField(field, valueToTest);
  });

  app.post('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as PostBody;

    // Snapshot the current overlay so we can roll back if the merged result is
    // invalid, and detect whether the TVDB key changed.
    const previousOverlay = readSettingsOverlay();
    const previousTvdbKey = config.tvdbApiKey;

    // Build the next overlay from the submitted fields. A field present with an
    // empty string clears it (falls through to .env/default); an absent field
    // keeps whatever was there before.
    const next: Partial<Record<OverlayField, string>> = { ...previousOverlay };
    for (const field of SETTINGS_FIELDS) {
      const submitted = body[field];
      if (typeof submitted !== 'string') continue;
      const trimmed = submitted.trim();
      if (trimmed.length > 0) next[field] = trimmed;
      else delete next[field];
    }

    await writeSettingsFile(next);

    // Re-run the merge + parse. Two failure modes roll the file back and 400:
    //   1. Zod rejects the merged env (malformed non-string value, etc.).
    //   2. 0.1.13 made TMDB_API_KEY / MEDIA_ROOT optional at the *schema* level
    //      so a fresh clone can boot without them. The schema therefore no
    //      longer enforces required-ness — we re-check it here so clearing a
    //      required field through the editor is still rejected (rollback).
    try {
      reloadConfig();
    } catch (err) {
      await writeSettingsFile(previousOverlay);
      reloadConfig();
      const issues = err instanceof ConfigError ? err.issues : [(err as Error).message];
      return reply.code(400).send({ error: 'invalid_settings', issues });
    }
    const missingRequired = SETTINGS_FIELDS.filter(
      (f) => REQUIRED[f] && !effectiveValue(f),
    );
    if (missingRequired.length > 0) {
      await writeSettingsFile(previousOverlay);
      reloadConfig();
      return reply.code(400).send({
        error: 'invalid_settings',
        issues: missingRequired.map((f) => `${f} is required`),
      });
    }

    // TVDB bearer token is cached on disk keyed to the old API key; invalidate
    // it so the next TVDB call re-auths with the new key.
    const newTvdbKey = loadConfig().tvdbApiKey;
    if (newTvdbKey !== previousTvdbKey) {
      await fs.rm(config.tvdbTokenPath, { force: true }).catch(() => {});
    }

    return settingsState();
  });

  // 0.1.12 — access info: the port the server runs on + the URLs remote
  // devices can use to reach it. `host` echoes the Host header the caller
  // dialed so the UI can highlight "the address you're using now".
  app.get('/api/settings/access', async (req: FastifyRequest) => {
    const port = config.port;
    const hostHeader = (req.headers.host ?? '').split(':')[0] || null;
    const urls = [
      ...lanAddresses().map((ip) => `http://${ip}:${port}`),
      `http://localhost:${port}`,
    ];
    return { port, host: hostHeader, urls };
  });

  // 0.1.12 — change the listen port. Persists to settings.json; only takes
  // effect on the next server start (see /restart). Validated 1–65535.
  app.post('/api/settings/port', async (req, reply) => {
    const body = (req.body ?? {}) as { port?: unknown };
    const port = parsePort(body.port);
    if (port == null) {
      return reply.code(400).send({ error: 'invalid_port' });
    }
    const overlay = readSettingsOverlay();
    overlay.PORT = String(port);
    await writeSettingsFile(overlay);
    // Reload so a subsequent GET reflects the saved value, even though the
    // live listener keeps the old port until restart.
    reloadConfig();
    return { port, restartRequired: true };
  });

  // 0.1.12 — restart by exiting the process. There is no portable
  // "rebind in place" for an HTTP server, and the user runs the server under a
  // supervisor (Task Scheduler / NSSM / pm2) that relaunches on exit. If no
  // supervisor is configured, the process simply stays down — surfaced in the
  // UI warning. We delay the exit slightly so this response can flush.
  app.post('/api/settings/restart', async (_req, reply) => {
    reply.send({ ok: true, restarting: true });
    await reply;
    setTimeout(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    }, 250);
  });
}
