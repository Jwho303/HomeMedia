import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 0.2.0 Phase 4 — legacy protocol port.
 *
 * protocol.js is the ES5 port of the modern PlayerSession's server hops. It is
 * UMD-ish, so we require() it straight into Node and drive it with an injected
 * `env` (mock fetch / sessionStorage / crypto) — no DOM needed. We verify the
 * full open → state → seek(respawn) → close flow hits the right URLs/bodies and
 * honours resume, then assert the file is ES5-clean.
 */

interface Protocol {
  PLAYER_ID_KEY: string;
  mintPlayerId: (env: MockEnv) => string;
  uuidV4: (env: MockEnv) => string;
  open: (env: MockEnv, id: string, input: unknown) => Promise<unknown>;
  seek: (env: MockEnv, id: string, abs: number) => Promise<unknown>;
  state: (env: MockEnv, id: string, local: number, paused: boolean) => Promise<unknown>;
  tracks: (env: MockEnv, id: string, body: unknown) => Promise<unknown>;
  close: (env: MockEnv, id: string, useBeacon?: boolean) => Promise<void> | void;
  beaconUrl: (id: string) => string;
}

// Load the UMD module. Under vitest+happy-dom `window` is defined, so the UMD
// wrapper assigns window.HMProtocol; require()'s module.exports can come back
// empty in that path, so prefer the global and fall back to the require result.
const required = require(resolve(here, '..', 'legacy', 'protocol.js')) as Protocol;
const P = ((window as unknown as { HMProtocol?: Protocol }).HMProtocol ?? required) as Protocol;
const PROTO_SRC = readFileSync(resolve(here, '..', 'legacy', 'protocol.js'), 'utf8');

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface MockEnv {
  fetch: ReturnType<typeof vi.fn>;
  sessionStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
  crypto: { getRandomValues: (a: Uint8Array) => Uint8Array };
  sendBeacon: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeEnv(responder: (url: string, init?: RequestInit) => Response): MockEnv {
  const calls: FetchCall[] = [];
  const store: Record<string, string> = {};
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  });
  return {
    fetch,
    sessionStorage: {
      getItem: (k) => (k in store ? store[k]! : null),
      setItem: (k, v) => {
        store[k] = v;
      },
    },
    crypto: {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 7 + 3) & 0xff;
        return a;
      },
    },
    sendBeacon: vi.fn(() => true),
    calls,
  };
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse((call.init?.body as string) ?? '{}') as Record<string, unknown>;
}

const OPEN_BUNDLE = {
  playerId: 'pid',
  relPath: 'Movies/Dune.mkv',
  reused: false,
  session: {
    sessionId: 's1',
    playlistUrl: '/api/hls/s1/master.m3u8',
    encodedWindow: { from: 0, to: 30 },
    startSeconds: 0,
  },
  metadata: {
    durationSeconds: 7200,
    audioStreams: [{ index: 1, codec: 'aac', language: 'eng', title: null }],
    activeAudioStreamIndex: 1,
  },
  resume: { position: 1800, duration: 7200, watched: false },
};

describe('legacy protocol.js — ES5 conformance', () => {
  it('parses under an ES5 parser (acorn ecmaVersion: 5)', async () => {
    const { parse } = await import('acorn');
    expect(() => parse(PROTO_SRC, { ecmaVersion: 5 })).not.toThrow();
  });
});

describe('legacy protocol.js — defaultEnv().fetch binding', () => {
  it('wraps window.fetch so calling env.fetch(...) does not throw "Illegal invocation"', () => {
    // Regression: capturing `fetch` bare and calling it as ENV.fetch(...) sets
    // `this` to ENV, and native fetch throws when `this` !== window. The env
    // must wrap it so the call site is safe.
    const calls: string[] = [];
    (window as unknown as { fetch: (u: string) => Promise<Response> }).fetch = function (
      this: unknown,
      u: string,
    ): Promise<Response> {
      // Native fetch enforces `this === window`; emulate that contract.
      if (this !== window) throw new TypeError('Illegal invocation');
      calls.push(u);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    };
    const env = (P as unknown as { defaultEnv: () => { fetch: (u: string) => Promise<Response> } }).defaultEnv();
    expect(() => env.fetch('/api/library')).not.toThrow();
    expect(calls).toContain('/api/library');
  });
});

