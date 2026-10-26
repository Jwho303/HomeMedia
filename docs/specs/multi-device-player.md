# 0.2.0 — Multi-Device Player Routing (Boot Router + Input Modes + Legacy Client)

**Feature ID**: 0.2.0 — multi-device player support. HomeMedia tags versions inline in code comments (e.g. `0.1.9`); there is no `ROADMAP.md`. This ID is the umbrella version for the work in this spec.
**Milestone**: M2 (Reach every screen in the house) → v0.2.0
**Status**: ✅ Implemented (all 5 phases)
**Integrated**: ⬜ Not Audited
**Depends On**: 0.1.9 (server-driven player session: `/open` `/seek` `/state` `/tracks` `/close`) — none of this spec changes the server protocol.
**Vision Refs**: none (no `docs/vision/` in this repo). Architectural decisions captured inline as D1–D9 below.

---

## Overview

Today HomeMedia has exactly one client: a Lit + `hls.js` + MSE single-page app served from `web/dist`, reachable only with a mouse and keyboard. It is excellent on desktop and works on iPad, but it is **undrivable from a couch** (no focus model, no remote/controller navigation) and **unloadable on old devices** (pre-2016 smart TVs, PS4) whose browsers cannot parse the modern JS/CSS or lack Media Source Extensions.

The server is already device-agnostic: every source is normalized to **H.264/AAC HLS** ([`src/streaming/hls-args.ts`](../../src/streaming/hls-args.ts)) and served from a per-session endpoint `/api/hls/:sessionId/master.m3u8` ([`src/routes/player.ts:600`](../../src/routes/player.ts)). That URL plays on essentially every device we want to reach. **The entire gap is on the client.**

```ts
// Today:
//   web/index.html → loads the Lit bundle unconditionally.
//   A 2014 WebKit TV throws on parse; a PlayStation has no focusable UI.

// After this feature:
//   web/index.html → inline ES5 boot router runs first.
//     detects capabilities → sets inputMode (pointer|touch|dpad) or routes to /legacy
//   Modern devices (incl. Xbox/PS5/modern TVs) → the SAME Lit app, with a
//     focus-navigation layer + controller glyphs that activate in dpad mode.
//   Legacy devices / detection failure → a separate, thin ES5 client at /legacy
//     that drives a native <video> through the existing server protocol.
```

**The core problem**: without a capability-detecting entry point and a couch-input layer, the app reaches only pointer devices — TVs, consoles, and old hardware either can't be navigated or can't load it at all.

**In scope:**
- An ES5, dependency-free **boot router** that detects a *platform bucket* and an *input mode*, with a manual `?platform=` / `?input=` override and a `window.__hm` debug surface.
- A **focus-navigation controller** (D-pad / remote / keyboard) layered onto the existing Lit app, gated by `inputMode === 'dpad'`. Serves desktop arrow keys, TV remotes, and game controllers through one keyboard-event model.
- A **controller-glyph hint bar** that themes button prompts (Xbox Ⓐ/Ⓑ vs PlayStation ✕/○) by detected platform, defaulting to neutral labels when unsure.
- A separate **legacy client** at `/legacy`: native-HLS `<video>` + flat ES5 UI, speaking the existing `/open`/`/seek`/`/state`/`/close` protocol. Seek-by-respawn only.
- **Server wiring** in [`src/server.ts`](../../src/server.ts) to serve `/legacy` and the inlined boot script, plus a device-bucket field on the client-log payload so real devices report what they are.

**Out of scope:**
- Any change to the ffmpeg pipeline or the player session protocol — the server already does the hard part (0.1.9). This spec is client + static-serving only.
- A separate "console" client. Per **D2**, console/desktop/tablet are one client differentiated by an `inputMode` flag, not a route.
- Gamepad *analog stick* navigation and per-button polling for navigation (keyboard events cover navigation; the Gamepad API is used only for glyph detection — **D7**).
- Casting (Chromecast/AirPlay) — separate future feature.

---

## High-Level Design

### The three layers (and the one real fork)

