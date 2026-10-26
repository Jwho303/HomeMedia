# 0.2.1 — Skip Intro / Skip Credits (Theme-Song Fingerprinting)

**Feature ID**: 0.2.1: skip intro and credits. Versions are tagged inline in code comments (e.g. `0.2.0`); this is the umbrella version for the work in this spec.
**Milestone**: M2 (Reach every screen in the house) → v0.2.1
**Status**: ✅ Implemented (all 5 phases). See the As-Built Notes for where the build differs from the original plan.
**Integrated**: ⬜ Not Audited
**Depends On**: 0.1.4.3 (prober: `probeFile()` mtime-gated per-file probe), 0.1.9 (server-driven player session `/open` bundle), 0.2.0 (dpad focus nav + glyph hint bar, so the skip buttons can be reached with a remote).
**Vision Refs**: none. Decisions are recorded inline as D1–D11 below.

---

## Overview

Netflix-style "Skip Intro" needs to know, **before playback**, where each episode's opening theme and ending theme start and stop. No metadata source we use (TMDB, TVDB, OMDb) provides these times. We have to work them out from the audio.

Episodes of a show share the same theme song. If we fingerprint the audio and find the stretch that repeats across episodes, we have the theme. Once a theme's fingerprint is known, any episode, including one added alone later, can be searched for it to find exactly where the theme plays.

```ts
// Today:
//   probeFile() → ffprobe metadata only. Player knows nothing about intros.

// After this feature:
//   theme sweep      → background job after every scan + at server start:
//     (fingerprint)    fingerprints head (first 10 min) + tail (last 8 min) audio of
//                      any episode not yet done / changed since. (1 decode per file, ever)
//     (theme pass)     per show with stale markers: match seasons against known theme
//                      fingerprints, learn new ones where none hit, write per-episode
//                      intro/credits markers. (pure CPU over stored data, no ffmpeg)
//   /open bundle     → carries { markers, skipPrefs }
//   <media-player>   → "Skip Intro" / "Skip Credits" button, or auto-skip with a
//                      "Watch" cancel, per-show preference toggled from the player.
```

**The core problem**: without stored theme fingerprints and per-episode markers, the player cannot offer to skip anything, and finding them during playback would be too late and wouldn't work on native-HLS clients.

**In scope:**
- Fingerprinting the head and tail audio of every episode in a background **theme sweep** after each scan ([`src/themes/sweep.ts`](../../src/themes/sweep.ts)), stored in `episode_fingerprints`.
- **Per-season theme learning, reusing known fingerprints first** (D4): for each new season, try fingerprints already learned for the show before learning a new one.
- Per-episode `intro_*` / `credits_*` markers written by the theme pass.
- **Separate settings for openings and endings** (D11): window size and theme length bounds per kind, and separate auto-skip toggles per show.
- Markers and preferences delivered through the player `/open` bundle.
- Player UI: Skip Intro / Skip Credits buttons, per-show **auto-skip** toggles (in the player popover and on the series page), and a one-off **Watch** override.
- Post-credit-scene safety (D7).
- An admin re-learn endpoint for one show.

**Out of scope:**
- **Cold opens.** Nothing to skip; the theme is found wherever it falls in the head window.
- **Silent credit rolls / credits without a theme song.** There's no audio to match. A later "smarter" version could use black-frame detection.
- **Embedded chapter markers.** Explicitly not used (D1).
- **Movies.** There's no sibling episode to compare against.
- **Recap detection ("Previously on…").** Possible future work.
- **The legacy client (`/legacy`).** Markers are in the bundle, but legacy UI support is a follow-up.

---

## High-Level Design

### Two stages: decode once, match cheaply

