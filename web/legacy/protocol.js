/* 0.2.0 (Phase 4) — ES5 port of the server player protocol for the legacy
 * client. Dependency-free: no MSE, no hls.js, no Lit, no modules. Speaks the
 * exact same endpoints as the modern PlayerSession (web/src/components/
 * player-session.ts) — the server is unchanged.
 *
 *   POST   /api/player/:id/open      attach to a relPath → bundle (playlistUrl)
 *   POST   /api/player/:id/seek      absolute-seconds → reuse OR respawn (D6)
 *   POST   /api/player/:id/state     heartbeat + position + paused
 *   POST   /api/player/:id/tracks    change audio / burn-in (respawn)
 *   DELETE /api/player/:id           teardown   (POST /delete beacon alias)
 *
 * Authored to run in a 2014 browser AND to be require()-d by the vitest port
 * test (UMD-ish: attaches to window when present, exports for CommonJS too).
 * It takes its `fetch`/`sessionStorage`/`crypto` from an injectable `env` so
 * the test can drive it without a DOM and the browser passes the real globals.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HMProtocol = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PLAYER_ID_KEY = 'homemedia.playerId';

  function defaultEnv() {
    return {
      // Bind to window — native fetch throws "Illegal invocation" when called
      // with `this` set to anything other than the global (we call it as
      // ENV.fetch(...), which would re-bind `this` to ENV).
      fetch:
        typeof window !== 'undefined' && window.fetch
          ? function (url, opts) {
              return window.fetch(url, opts);
            }
          : typeof fetch !== 'undefined'
            ? fetch
            : null,
      sessionStorage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
      crypto: typeof crypto !== 'undefined' ? crypto : null,
      sendBeacon:
        typeof navigator !== 'undefined' && navigator.sendBeacon
          ? function (url, body) {
              return navigator.sendBeacon(url, body);
            }
          : null
    };
  }

  // RFC4122 v4 UUID. crypto.randomUUID is gated on a secure context (HTTPS/
  // localhost); the LAN box serves plain HTTP, so fall back to getRandomValues
  // and then Math.random — same logic as the modern client.
  function uuidV4(env) {
    var c = env.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var bytes = new Array(16);
    var i;
    if (c && c.getRandomValues) {
      var arr = new Uint8Array(16);
      c.getRandomValues(arr);
      for (i = 0; i < 16; i++) bytes[i] = arr[i];
    } else {
      for (i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC4122 variant
    var hex = [];
    for (i = 0; i < 16; i++) {
      var h = bytes[i].toString(16);
      if (h.length < 2) h = '0' + h;
      hex.push(h);
    }
    return (
      hex.slice(0, 4).join('') + '-' +
      hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' +
      hex.slice(8, 10).join('') + '-' +
      hex.slice(10, 16).join('')
    );
  }

  // sessionStorage keeps the same id across soft reloads so the same <video>
  // maps to the same server session.
  function mintPlayerId(env) {
    env = env || defaultEnv();
    try {
      var existing = env.sessionStorage && env.sessionStorage.getItem(PLAYER_ID_KEY);
      if (existing) return existing;
      var id = uuidV4(env);
      if (env.sessionStorage) env.sessionStorage.setItem(PLAYER_ID_KEY, id);
      return id;
    } catch (e) {
      return uuidV4(env);
    }
  }

  function jsonPost(env, url, body) {
    return env.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // Shared response handler mirroring the modern client's playerPost(): 503 →
  // capacity error, 410 → "gone" body passthrough (state), other !ok → throw.
  function handle(res) {
    if (res.status === 503) {
      return res.json().then(
        function (cap) {
          if (cap && cap.error === 'capacity_exceeded') {
            var err = new Error('capacity_exceeded:' + cap.kind);
            err.capacity = cap;
            throw err;
          }
          throw new Error('503 Service Unavailable');
        },
        function () {
          throw new Error('503 Service Unavailable');
        }
      );
    }
    if (res.status === 410) {
      return res.json().then(
        function (b) {
          return b;
        },
        function () {
          return {};
        }
      );
    }
    if (!res.ok) {
      throw new Error(res.status + ' ' + res.statusText);
    }
    return res.json();
  }

  function base(playerId) {
    return '/api/player/' + encodeURIComponent(playerId);
  }

  // ── Protocol verbs ────────────────────────────────────────────────────────

  // POST /open — attach to a relPath. `input` may carry audioStreamIndex,
  // burnSubStreamIndex, startSeconds (resume target). Returns the open bundle
  // whose session.playlistUrl is set straight onto <video>.src (native HLS).
  function open(env, playerId, input) {
    return jsonPost(env, base(playerId) + '/open', input).then(handle);
  }

  // POST /seek — D6: the legacy client always treats seek as server-respawn.
  // The server may still answer 'set-current-time' for an in-window target;
  // we honour that (cheap), but for any respawn we reload the playlist URL.
  function seek(env, playerId, absoluteSeconds) {
    return jsonPost(env, base(playerId) + '/seek', { absoluteSeconds: absoluteSeconds }).then(
      handle
    );
  }

  // POST /state — heartbeat. Returns { status:'alive'|'gone', encodedWindow,
  // encodePaused }. The 5s interval keeps the server session alive.
  function state(env, playerId, currentLocalSeconds, paused) {
    return jsonPost(env, base(playerId) + '/state', {
      currentLocalSeconds: currentLocalSeconds,
      paused: paused
    }).then(handle);
  }

  // POST /tracks — change audio / burn-in. Always destructive (respawn).
  function tracks(env, playerId, body) {
    return jsonPost(env, base(playerId) + '/tracks', body).then(handle);
  }

  // Teardown. Prefer DELETE; on pagehide the caller passes useBeacon so the
  // close survives the unload (sendBeacon → POST /delete alias).
  function close(env, playerId, useBeacon) {
    if (useBeacon && env.sendBeacon) {
      env.sendBeacon(base(playerId) + '/delete', '');
      return Promise.resolve();
    }
    return env.fetch(base(playerId), { method: 'DELETE' })['catch'](function () {
      /* tab closing — best effort */
    });
  }

  function beaconUrl(playerId) {
    return base(playerId) + '/delete';
  }

  return {
    PLAYER_ID_KEY: PLAYER_ID_KEY,
    defaultEnv: defaultEnv,
    uuidV4: uuidV4,
    mintPlayerId: mintPlayerId,
    open: open,
    seek: seek,
    state: state,
    tracks: tracks,
    close: close,
    beaconUrl: beaconUrl
  };
});