```
Layer 0: Boot router (web/boot.js, inlined ES5)        ← runs FIRST, on the worst device
           detects: { bucket: 'modern'|'legacy', inputMode: 'pointer'|'touch'|'dpad', platform }
           bucket==='legacy'  → redirect to /legacy and STOP (never loads the Lit bundle)
           bucket==='modern'  → set window.__hm, load the Lit module bundle as today

Layer 1: Focus navigation (web/src/nav/*, modern client)  ← the real work, ~150 lines
           attaches globally when inputMode==='dpad'. Player/grids stay platform-unaware.
           one keydown handler serves: desktop arrows, TV remote D-pad, controller D-pad.

Layer 2: Glyph hint bar (web/src/components/glyph-hint-bar.ts)  ← cosmetic, last
           reads platform + Gamepad API id; renders contextual "Ⓐ Play  Ⓑ Back" prompts.

Legacy client (web/legacy/*, separate ES5 build at /legacy)  ← the ONLY genuine 2nd client
           native <video src=m3u8>, flat DOM, server protocol port. Seek = always respawn.
```

The governing principle (**D1/D2**): *the modern client is one app in three input modes; `/legacy` is the only separate client, because it is the only genuine fork* (different engine target, no MSE, no Lit, no hls.js). Console/desktop/tablet share the same engine (Chromium + MSE) and differ only by input + glyphs — expressed as a **flag**, never an `if (isXbox)` scattered through the player.

### The boot router — the main interface

```js
// web/boot.js — ES5 ONLY. No arrow fns, no const/let, no template literals,
// no optional chaining. This runs BEFORE we know what the device can parse.
// Inlined into <head> so it executes with zero network/parse risk.
(function () {
  function detect() {
    var ua = navigator.userAgent || '';
    // 1. Capability: MSE with H.264 is the primary discriminator (D3).
    var mse = !!(window.MediaSource &&
      window.MediaSource.isTypeSupported &&
      window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'));
    // 2. Capability: can the engine run our modern bundle baseline? (D4)
    var modernJs = supportsModernSyntax();
    // 3. Native HLS — the legacy playback path.
    var nativeHls = canPlayNativeHls();

    var bucket = (mse && modernJs) ? 'modern' : 'legacy';

    // Input axis is ORTHOGONAL to bucket (D2). dpad if no fine pointer and
    // (TV/console UA hint OR a gamepad is/has been connected).
    var finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    var couchUa = /Xbox|PlayStation|Tizen|Web0S|webOS|SmartTV|BRAVIA|AppleTV/i.test(ua);
    var inputMode = !finePointer && (couchUa || hasGamepadHint())
      ? 'dpad'
      : (window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'pointer');

    var platform = classifyPlatform(ua); // 'xbox'|'playstation'|'tizen'|'webos'|'generic'
    return { bucket: bucket, inputMode: inputMode, platform: platform,
             mse: mse, modernJs: modernJs, nativeHls: nativeHls };
  }

  function applyOverrides(d) { /* read ?platform= / ?input= from location.search */ return d; }

  var diag = applyOverrides(detect());
  window.__hm = { diag: diag, force: forceModeFn /* see Debug section */ };
  reportDiag(diag); // POST to /api/client-log (D8) — fire-and-forget

  if (diag.bucket === 'legacy') {
    // Never load the Lit bundle on a legacy engine — just parsing it may throw.
    if (location.pathname.indexOf('/legacy') !== 0) location.replace('/legacy/' + location.hash);
    return;
  }
  // Modern: load the Lit module bundle exactly as today.
  loadModernBundle(); // injects <script type="module" src="/assets/index.js">
})();
```

### Data flow — modern device with a controller