```
Stage 1: Fingerprint (per episode, mtime-gated, background sweep)    ← the only expensive part
           ffmpeg -t 600 -i file -map 0:a:0 -vn -ac 1 -ar 11025 -f chromaprint -fp_format raw -       → head_fp
           ffmpeg -ss <duration-480> -t 480 -i file ...                                                → tail_fp
           store both BLOBs in episode_fingerprints; ~0.4 s per episode (audio-only decode), ~20 KB per window

Stage 2: Theme pass (per show with stale markers, after fingerprinting)   ← milliseconds
           load head_fp/tail_fp for all episodes of the series
           for kind in [opening (head), ending (tail)]:
             season-by-season: reuse known fingerprints → else learn → link → locate
           write intro_* / credits_* + markers_version per episode
```

Stage 2 never calls ffmpeg, so re-tuning the matcher or re-learning a show is a cheap re-run over the stored data (D3).

### Season-by-season learning, reusing known fingerprints first

```
known = theme_fingerprints for (series, kind)          // may be empty
for season in seasons ascending:
    linked = season_themes for (series, season, kind)
    if linked is empty:
        hit = first f in known where hits(f, season) >= min(2, |season|)
        if hit: link(season, hit)
        else:
            new = learn(season)                         // longest shared audio across 2–3 eps
            if new: known.push(new); link(season, new)
            // else: season has no theme of this kind — markers stay NULL
    for ep in season where markers_version < CURRENT:
        m = locate(ep, linked) ?? locate(ep, known)     // fallback across all known
        write marker (or NULL if no hit)
```

- **`learn(season)`:** pairwise-align the windows of 2–3 episodes, preferring the first episodes that are present. Take the longest matching run of **15–150 s**. Store that slice of the first episode's fingerprint as the theme.
- **`locate(ep, fps)`:** slide each fingerprint over the episode's window. A hit means enough matching fingerprint points (bit error rate ≤ threshold) for ≥ 80% of the theme's length. Return `[start, end]` in seconds relative to the file.
- **Odd shows:** a season can link to several fingerprints (a theme change mid-season, alternating themes). Falling back to every known fingerprint covers a season whose episodes use different themes.

### Data flow: playing an episode

```
User opens S02E05
  ↓ POST /api/player/:id/open        (existing, src/routes/player.ts:266)
bundle += { markers: {introStart:62.1, introEnd:151.8, creditsStart:1290.4, creditsEnd:1335.0},
            skipPrefs: {autoIntro:false, autoCredits:true} }
  ↓ <media-player> timeupdate
t ∈ [introStart, introEnd) & !autoIntro  → show "Skip Intro" button (focusable in dpad)
t ∈ [creditsStart, creditsEnd) & autoCredits → toast "Skipping credits… [Watch]" 3 s → seek(creditsEnd)
  ↓ after seek, duration − creditsEnd > 10 s → keep playing (post-credit scene)
                duration − creditsEnd ≤ 10 s → offer "Next Episode"
```

### Concrete walkthrough: a show that changes its theme in season 3

```
S1 (10 eps): known=[] → learn(S1) → fp#1 (opening, 88 s). Link S1→fp#1. Locate: 10/10 hit.
S2 (10 eps): try fp#1 → 10/10 hit. Link S2→fp#1. No learning.
S3 (12 eps): try fp#1 → 0/12. learn(S3) → fp#2 (opening, 41 s). Link S3→fp#2. 12/12 hit.
S4 (8 eps):  try fp#1 → 0. try fp#2 → 8/8. Link S4→fp#2.
Later, S4E09 arrives alone: probe → stage 2 → S4 already linked → locate(fp#2) → hit.
```

---

## Design Decisions

### D1: Audio fingerprints only, no chapter guessing
Chapter markers are inconsistent and often missing. Audio is the one signal every episode has. That keeps the feature to a single code path that can be tested.

### D2: Fingerprinting runs up front, in a background sweep after each scan
Everything is computed before playback; the player only reads stored markers. Finding the theme during playback would be too late (the button would appear after the intro started), and native-HLS clients (Safari, older iOS, legacy TVs) can't read the audio at all.

*Changed during the build:* the plan put fingerprinting inside `probeFile()`. The scanner's fast-skip bypasses probing for unchanged files, so existing libraries would never be fingerprinted that way, and a first run over a large library would hold the scan lock for many minutes. A separate single-flight sweep (after every scan, CLI scan, and at server start) covers new files, changed files and the backlog in one place, and never slows a scan down. It touches only theme tables/columns, so it doesn't take the scan lock.

