/**
 * Seek decision (0.1.9, D2).
 *
 * Pure function that decides reuse-vs-respawn for a /seek request. The
 * client never sees this — it just executes the action the server returns.
 * Heavily unit-tested because it's the core piece of state arithmetic that
 * used to live (buggy) on the client.
 */

export type SeekMode = 'reuse' | 'respawn';

export interface EncodedWindow {
  /** Absolute source seconds. */
  from: number;
  to: number;
}

export type SessionLiveness = 'running' | 'gone';

export interface SeekDecisionInput {
  /** Where the client wants to go, in absolute source seconds. */
  targetSeconds: number;
  /** What the current ffmpeg has emitted so far. */
  encodedWindow: EncodedWindow | null;
  /** ffmpeg liveness as of right now. */
  sessionState: SessionLiveness;
}

export interface SeekDecisionResult {
  mode: SeekMode;
  /** When mode === 'reuse', the stream-local seconds the client should set
   *  on `<video>.currentTime` (= target - encodedWindow.from). */
  localSeconds?: number;
}

/**
 * D2 contract:
 *   - target inside [from, to] AND session running → reuse
 *   - everything else → respawn (kill + new ffmpeg from target)
 *
 * Note: the "just behind the encoded window with cached segments on disk"
 * case (D5 — segment retention) is implemented by extending `encodedWindow`
 * to cover the cached-on-disk range when the manager builds the playlist.
 * That keeps this function purely a math check on a single window.
 */
export function decideAction(input: SeekDecisionInput): SeekDecisionResult {
  const { targetSeconds, encodedWindow, sessionState } = input;
  if (sessionState !== 'running' || !encodedWindow) {
    return { mode: 'respawn' };
  }
  if (targetSeconds < encodedWindow.from || targetSeconds > encodedWindow.to) {
    return { mode: 'respawn' };
  }
  return {
    mode: 'reuse',
    localSeconds: Math.max(0, targetSeconds - encodedWindow.from),
  };
}