```
PS5 powers on app at /
  ↓
boot.js detect():  mse=true, modernJs=true → bucket='modern'
                   finePointer=false, couchUa=/PlayStation/ → inputMode='dpad'
                   platform='playstation'
  ↓ window.__hm.diag set, POST /api/client-log {evt:'device.boot', diag}
loadModernBundle() → Lit app boots as normal
  ↓ app-shell reads window.__hm.diag.inputMode === 'dpad'
FocusNavController.attach(document)        ← THIS FEATURE (Layer 1)
  ↓ player/grids render unchanged; nav layer tracks focus + draws focus ring
<glyph-hint-bar platform="playstation">    ← THIS FEATURE (Layer 2)
  ↓ user presses D-pad → keydown 'ArrowRight' → focus moves to next poster
  ↓ user presses ✕ → keydown 'Enter' → existing click handler fires
existing navigate()/<media-player> ...     (already exists, untouched)
```

### Data flow — legacy device

```
2014 Tizen TV opens app at /
  ↓
boot.js detect(): mse=false (or modernJs=false) → bucket='legacy'
  ↓ location.replace('/legacy/')
/legacy/index.html  (flat ES5, no Lit, no hls.js)
  ↓ ES5 client mints playerId, POST /api/player/:id/open   (existing route)
  ↓ sets <video>.src = bundle.session.playlistUrl  (native HLS)
  ↓ POST /api/player/:id/state every 5s              (existing route, keeps session alive)
  ↓ user scrubs → POST /api/player/:id/seek → server respawns → reload playlist (D6)
```

### Concrete walkthrough — a wrong guess falls safely to legacy

A user opens the app on an obscure 2017 TV whose browser claims MSE support but whose implementation is subtly broken. `detect()` returns `bucket='modern'`, the Lit app loads, and playback stalls. Because of **D9**, the modern app shows a persistent "Trouble playing? Switch to Basic Player" affordance that calls `window.__hm.force('legacy')`, which sets `?platform=legacy` and reloads into `/legacy`. The user is never stranded; the fallback is one action away, and the boot log already captured the bad `diag` for us to tune detection later.

---

## Design Decisions

### D1: The detector runs on the worst device, so it is hand-written ES5

**Decision**: `web/boot.js` is authored in ES5 (no `const`/`let`, arrow functions, template literals, optional chaining, or modules) and **inlined** into `web/index.html`'s `<head>`. It is *not* part of the Vite/Lit build.

**Why**: The detector's whole job is to decide whether the device can run the modern bundle. If the detector itself uses syntax a 2014 engine can't parse, the page throws before it can route — defeating the purpose. Inlining removes a network round-trip and any chance of a module-loader failing on an old engine.

**How to apply**: Keep `boot.js` dependency-free and ES5. Add an ESLint override (or a separate file excluded from the TS build) so the modern lint rules don't "fix" it into ES2020. A tiny `npm run build` step concatenates it into `index.html` (or commit it pre-inlined — see **D5**).

### D2: Input mode is a flag, not a route. `/legacy` is the only second client

**Decision**: Console, desktop, and tablet all load the **same** modern client at `/`. They differ only by `inputMode ∈ {pointer, touch, dpad}`. There is **no `/console` route**. The only separate route+client is `/legacy`.

**Why**: Xbox/PS5/modern-TVs run the identical engine (Chromium + MSE), use hls.js, and render the existing Lit UI. A `/console` route would re-import the entire app and add only navigation + glyphs — that is the Swiss-army-knife mess relocated, not avoided. `/legacy` earns a separate route because it is a *genuine* fork: ES5 target, no MSE, no hls.js, no Lit, flat UI sharing nothing but the server protocol.