### D3: Store raw head/tail fingerprints in their own table; theme matching is a separate pure stage
Probing handles one file at a time, but learning needs that file's season siblings. Storing the raw fingerprints means the audio is decoded once per file, and stage 2 can be re-run (version bump, admin re-learn, threshold tuning) without touching the video files.

### D4: Themes are stored per series and linked per season; known fingerprints are tried first
Most shows reuse a theme across seasons, so trying known fingerprints first avoids needless learning and keeps markers consistent. Theme changes are handled because a season that matches nothing learns its own fingerprint. The many-to-many `season_themes` link covers seasons with more than one theme.

### D5: Chromaprint through ffmpeg's built-in muxer
The bundled ffmpeg (8.0.1 full build) includes the `chromaprint` muxer (`-f chromaprint -fp_format raw`). There's no new binary and no native Node addon. Audio is downmixed to mono at 11025 Hz to keep decoding fast. If a deployment's ffmpeg lacks the muxer, fingerprinting is skipped and logged once, never failing the probe.

### D6: Learning needs ≥ 2 episodes; locating needs 1
A one-episode season can still get markers if an earlier season's fingerprint matches it. A show with only one episode in total gets no markers. That's acceptable.

### D7: Credits markers cover only the theme audio; never skip to the end of the file
`credits_end` is the end of the matched ending theme, not the file's duration. Skip Credits seeks to `credits_end`. A post-credit scene that follows still plays. "Next Episode" is offered only when ≤ 10 s of content is left after `credits_end`.

### D8: The per-show preference is stored in the DB; the one-off override isn't
"Always skip intro" / "always skip credits" is a per-series row, so it applies on every device. "Watch the intro this time" lives only in the player session. The next episode follows the per-show setting again.

### D9: Auto-skip always gives a cancel window
Auto-skip shows a ~3 s "Skipping intro… [Watch]" toast before seeking. That's how you watch an intro on a show set to always skip, without changing the setting.

### D10: Auto-skip whenever the playhead enters a window
*Changed after testing:* the original rule (no auto-skip after a seek into the window) surprised the user, who expected "always skip" to always skip. Now every entry into a window (playing, resuming or scrubbing) starts the 3 s countdown; **Watch** is the way to stay in the intro, for that episode.

### D11: Openings and endings are tuned separately
Endings tend to be longer and sit next to post-credit scenes and next-episode previews, so each kind has its own parameters in `KIND_PARAMS` ([`src/themes/match.ts`](../../src/themes/match.ts)): window size (opening 600 s, ending 480 s) and accepted theme length (opening 15–150 s, ending 15–180 s). Viewers also choose separately: a show can auto-skip intros but not credits, or the other way round.

---

## Data Model

Additive, applied with the existing `ALTER TABLE ... ADD COLUMN` helper in [`src/db.ts`](../../src/db.ts) and new `CREATE TABLE IF NOT EXISTS` in [`schema.sql`](../../schema.sql).

