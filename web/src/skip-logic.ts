/**
 * Skip intro / credits decisions (0.2.1). Pure — the player feeds it the
 * playhead and acts on what comes back, so the rules are unit-testable.
 *
 * Rules:
 *  - The Skip button shows while the playhead is inside a window.
 *  - Auto-skip (per-show pref) starts a short countdown every time the
 *    playhead enters a window — by playing, resuming or scrubbing.
 *  - "Watch" on the countdown cancels auto-skip for that window for the rest
 *    of this episode.
 *  - Skip Credits lands at the end of the theme song, never the end of the
 *    file, so post-credit scenes still play. When almost nothing follows the
 *    credits, the action becomes "Next Episode".
 */

export type SkipKind = 'intro' | 'credits';

export interface SkipMarkers {
  introStart: number | null;
  introEnd: number | null;
  creditsStart: number | null;
  creditsEnd: number | null;
}

export interface SkipPrefs {
  autoIntro: boolean;
  autoCredits: boolean;
}

/** Seconds of content after the credits below which Skip Credits → Next Episode. */
export const NEXT_EPISODE_TAIL_S = 10;
/** Hide the button in the last second of a window — skipping it saves nothing. */
const WINDOW_END_PAD_S = 1;
/** Auto-skip countdown, so "Watch" can be pressed. */
export const AUTO_SKIP_DELAY_MS = 3000;

export function windowAt(m: SkipMarkers | null, t: number): SkipKind | null {
  if (!m) return null;
  if (m.introStart != null && m.introEnd != null && t >= m.introStart && t < m.introEnd - WINDOW_END_PAD_S) return 'intro';
  if (m.creditsStart != null && m.creditsEnd != null && t >= m.creditsStart && t < m.creditsEnd - WINDOW_END_PAD_S) return 'credits';
  return null;
}

/** Where the skip action lands, or 'next' to go to the next episode. */
export function skipTarget(m: SkipMarkers, kind: SkipKind, duration: number): number | 'next' {
  if (kind === 'intro') return m.introEnd!;
  const end = m.creditsEnd!;
  if (duration > 0 && duration - end <= NEXT_EPISODE_TAIL_S) return 'next';
  return end;
}

export interface SkipView {
  /** Window the playhead is in (null = none). */
  kind: SkipKind | null;
  /** Show the manual Skip button. */
  showButton: boolean;
  /** Start the auto-skip countdown now. */
  startAuto: boolean;
}

/**
 * Per-episode skip state. Create one per opened episode; call `update()`
 * from `timeupdate`.
 */
export class SkipTracker {
  private prevT: number | null = null;
  /** Windows where auto-skip is off for the rest of this episode. */
  private noAuto = new Set<SkipKind>();
  /** Windows already auto-skipped or with a countdown running. */
  private autoStarted = new Set<SkipKind>();

  constructor(
    public markers: SkipMarkers | null,
    public prefs: SkipPrefs,
  ) {}

  update(t: number): SkipView {
    const prev = this.prevT;
    this.prevT = t;
    const kind = windowAt(this.markers, t);
    const prevKind = prev === null ? null : windowAt(this.markers, prev);
    // Left a window: entering it again (e.g. scrubbing back) counts as new.
    if (prevKind && prevKind !== kind) this.autoStarted.delete(prevKind);
    if (!kind) return { kind: null, showButton: false, startAuto: false };

    const auto = kind === 'intro' ? this.prefs.autoIntro : this.prefs.autoCredits;
    const startAuto = auto && !this.noAuto.has(kind) && !this.autoStarted.has(kind);
    if (startAuto) this.autoStarted.add(kind);
    return { kind, showButton: true, startAuto };
  }

  /** "Watch" pressed: no auto-skip for this window again this episode. */
  cancelAuto(kind: SkipKind): void {
    this.noAuto.add(kind);
  }
}