**How to apply**: The player and grids stay **platform-unaware**. Navigation and glyphs are self-contained modules that *attach around* the app based on the flag. If consoles later need heavier divergence (e.g. TV CPU can't handle the CSS), promoting the flag to a route is straightforward — but do not build that on speculation.

### D3: MSE support is the primary bucket discriminator

**Decision**: `bucket = (hasMSE_h264 && modernJs) ? 'modern' : 'legacy'`. MSE is checked via `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')`.

**Why**: MSE availability cleanly separates "can run hls.js + the modern UI" from "must use native HLS + a lean UI." It is the single check that does most of the work, and it tests the actual capability rather than sniffing a UA string (which lies and rots).

**How to apply**: Require **both** MSE and the modern-syntax probe — a device can have MSE but still fail to parse the bundle, and vice versa. Either failure → legacy.

### D4: Bucketing is capability-based; UA only refines `platform` and `inputMode`

**Decision**: The modern/legacy decision uses capability probes only. User-agent strings are used **solely** to (a) hint `inputMode='dpad'` for known couch platforms and (b) classify `platform` for glyph theming.

**Why**: UA sniffing for capabilities is fragile and a maintenance trap. But UA is the *only* reliable signal for "this is an Xbox" — there is no capability that distinguishes a console from a desktop Chromium. So UA is used where it is the right tool (identity) and avoided where it is the wrong tool (capability).

**How to apply**: `classifyPlatform()` returns a coarse enum and defaults to `'generic'`. Never let a UA miss downgrade a *capable* device to legacy — capability probes own the bucket.

### D5: Detection failures default to legacy

**Decision**: Any exception in `detect()`, an undecidable result, or a missing capability defaults to `bucket='legacy'`.

**Why**: Legacy works *everywhere* — it is native HLS + plain DOM. A modern device wrongly sent to legacy still watches its movie (uglier, fewer features). A legacy device wrongly sent to modern gets a white screen. The asymmetry makes legacy the correct safe default.

**How to apply**: Wrap `detect()` in `try/catch` returning the legacy default. Budget for ~5% wrong guesses; **D9** provides the user-facing escape hatch and **D8** captures the data to tune thresholds.

### D6: Legacy seeks are always server-respawn

**Decision**: In the legacy client, every scrub issues `POST /api/player/:id/seek` and reloads the returned playlist URL into `<video>.src`. No attempt at in-buffer native seek.

**Why**: Native HLS seeking is unreliable — already documented at [`web/src/components/player-session.ts:309`](../../web/src/components/player-session.ts). The server already supports seek-by-respawn (it re-encodes from the target via input-side `-ss`, [`src/streaming/hls-args.ts:124`](../../src/streaming/hls-args.ts)). Respawn is slower (a few seconds) and keyframe-coarse, but reliable — the right trade for the "make my old TV work at all" tier.

**How to apply**: Disable any reliance on `video.currentTime` jumps for out-of-window targets. Show a brief "Seeking…" state while the respawn playlist loads. Resume/position persistence is unaffected (server-side).

### D7: Navigation uses keyboard events; the Gamepad API is for glyphs only

**Decision**: Focus navigation listens to `keydown` (arrows + Enter + Escape/Back). The Gamepad API (`navigator.getGamepads()`) is used **only** to detect controller presence/type for glyph theming, never for navigation.

**Why**: On Xbox Edge and PlayStation's browser, the D-pad emits arrow keys and the confirm button emits Enter. One keyboard handler transparently serves desktop keyboard, TV remotes, and controllers — a large simplification, and it improves desktop keyboard accessibility for free. The Gamepad API is only needed to read a controller's `id` ("DualSense", "Xbox One Controller") for picking glyph sets.

**How to apply**: Build navigation first with zero Gamepad code. Add Gamepad polling later, solely to inform `<glyph-hint-bar>`. If glyph detection is uncertain, render neutral "OK / Back" labels — wrong glyphs are worse than generic ones.

### D8: The boot router reports its diagnosis; ship logging-only first

**Decision**: `boot.js` POSTs its `diag` object to the existing client-log endpoint ([`src/routes/client-log.ts`](../../src/routes/client-log.ts)) on every boot. **Phase 1 ships the router routing everyone to the modern client** (logging only) before any legacy client exists.

**Why**: We cannot fully test detection without owning every device. Shipping the detector in logging-only mode lets real devices tell us what bucket/platform they report *before* we commit a client to them. We build the legacy client (Phase 4) on evidence, targeting the precise devices that actually show up.

**How to apply**: Add a `device` section to the client-log schema. Keep the POST fire-and-forget and failure-silent (a boot log must never block boot). Watch logs after Phase 1 before prioritizing Phase 4.

### D9: A user-facing "Basic Player" escape hatch always exists

**Decision**: The modern client renders a persistent, low-key affordance to switch to the legacy player, wired to `window.__hm.force('legacy')`.

**Why**: Detection will be wrong ~5% of the time, and a stalled modern player on a TV is unrecoverable without devtools. A one-action fallback turns a dead end into a minor downgrade. (Symmetric `?platform=modern` exists for the rare reverse case, mainly for testing.)

**How to apply**: `force(bucket)` sets the override query param and reloads. Place the affordance where a stuck user will find it — e.g. on the player error panel ([`media-player.ts` error-panel](../../web/src/components/media-player.ts)) and in Settings.

---

## Acceptance Criteria

**Boot router (ES5)**
- [ ] `boot.js` contains no ES6+ syntax (verify: parses under an ES5 parser / `acorn --ecma5`).
- [ ] `detect()` returns `bucket==='legacy'` when `MediaSource` is undefined.
- [ ] `detect()` returns `bucket==='legacy'` when `isTypeSupported` returns false for the H.264/AAC probe string.
- [ ] `detect()` returns `bucket==='modern'` when MSE-h264 and the modern-syntax probe both pass.
- [ ] `detect()` returns `inputMode==='dpad'` when `(pointer: fine)` does not match AND the UA matches a couch platform.
- [ ] `detect()` returns `inputMode==='touch'` for a coarse-pointer device with no couch UA.
- [ ] `detect()` returns `inputMode==='pointer'` for a fine-pointer desktop.
- [ ] `?platform=legacy` forces `bucket==='legacy'` regardless of capabilities.
- [ ] `?platform=modern` forces `bucket==='modern'`.
- [ ] `?input=dpad` forces `inputMode==='dpad'`.
- [ ] A thrown error inside capability probing yields the legacy default (does NOT propagate).
- [ ] `bucket==='legacy'` triggers `location.replace` to `/legacy` and does NOT inject the modern module bundle.
- [ ] `window.__hm.diag` is populated before the modern bundle loads.

**Focus navigation**
- [ ] `FocusNavController.attach()` is a no-op when `inputMode !== 'dpad'`.
- [ ] ArrowRight from a focused poster moves focus to the geometrically nearest poster to its right.
- [ ] ArrowDown from the last visible row scrolls the next row into view and focuses it.
- [ ] Enter on a focused element dispatches the same activation as a click.
- [ ] Escape/Back invokes the existing `goBack()` ([`web/src/router.ts`](../../web/src/router.ts)).
- [ ] The focused element renders a visible focus ring (does NOT rely on `:hover`).
- [ ] Detaching removes all listeners (no leaked `keydown` handler after `detach()`).

**Glyph hint bar**
- [ ] `<glyph-hint-bar platform="xbox">` renders Xbox glyphs (Ⓐ/Ⓑ).
- [ ] `<glyph-hint-bar platform="playstation">` renders PlayStation glyphs (✕/○).
- [ ] Unknown/`generic` platform renders neutral text labels ("OK"/"Back"), NOT wrong glyphs.

**Legacy client**
- [ ] `/legacy/` serves an ES5 page that loads with no MSE and no `hls.js`.
- [ ] Legacy client mints a playerId and completes `POST /open`, then sets `<video>.src` to the playlist URL.
- [ ] Legacy client POSTs `/state` on a 5s interval while playing (keeps the session alive).
- [ ] A scrub issues `POST /seek` and reloads the respawned playlist (does NOT set `currentTime` for out-of-window targets).
- [ ] Resume position from the `/open` bundle is honored.
- [ ] Audio-track change issues `POST /tracks` and reloads.
- [ ] Closing the page sends `/close` (or the beacon alias).

**Server wiring**
- [ ] `GET /legacy/` and `GET /legacy/*` serve the legacy static bundle.
- [ ] `GET /` serves `index.html` with the inlined `boot.js`.
- [ ] The client-log schema accepts a `device` diagnosis object; `POST /api/client-log` with a boot diag returns 2xx.

---

## Implementation Plan

### Phase 1: Boot router, logging-only ✅
> Ship the detector routing everyone to the modern client; start collecting real-device data (D8).

- [ ] Implement `web/boot.js` — ES5 `detect()` + `?platform=`/`?input=` overrides + `window.__hm` + legacy-default `try/catch`.
- [ ] Inline `boot.js` into `web/index.html` `<head>`; add the build/concat step (or commit pre-inlined) and an ESLint exclusion (D1, D5).
- [ ] In **Phase 1 only**, the `legacy` branch still loads the modern bundle (no `/legacy` exists yet) but logs the diagnosis.
- [ ] Extend client-log schema with a `device` section; emit `device.boot` from `boot.js` (D8).
- [ ] Tests: `detect()` bucket/input matrix (mock `MediaSource`, `matchMedia`, `navigator.userAgent`); override parsing; legacy-default on thrown probe.

### Phase 2: Focus navigation (dpad input mode) ✅
> Win Xbox/PS5/modern TVs on the existing app — no second client.

- [ ] Implement `web/src/nav/focus-nav-controller.ts` — global `keydown` handler, geometric nearest-neighbor focus, roving tabindex, scroll-into-view, Enter→activate, Escape→`goBack()`.
- [ ] Add `:focus-visible` focus-ring styling to focusable elements (posters, buttons, episode rows, player controls).
- [ ] Wire `app-shell` to `attach()` the controller when `window.__hm.diag.inputMode === 'dpad'` (no-op otherwise).
- [ ] Player assumes fullscreen + maps hardware Back in dpad mode.
- [ ] Tests: nearest-neighbor direction math; attach/detach listener lifecycle; no-op when not dpad; Enter dispatches activation.

### Phase 3: Controller glyphs ✅
> The native-feel delight layer (cosmetic, optional).

- [ ] Implement `web/src/components/glyph-hint-bar.ts` — contextual prompt bar themed by `platform`, neutral fallback.
- [ ] Add glyph SVGs to [`web/src/components/icons.ts`](../../web/src/components/icons.ts) (Xbox + PlayStation sets).
- [ ] Add Gamepad API detection (id → controller type) to refine `platform` live (D7).
- [ ] Render the hint bar in browse/series/player views in dpad mode.
- [ ] Tests: glyph set per platform; neutral fallback for `generic`.

### Phase 4: Legacy client ✅
> The genuine second client — built once Phase 1 logs show which devices need it.

- [ ] Implement `web/legacy/` — flat ES5 page(s): browse grid → episode list → native-`<video>` player.
- [ ] Port the server protocol to dependency-free ES5: playerId mint, `/open`, `/seek` (respawn, D6), `/state` heartbeat, `/tracks`, `/close`/beacon. Source of truth: [`web/src/components/player-session.ts`](../../web/src/components/player-session.ts).
- [ ] Force subtitle **burn-in** on legacy (no soft `<track>` reliance); keep audio-track picker.
- [ ] Separate build target (ES5, no MSE, minimal CSS — no `aspect-ratio`/`backdrop-filter`/custom properties).
- [ ] Drop on legacy: precise scrub, encoded-runway tick, PiP, playback speed, chapters, diagnostic overlay (see feature matrix below).
- [ ] Tests: protocol port (open→play→state→seek-respawn→close); resume honored; ES5-parse check on the built bundle.

### Phase 5: Integration & Wiring ✅
> Wire everything into the running app and verify each device class is reachable.

- [ ] Serve `/legacy/` and `/legacy/*` static bundle in [`src/server.ts`](../../src/server.ts) alongside the existing `web/dist` static registration.
- [ ] Flip Phase 1's logging-only legacy branch to actually `location.replace('/legacy')`.
- [ ] Add the "Basic Player" escape hatch (D9) to the player error panel and Settings, wired to `window.__hm.force('legacy')`.
- [ ] Document `window.__hm` debug commands (see Debug Surface) in `README`.
- [ ] Manually verify end-to-end: desktop (pointer), iPad (touch), a console/TV or emulated dpad (dpad), and a forced `?platform=legacy` run.
- [ ] Remove any Phase-1 logging-only stub branch.
- [ ] Update version tags to `0.2.0` where the existing inline scheme is used.

---

## Debug Surface (`window.__hm`)

You cannot open devtools on a PlayStation or a 2014 TV, so detection must be inspectable and overridable at runtime.

```js
window.__hm.diag                 // the full detection result object
window.__hm.force('legacy')      // set ?platform=legacy and reload (D9)
window.__hm.force('modern')      // set ?platform=modern and reload
window.__hm.setInput('dpad')     // set ?input=dpad and reload
window.__hm.gamepads()           // navigator.getGamepads() summary (id strings)
window.__hm.reportDiag()         // re-POST the diagnosis to /api/client-log on demand
```

These are also reachable via URL (`?platform=`, `?input=`) so a device with no keyboard can be steered by typing a URL with the remote.

---

## Legacy Feature Matrix

What the `/legacy` client keeps, loses, and deliberately drops vs. the modern player. The constraint driving every row: **no MSE → no hls.js → a native `<video>` we can't byte-control.**

| Feature | Legacy | Why |
|---|---|---|
| H.264/AAC playback | ✅ Keep | Native HLS plays it; the whole point. |
| Play/pause/volume/mute | ✅ Keep | Basic `<video>` API, universal. |
| Resume position | ✅ Keep | Server-side via `/open`; ffmpeg spawns at the offset. |
| Watched/progress persistence | ✅ Keep | `/state` heartbeat — plain `fetch`, port to ES5. |
| Audio-track selection | ✅ Keep | Server-side `/tracks` respawn; picker is a list. |
| Subtitles | ✅ Keep (burn-in only) | ffmpeg burns into video. Soft `<track>` dropped (unreliable on old TVs). |
| Episode prev/next + auto-advance | ✅ Keep | Navigation + a new `/open`. |
| Browse movies/series | ✅ Keep | Plain DOM grids. |
| Precise / in-buffer scrubbing | ❌ Lose | No MSE. Seek = server respawn (D6): slower, keyframe-coarse. |
| Encoded-runway scrubber tick | ❌ Lose | Depends on hls.js buffer state; show a plain progress bar. |
| Event-driven buffering spinner | ❌ Lose | Native `waiting`/`playing` events are inconsistent on TVs. |
| Picture-in-Picture | ❌ Lose | Absent on TVs anyway. |
| Soft sideloaded `<track>` subs | ❌ Lose | Old-TV `<track>` support is wildly inconsistent → force burn-in. |
| Chapters / ticks / tooltips | 🟡 Drop | Possible but polish; out for v1. |
| Playback speed (0.5×–2×) | 🟡 Drop | `playbackRate` unreliable on TVs; low couch value. |
| Diagnostic/trace overlay + report | 🟡 Drop | Dev tooling; `window.__hm` covers legacy diagnosis. |
| Backdrop blur / gradients / genie anims / idle fades | 🟡 Drop | Replace with flat, cheap, instantly-rendered chrome (weak TV CPUs). |
| Hover states | 🟡 Drop | No pointer; replaced by focus rings (dpad) — N/A on legacy's simpler nav. |

Net: legacy = *watch the movie, pick audio, get (burned-in) subtitles, resume, next episode* — the core viewing experience intact, minus precise scrubbing and cosmetic polish.

---

## Key Files

| File | Change |
|------|--------|
| `web/boot.js` | **New** — ES5 boot router: `detect()`, overrides, `window.__hm`, diag reporting (D1). |
| `web/index.html` | **Modify** — inline `boot.js` in `<head>`; remove the unconditional module-bundle `<script>` (boot injects it). |
| `web/src/nav/focus-nav-controller.ts` | **New** — D-pad/remote/keyboard focus navigation (Layer 1, D7). |
| `web/src/components/glyph-hint-bar.ts` | **New** — controller-glyph contextual hint bar (Layer 2). |
| `web/src/components/icons.ts` | **Modify** — add Xbox + PlayStation glyph SVGs. |
| `web/src/components/app-shell.ts` | **Modify** — attach focus nav + render hint bar when `inputMode==='dpad'`. |
| `web/src/components/media-player.ts` | **Modify** — dpad fullscreen/Back; "Basic Player" escape hatch on error panel (D9). |
| `web/legacy/` (index.html + ES5 JS/CSS) | **New** — the separate legacy client (Phase 4). |
| `web/legacy/protocol.js` | **New** — ES5 port of the server protocol from `player-session.ts`. |
| `src/server.ts` | **Modify** — serve `/legacy/` static bundle; keep `web/dist` serving (Phase 5). |
| `src/routes/client-log.ts` | **Modify** — accept a `device` diagnosis section (D8). |
| `web/vite.config.ts` | **Modify** — second ES5 build target for `web/legacy`; inline-boot step. |
| `tests/...` / `web/test/...` | **New** — detection matrix, nav direction math + lifecycle, glyph theming, legacy protocol port, ES5-parse checks. |

---

## Implementation Notes

<!-- Filled in DURING and AFTER implementation, not during spec writing. -->

### Deviations from spec

- **Legacy client served from source, not `dist/legacy/`.** The spec implied a
  Vite ES5 build target + copy into `dist/`. The legacy files are hand-authored
  ES5 with no imports, so a build step adds nothing. More importantly, copying
  them under `WEB_DIST` made the root `@fastify/static` (`prefix:'/'`,
  `wildcard:false`) auto-register a `/legacy/` directory-index route that
  collided (HEAD already declared) with our explicit `/legacy/` handler. So the
  server serves `web/legacy/*` straight from source via three tiny pinned-
  filename handlers (`index.html`/`app.js`/`protocol.js`) + a `/legacy` → 308
  `/legacy/` redirect. No second `@fastify/static`, no `dist/legacy/`.
- **Boot `legacy` branch is gated by `window.__hmLegacyLive`.** Phase 1 needed
  logging-only (no redirect) while Phase 5 needed the real redirect. Rather than
  editing boot.js between phases, boot.js reads a `window.__hmLegacyLive` flag:
  it defaults the flag to `true` at the top (Phase 5 live), and tests pin it
  off to assert the Phase-1 logging-only behaviour. One file, both behaviours.
- **boot.js is testable via `window.__hmBoot` + `window.__hmBootManual`.** To
  unit-test `detect()`/`applyOverrides()`/`run()` (acceptance matrix) the IIFE
  exposes its pure functions on `window.__hmBoot` and suppresses its auto-run
  when a test sets `window.__hmBootManual`. Harmless in production.
- **Glyph-bar theme asserted via `data-glyph` attributes, not SVG text.**
  happy-dom doesn't reliably serialize deeply-nested SVG template parts, so each
  rendered glyph carries `data-glyph="xbox-confirm"` etc. for robust testing
  (and as a stable hook) rather than depending on the `<text>A</text>` content.

### Deferred items

- **Resume-on-legacy precision.** The legacy client trusts the server's spawn
  offset for resume and pre-positions the scrubber; if a future server change
  stops spawning at the resume offset, the legacy client would need an explicit
  respawn-seek to the resume point on open. Left as-is since the server resumes
  server-side today.
- **`modulepreload` for the entry.** Stripping the discovered module `<script>`
  in the inline-boot plugin means Vite emits no `<link rel=modulepreload>` for
  the entry; boot.js injects it at runtime instead. Slightly less optimal
  preloading; correctness is unaffected.

### Lessons & gotchas

- **`document instanceof Document` is `false` in happy-dom.** The focus-nav
  controller's "is this a Document?" check uses `nodeType === 9`, not
  `instanceof Document`, or `searchRoot()` silently picks the wrong root and
  `playerActive()`/`collect()` break only under test.
- **Lit + happy-dom drop a top-level `.map(...)` of templates.** An array of
  `html` templates as the sole top-level child renders to `<!---->&lt;?&gt;`.
  Wrapping the map in a container element (e.g. `<div class="bar">`) fixes it —
  matches how the existing components render lists.
- **`"Wireless Controller"` is ambiguous.** Both "Xbox Wireless Controller" and
  Sony's bare "Wireless Controller" contain the phrase, so gamepad-id → platform
  must check explicit Xbox/Sony brand tokens *before* treating the generic
  phrase as a PlayStation signal.
