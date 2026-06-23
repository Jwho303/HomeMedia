/* 0.2.0 — HomeMedia boot router. ES5 ONLY (no const/let, no arrow fns, no
 * template literals, no optional chaining, no modules). This runs FIRST, on
 * the worst device we want to reach, BEFORE we know what the engine can parse.
 * It is inlined into web/index.html's <head> by the build (see vite.config.ts
 * inlineBootPlugin) so it executes with zero network/parse risk.
 *
 * Job: decide a `bucket` ('modern' | 'legacy') and an orthogonal `inputMode`
 * ('pointer' | 'touch' | 'dpad'), expose window.__hm for debugging/overrides,
 * report the diagnosis to /api/client-log, then either redirect to /legacy or
 * load the modern Lit module bundle exactly as today.
 *
 * Acceptance: parses under an ES5 parser (acorn --ecma5). Do NOT modernize.
 */
(function () {
  'use strict';

  // 0.2.0 Phase 5 — the legacy client now exists and is served at /legacy, so
  // a legacy-bucketed device should actually be redirected (not just logged).
  // Set the gate unless a test has already pinned it (window.__hmBootManual
  // tests leave it undefined to keep the Phase-1 logging-only behaviour).
  if (typeof window.__hmLegacyLive === 'undefined') {
    window.__hmLegacyLive = true;
  }

  // The codecs probe string for MSE H.264 High/Main + AAC-LC. If a device's
  // MediaSource can't claim this, it can't run hls.js + the modern UI (D3).
  var MSE_PROBE = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
  var NATIVE_HLS = 'application/vnd.apple.mpegurl';

  function safeMatchMedia(query) {
    try {
      return !!(window.matchMedia && window.matchMedia(query).matches);
    } catch (e) {
      return false;
    }
  }

  // Capability probe: MSE with H.264/AAC (D3). The single check that does most
  // of the bucketing work — it tests the real capability, not a UA string.
  function hasMseH264() {
    try {
      return !!(
        window.MediaSource &&
        window.MediaSource.isTypeSupported &&
        window.MediaSource.isTypeSupported(MSE_PROBE)
      );
    } catch (e) {
      return false;
    }
  }

  // Capability probe: can the engine run our modern (ES2020+) bundle baseline?
  // We must NOT use `new Function()`/eval here — a Content-Security-Policy
  // without 'unsafe-eval' makes that throw on perfectly modern browsers, which
  // would wrongly bucket a capable desktop as legacy. Instead we feature-detect
  // a handful of built-ins the bundle relies on that simply don't exist on the
  // pre-2016 engines we're trying to exclude (no eval, CSP-safe):
  //   - Promise.prototype.finally (ES2018)
  //   - Object.fromEntries        (ES2019)
  //   - globalThis                (ES2020)
  //   - String.prototype.matchAll (ES2020)
  // A 2014 WebKit TV / old PS lacks these; a current Chromium/WebKit has them.
  function supportsModernSyntax() {
    try {
      return !!(
        typeof Promise !== 'undefined' &&
        Promise.prototype &&
        typeof Promise.prototype['finally'] === 'function' &&
        typeof Object.fromEntries === 'function' &&
        typeof globalThis !== 'undefined' &&
        typeof String.prototype.matchAll === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  // Native HLS playback path (iOS Safari, many TVs) — informational only; it
  // does not gate the bucket, but the legacy client relies on it.
  function canPlayNativeHls() {
    try {
      var v = document.createElement('video');
      return !!(v.canPlayType && v.canPlayType(NATIVE_HLS));
    } catch (e) {
      return false;
    }
  }

  // A gamepad is or has been connected. The Gamepad API only reports a
  // controller after the first input event in some engines, so this is a hint,
  // not a guarantee. Navigation never depends on it (D7); it only nudges
  // inputMode toward 'dpad'.
  function hasGamepadHint() {
    try {
      if (!navigator.getGamepads) return false;
      var pads = navigator.getGamepads();
      for (var i = 0; i < pads.length; i++) {
        if (pads[i]) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // UA → coarse platform enum, for glyph theming only (D4). Never gates bucket.
  function classifyPlatform(ua) {
    if (/Xbox/i.test(ua)) return 'xbox';
    if (/PlayStation|PS4|PS5/i.test(ua)) return 'playstation';
    if (/Tizen/i.test(ua)) return 'tizen';
    if (/Web0S|webOS/i.test(ua)) return 'webos';
    return 'generic';
  }

  // The core detector. Capability owns the bucket; UA only refines inputMode
  // and platform (D4). Any throw is caught by the caller's try/catch → legacy.
  function detect() {
    var ua = navigator.userAgent || '';

    var mse = hasMseH264();
    var modernJs = supportsModernSyntax();
    var nativeHls = canPlayNativeHls();

    var bucket = mse && modernJs ? 'modern' : 'legacy';

    // Input axis is ORTHOGONAL to bucket (D2). dpad when there's no fine
    // pointer AND we have a couch signal (a known TV/console UA, or a
    // gamepad). A coarse pointer with no couch signal → touch; otherwise
    // pointer.
    var finePointer = safeMatchMedia('(pointer: fine)');
    var coarsePointer = safeMatchMedia('(pointer: coarse)');
    var couchUa = /Xbox|PlayStation|PS4|PS5|Tizen|Web0S|webOS|SmartTV|BRAVIA|AppleTV|GoogleTV|CrKey/i.test(ua);

    var inputMode;
    if (!finePointer && (couchUa || hasGamepadHint())) {
      inputMode = 'dpad';
    } else if (coarsePointer) {
      inputMode = 'touch';
    } else {
      inputMode = 'pointer';
    }

    return {
      bucket: bucket,
      inputMode: inputMode,
      platform: classifyPlatform(ua),
      mse: mse,
      modernJs: modernJs,
      nativeHls: nativeHls
    };
  }

  // The safe default for any failure or undecidable result (D5). Legacy works
  // everywhere (native HLS + plain DOM); a capable device wrongly sent here
  // still watches its movie, while a legacy device wrongly sent to modern gets
  // a white screen. The asymmetry makes legacy the correct fallback.
  function legacyDefault() {
    return {
      bucket: 'legacy',
      inputMode: 'pointer',
      platform: 'generic',
      mse: false,
      modernJs: false,
      nativeHls: canPlayNativeHls(),
      detectError: true
    };
  }

  // Parse ?platform= / ?input= overrides off location.search. These let a
  // device with no devtools be steered by typing a URL with the remote, and
  // back the window.__hm.force()/setInput() escape hatches (D9).
  function readQuery() {
    var out = {};
    try {
      var q = location.search || '';
      if (q.charAt(0) === '?') q = q.slice(1);
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var kv = parts[i].split('=');
        var k = decodeURIComponent(kv[0] || '');
        var v = decodeURIComponent(kv[1] || '');
        if (k) out[k] = v;
      }
    } catch (e) {
      /* malformed query — ignore, use detected values */
    }
    return out;
  }

  function applyOverrides(d) {
    var q = readQuery();
    // ?platform=legacy|modern forces the bucket regardless of capabilities.
    if (q.platform === 'legacy' || q.platform === 'modern') {
      d.bucket = q.platform;
      d.forcedBucket = true;
    }
    // ?input=pointer|touch|dpad forces the input mode.
    if (q.input === 'pointer' || q.input === 'touch' || q.input === 'dpad') {
      d.inputMode = q.input;
      d.forcedInput = true;
    }
    // ?glyph=xbox|playstation|generic forces the glyph platform (dev/testing).
    // Lets a desktop preview the controller glyphs without spoofing the UA.
    if (q.glyph === 'xbox' || q.glyph === 'playstation' || q.glyph === 'generic') {
      d.platform = q.glyph;
      d.forcedGlyph = true;
    }
    return d;
  }

  // Fire-and-forget POST of the diagnosis to the existing client-log endpoint
  // (D8). MUST never throw or block boot: a boot log that wedges the page is
  // worse than no log. Uses sendBeacon when available, else a guarded fetch.
  function reportDiag(diag) {
    try {
      var payload = JSON.stringify({ tag: 'device.boot', evt: 'device.boot', device: diag });
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/client-log', blob);
        return;
      }
      if (window.fetch) {
        window
          .fetch('/api/client-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          })
          ['catch'](function () {
            /* boot log is best-effort */
          });
      }
    } catch (e) {
      /* never let logging break boot */
    }
  }

  // Merge an object of query updates onto the current search and reload. A
  // value of null/undefined DELETES that key. Backs force()/setInput()/spoof()
  // — the user-facing escape hatch and dev steerers (D9).
  function updateQueryAndReload(updates) {
    try {
      var q = readQuery();
      for (var key in updates) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          if (updates[key] === null || typeof updates[key] === 'undefined') {
            delete q[key];
          } else {
            q[key] = updates[key];
          }
        }
      }
      var pairs = [];
      for (var k in q) {
        if (Object.prototype.hasOwnProperty.call(q, k)) {
          pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(q[k]));
        }
      }
      var search = pairs.length ? '?' + pairs.join('&') : '';
      location.href = location.pathname + search + (location.hash || '');
    } catch (e) {
      /* if even this fails the user can hand-edit the URL */
    }
  }

  // Convenience single-key wrapper.
  function setQueryAndReload(key, value) {
    var u = {};
    u[key] = value;
    updateQueryAndReload(u);
  }

  function gamepadsSummary() {
    var ids = [];
    try {
      if (navigator.getGamepads) {
        var pads = navigator.getGamepads();
        for (var i = 0; i < pads.length; i++) {
          if (pads[i]) ids.push(pads[i].id);
        }
      }
    } catch (e) {
      /* ignore */
    }
    return ids;
  }

  // Inject the modern Lit module bundle exactly as the app loaded it before
  // this router existed. In a build the inliner strips the original
  // <script type=module> and we inject the hashed /assets bundle here. In dev,
  // Vite keeps serving the original /src/main.ts tag, so injecting again would
  // load the app twice — we detect an already-present entry and skip.
  function loadModernBundle() {
    var src = window.__hmBootSrc || '/src/main.ts';
    var existing = document.querySelectorAll('script[type="module"][src]');
    for (var i = 0; i < existing.length; i++) {
      // getAttribute (not .src) so we compare the literal path, not a
      // browser-resolved absolute URL.
      if (existing[i].getAttribute('src') === src) return; // already loading
    }
    var s = document.createElement('script');
    s.type = 'module';
    s.src = src;
    // boot.js runs inlined in <head>, BEFORE <body> is parsed, so
    // document.body is null here — appending to it throws and must NOT be
    // mistaken for "this engine can't run modern" (that would wrongly bounce
    // every desktop to /legacy). Append to <head> / documentElement, which
    // always exist; a deferred module script runs the same either way.
    var parent = document.head || document.documentElement || document.body;
    parent.appendChild(s);
  }

  // Compute the diagnosis with the legacy-default safety net (D5). Any throw
  // inside capability probing yields the legacy default rather than escaping.
  function diagnose() {
    try {
      return applyOverrides(detect());
    } catch (e) {
      return applyOverrides(legacyDefault());
    }
  }

  // The full boot sequence: diagnose, publish window.__hm, report, then route.
  // Returns the diag so callers/tests can assert on it without re-running.
  function run() {
    var diag = diagnose();

    window.__hm = {
      diag: diag,
      force: function (bucket) {
        setQueryAndReload('platform', bucket === 'legacy' ? 'legacy' : 'modern');
      },
      setInput: function (mode) {
        setQueryAndReload('input', mode);
      },
      // Dev/testing: preview the full couch experience on a desktop without
      // spoofing the User-Agent. spoof('playstation')/'xbox' forces dpad input
      // AND the matching controller glyphs; spoof(null|'off') clears both.
      // Reloads so the boot router re-derives the diagnosis from the overrides.
      spoof: function (platform) {
        if (!platform || platform === 'off' || platform === 'generic') {
          updateQueryAndReload({ input: null, glyph: null });
          return;
        }
        updateQueryAndReload({ input: 'dpad', glyph: platform });
      },
      gamepads: gamepadsSummary,
      reportDiag: function () {
        reportDiag(window.__hm.diag);
      }
    };

    reportDiag(diag);

    if (diag.bucket === 'legacy') {
      // Phase 1 ships logging-only: no /legacy client exists yet, so we still
      // load the modern bundle but record the diagnosis (D8). Phase 5 flips
      // window.__hmLegacyLive on so this branch actually redirects.
      if (window.__hmLegacyLive && location.pathname.indexOf('/legacy') !== 0) {
        // Never load the Lit bundle on a legacy engine — parsing it may throw.
        location.replace('/legacy/' + (location.hash || ''));
        return diag;
      }
      // Logging-only fallthrough: load modern so the device still works while
      // we collect real-device data before committing the legacy client.
      loadModernBundle();
      return diag;
    }

    loadModernBundle();
    return diag;
  }

  // ─── exports + run ────────────────────────────────────────────────────────

  // Expose the pure pieces for unit testing (the detection matrix in
  // web/test/boot.test.ts mocks MediaSource/matchMedia/userAgent and calls
  // these directly). Harmless in production — it's a tiny object on window.
  window.__hmBoot = {
    detect: detect,
    diagnose: diagnose,
    applyOverrides: applyOverrides,
    legacyDefault: legacyDefault,
    classifyPlatform: classifyPlatform,
    run: run
  };

  // Auto-run unless a test has asked to drive boot manually (it sets
  // window.__hmBootManual = true before loading this file, inspects the pure
  // functions, then calls window.__hmBoot.run() itself when it wants routing).
  if (!window.__hmBootManual) {
    run();
  }
})();