```sql
-- Raw fingerprints (D3). A separate table so `SELECT e.*` never drags BLOBs
-- into API responses. A row is written even when capture fails (no audio), so
-- the file isn't retried every sweep; a changed mtime triggers a re-capture.
CREATE TABLE IF NOT EXISTS episode_fingerprints (
  episode_id     INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  mtime          INTEGER NOT NULL,
  version        INTEGER NOT NULL,     -- FINGERPRINT_VERSION; bump to re-capture all
  head_fp        BLOB,                 -- uint32 LE array, first 600 s
  tail_fp        BLOB,                 -- uint32 LE array, last 480 s
  tail_offset_s  REAL,                 -- file time where tail_fp begins
  created_at     INTEGER NOT NULL
);
-- Theme pass output.
ALTER TABLE episodes ADD COLUMN intro_start     REAL;
ALTER TABLE episodes ADD COLUMN intro_end       REAL;
ALTER TABLE episodes ADD COLUMN credits_start   REAL;
ALTER TABLE episodes ADD COLUMN credits_end     REAL;
ALTER TABLE episodes ADD COLUMN markers_version INTEGER;  -- NULL = not processed

CREATE TABLE IF NOT EXISTS theme_fingerprints (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('opening','ending')),
  fingerprint   BLOB NOT NULL,
  duration_s    REAL NOT NULL,
  learned_from  INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_theme_fp_series ON theme_fingerprints(series_id, kind);

CREATE TABLE IF NOT EXISTS season_themes (
  series_id      INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season         INTEGER NOT NULL,
  fingerprint_id INTEGER NOT NULL REFERENCES theme_fingerprints(id) ON DELETE CASCADE,
  PRIMARY KEY (series_id, season, fingerprint_id)
);

CREATE TABLE IF NOT EXISTS series_skip_prefs (
  series_id     INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  auto_intro    INTEGER NOT NULL DEFAULT 0,
  auto_credits  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
```

## API

| Endpoint | Change |
|---|---|
| `POST /api/player/:id/open` | Bundle gains `skip: { seriesId, markers: {introStart, introEnd, creditsStart, creditsEnd} \| null, prefs: {autoIntro, autoCredits} }`. Movies: `skip: null`. |
| `GET /api/series/:id` | Response gains `skipPrefs`. |
| `PUT /api/series/:id/skip-prefs` | Body `{autoIntro?: boolean, autoCredits?: boolean}` → upsert, returns the new prefs. Unknown series → 404. |
| `POST /api/series/:id/relearn-themes` | Deletes the show's `theme_fingerprints` / `season_themes`, clears its markers, re-runs stage 2. Uses the stored fingerprints; no re-decode. |
| `npm run themes -- "<show>" [--relearn]` | CLI: runs the sweep, then prints every episode's markers for matching shows (and the learned themes per season). |

---

## Acceptance Criteria

Ticked = covered by an automated test (file in brackets) or checked on the real library. Unticked = not done yet; see As-Built Notes.

### Fingerprint capture (sweep)
- [x] The sweep fingerprints every alive episode's head and tail, and `tail_offset_s = duration − 480`. [tests/themes/sweep.test.ts]
- [x] A file shorter than the window: the head covers the whole file; `tail_offset_s = 0` (`max(0, duration − 480)`).
- [x] A file with no audio stream gets a fingerprint row with NULL windows, isn't retried, and doesn't fail the sweep. [sweep.test.ts]
- [x] The fingerprint uses the first audio stream, the same one playback maps by default (`-map 0:a:0`). *Changed from "default-flagged stream" to match what the player actually plays.* [sweep.test.ts]
- [x] When ffmpeg lacks the `chromaprint` muxer, the sweep does nothing and logs one warning. [sweep.test.ts]
- [x] An unchanged file is never fingerprinted twice; a changed mtime triggers a re-capture. [sweep.test.ts]
- [x] Existing libraries are backfilled. The sweep picks up every episode without a fingerprint row (1,011 of 1,012 real episodes in ~15 min).
- [x] Movies are never fingerprinted. [sweep.test.ts]

### Theme learning & matching (pure, synthetic fingerprints)
- [x] `longestShared()` on 2 windows sharing a 90 s run at different offsets returns that run, 90 ± 1 s, at the right offsets. [tests/themes/match.test.ts]
- [x] Returns null when the shared run is < 15 s or > the kind's max. [match.test.ts]
- [x] A theme interrupted by a short varying gag is still found as one stretch (gap-joining). [match.test.ts]
- [x] `locate()` returns `[start, end]` within ±1 s; null when absent; still hits with 10% of items corrupted; finds a theme cut off by the window edge. [match.test.ts]
- [x] S1 learns one theme per kind; S2 reuses it (no new row); S3 learns a new one; S4 reuses S3's. [tests/themes/pass.test.ts]
- [x] A season whose first episode has no opening still learns from the others. [pass.test.ts] *(Naruto S1E1, found on real data.)*
- [x] A one-episode season matching a known theme gets markers; one matching nothing gets NULL and no new theme. [pass.test.ts]
- [x] A theme change part-way through a season is learned from the misses and linked as a second theme. [pass.test.ts]
- [x] A new episode added later is matched against the known theme without learning. [pass.test.ts]
- [x] Up-to-date seasons are skipped; `force` and relearn recompute. [pass.test.ts]
- [x] The theme pass makes zero ffmpeg calls (it only reads stored fingerprints).
- [x] A cold open (theme 60 s in) yields `intro_start ≈ 60`. [pass.test.ts]