describe('legacy protocol.js — playerId mint', () => {
  it('mints a v4 UUID and persists it in sessionStorage', () => {
    const env = makeEnv(() => jsonResponse(200, {}));
    const id1 = P.mintPlayerId(env);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Second call returns the same id (sessionStorage persistence).
    const id2 = P.mintPlayerId(env);
    expect(id2).toBe(id1);
  });
});

describe('legacy protocol.js — open → state → seek(respawn) → close', () => {
  let env: MockEnv;
  beforeEach(() => {
    env = makeEnv((url) => {
      if (url.indexOf('/open') >= 0) return jsonResponse(200, OPEN_BUNDLE);
      if (url.indexOf('/state') >= 0) {
        return jsonResponse(200, { status: 'alive', encodedWindow: { from: 0, to: 60 }, encodePaused: false });
      }
      if (url.indexOf('/seek') >= 0) {
        return jsonResponse(200, {
          sessionId: 's2',
          playlistUrl: '/api/hls/s2/master.m3u8',
          encodedWindow: { from: 3600, to: 3630 },
          mode: 'respawn',
          action: { kind: 'reattach', pendingResumeAt: 3600 },
        });
      }
      return jsonResponse(204, {});
    });
  });

  it('POST /open carries the relPath and returns the bundle (resume honoured)', async () => {
    const bundle = (await P.open(env, 'pid', { relPath: 'Movies/Dune.mkv' })) as typeof OPEN_BUNDLE;
    const call = env.calls[0]!;
    expect(call.url).toBe('/api/player/pid/open');
    expect(call.init?.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ relPath: 'Movies/Dune.mkv' });
    // Resume position is present in the bundle for the UI to seek to.
    expect(bundle.resume.position).toBe(1800);
    expect(bundle.session.playlistUrl).toBe('/api/hls/s1/master.m3u8');
  });

  it('POST /state sends currentLocalSeconds + paused and keeps the session alive', async () => {
    const r = (await P.state(env, 'pid', 42, false)) as { status: string };
    const call = env.calls[env.calls.length - 1]!;
    expect(call.url).toBe('/api/player/pid/state');
    expect(bodyOf(call)).toEqual({ currentLocalSeconds: 42, paused: false });
    expect(r.status).toBe('alive');
  });

  it('POST /seek returns a respawn action with a fresh playlist (D6)', async () => {
    const r = (await P.seek(env, 'pid', 3600)) as {
      mode: string;
      playlistUrl: string;
      encodedWindow: { from: number };
      action: { kind: string };
    };
    const call = env.calls[env.calls.length - 1]!;
    expect(call.url).toBe('/api/player/pid/seek');
    expect(bodyOf(call)).toEqual({ absoluteSeconds: 3600 });
    expect(r.mode).toBe('respawn');
    expect(r.playlistUrl).toBe('/api/hls/s2/master.m3u8');
    expect(r.encodedWindow.from).toBe(3600);
  });

  it('close() DELETEs the player resource', async () => {
    await P.close(env, 'pid', false);
    const call = env.calls[env.calls.length - 1]!;
    expect(call.url).toBe('/api/player/pid');
    expect(call.init?.method).toBe('DELETE');
  });

  it('close(useBeacon) uses sendBeacon to the /delete alias (survives unload)', () => {
    P.close(env, 'pid', true);
    expect(env.sendBeacon).toHaveBeenCalledWith('/api/player/pid/delete', '');
    expect(P.beaconUrl('pid')).toBe('/api/player/pid/delete');
  });
});

describe('legacy protocol.js — capacity + gone handling', () => {
  it('throws a capacity error (with body) on 503 capacity_exceeded', async () => {
    const env = makeEnv(() =>
      jsonResponse(503, { error: 'capacity_exceeded', kind: 'global', limit: 2, active: 2, retryAfterSeconds: 5 }),
    );
    await expect(P.open(env, 'pid', { relPath: 'x' })).rejects.toThrow(/capacity_exceeded/);
  });

  it('passes through the 410 "gone" body on /state', async () => {
    const env = makeEnv(() => ({ ok: false, status: 410, statusText: 'Gone', json: () => Promise.resolve({ status: 'gone' }) } as unknown as Response));
    const r = (await P.state(env, 'pid', 10, false)) as { status: string };
    expect(r.status).toBe('gone');
  });
});