### Post-credit safety
- [x] `credits_end` is the end of the matched ending theme, not the file's duration. [pass.test.ts] *(Naruto: credits end ~30 s before the file, so the next-episode preview still plays.)*
- [x] Skip Credits lands at `credits_end`; with > 10 s left, playback continues. [web/test/skip-logic.test.ts]
- [x] With ≤ 10 s left after `credits_end`, the button reads "Next Episode" and advances. [skip-logic.test.ts]

### API
- [x] The `/open` bundle carries `skip: { seriesId, markers, prefs }` for episodes and `skip: null` for movies.
- [x] `PUT /api/series/:id/skip-prefs {autoCredits:true}` persists and leaves `autoIntro` unchanged; `GET /api/series/:id` reflects it. [tests/routes/skip.test.ts]
- [x] `PUT` for an unknown series or a movie → 404; a non-boolean or unknown field → 400. [skip.test.ts]
- [x] `relearn-themes` rebuilds markers from stored fingerprints. [skip.test.ts]

### Player UI
- [x] The Skip Intro button shows only inside `[introStart, introEnd − 1 s)`. [skip-logic.test.ts]
- [x] Pressing Skip seeks to the window's end through the normal `/seek` path.
- [x] Auto-skip on: running into the window starts one 3 s "Skipping intro… Watch / Skip now" countdown, then seeks. [skip-logic.test.ts]
- [x] **Watch** cancels auto-skip for that window for the rest of this episode only; prefs unchanged. [skip-logic.test.ts]
- [x] Entering a window by any route (playing, resuming, scrubbing, scrubbing back) starts the countdown (D10). [skip-logic.test.ts]
- [x] Starting or resuming inside the window with auto-skip on does skip. [skip-logic.test.ts]
- [x] Intro and credits auto-skip are independent (D11). [skip-logic.test.ts]
- [x] The player's Settings popover has "Always skip intro" / "Always skip credits" for episodes; a toggle saves straight away and applies to the current playback.
- [x] The series page's gear menu has the same two toggles.
- [ ] dpad: the buttons are ordinary focusable `<button>`s, so focus navigation reaches them, but the glyph hint bar doesn't advertise the skip action yet.
- [x] Movies show no skip UI or toggles (`skip: null`).
- [ ] Manual end-to-end check on desktop, iPad (native HLS) and a dpad device.

---

## Implementation Plan

### Phase 1: Fingerprint primitives + CLI ✅
- [x] [`src/themes/fingerprint.ts`](../../src/themes/fingerprint.ts): ffmpeg chromaprint muxer, audio-only, mono 11025 Hz → `Uint32Array`. Muxer support checked once.
- [x] [`src/themes/match.ts`](../../src/themes/match.ts): `segments()` → `chains()` (gap-joining) → `longestShared()` / `locate()`. Per-kind params (D11).
- [x] [`src/cli/themes.ts`](../../src/cli/themes.ts) → `npm run themes [-- "<show>" [--relearn]]`.
- [x] Tuned on real shows (see As-Built Notes).

### Phase 2: Schema ✅
- [x] `episode_fingerprints`, `theme_fingerprints`, `season_themes`, `series_skip_prefs` in [`schema.sql`](../../schema.sql); marker columns on `episodes` via `ensureColumn` in [`src/db.ts`](../../src/db.ts). Wipe clears the new tables (prefs only on a full wipe).

### Phase 3: Theme pass + sweep ✅
- [x] [`src/themes/pass.ts`](../../src/themes/pass.ts): season loop, one transaction per show.
- [x] [`src/themes/sweep.ts`](../../src/themes/sweep.ts): fingerprint backlog (2 ffmpeg at a time), then pass per stale show. Single-flight with one queued follow-up.
- [x] Triggered after `/api/refresh` scans, after `npm run scan`, and at server start.

### Phase 4: API ✅
- [x] `skip` in the `/open` bundle ([`src/player/bundle.ts`](../../src/player/bundle.ts), [`src/routes/player.ts`](../../src/routes/player.ts)).
- [x] [`src/routes/skip.ts`](../../src/routes/skip.ts): `PUT /api/series/:id/skip-prefs`, `POST /api/series/:id/relearn-themes`; `skipPrefs` on `GET /api/series/:id`.

### Phase 5: Player UI ✅ (manual device check outstanding)
- [x] [`web/src/skip-logic.ts`](../../web/src/skip-logic.ts): pure rules (window, target, forward-crossing, Watch).
- [x] [`web/src/components/media-player.ts`](../../web/src/components/media-player.ts): Skip button / countdown overlay, toggles in the Settings popover.
- [x] [`web/src/components/series-detail.ts`](../../web/src/components/series-detail.ts): toggles in the gear menu.
- [ ] Glyph hint bar entry for skip; manual device pass.

---

## As-Built Notes

**Where the build differs from the plan**
- Fingerprinting runs in a background sweep, not inside `probeFile()` (D2). Fingerprints live in their own table, not on `episodes` (D3).
- The relearn endpoint is `/api/series/:id/relearn-themes`, not `/api/admin/...`, so it sits behind the same "configured" guard as the other series routes.
- Matching joins short gaps (≤ 12 s) between shared pieces. Without it, The Simpsons opening (with its changing chalkboard and couch gag) matched only 19 s; with it, 30–47 s.
- Learning prefers a longer candidate that hits ≥ 75% as many episodes as the best one, and locating keeps the longest match among known themes, so a short sting inside the opening doesn't win over the full theme.
- After learning anything new, every season of the show is re-located against all known themes (no extra learning). A theme first learned in season 3 is then found in season 1 too.

**Real-library results** (1,012 episodes, 27 shows, PC server, ffmpeg 8.0.1)
- First fingerprint run: ~15 min (≈0.9 s per episode, 2 at a time). Re-running the theme pass for the whole library: ~3 min, no ffmpeg.
- Intros found in 886 episodes (88%), credits in 624 (62%), 91 themes learned.
- Good: Archer 143/143 intros and 136/143 credits; Naruto 219/220 intros (17 themes across its opening/ending changes; S1E1 has no opening); The Simpsons 110/119 intros.
- Weak or none: *Now Apocalypse* and *INVINCIBLE* (no recurring opening audio found); *Bob's Burgers* and *Scavengers Reign* credits (no recurring ending audio); The Expanse S1 (its title sequence differs from later seasons and only a short shared piece was found).
- Credits markers often cover only the last 20–40 s (the closing theme or studio logos), not a full silent credit roll, as expected (out of scope).

**Known limitations / follow-ups**
- Two near-identical copies of one theme can both be learned (Naruto S1). Harmless (both match), but could be deduplicated.
- A short false "intro" is possible on shows with a recurring non-theme segment (Smiling Friends: 2 episodes, 144 s). Auto-skip is off by default, so it's a visible button, not a silent jump.
- An episode re-parented to another season keeps its old markers until the next relearn.
- Legacy client (`/legacy`) shows no skip UI yet; the bundle already carries the data.

---

## Open Questions

- **Thresholds:** settled for now: `itemBits 10`, `smoothItems 8`, `minCoverage 0.5`, `minSegmentS 4`, `maxGapS 12`. Revisit if false positives show up.
- **Recaps:** a "Skip Recap" could reuse the same machinery (shared audio that isn't the theme). Revisit after 0.2.1.
