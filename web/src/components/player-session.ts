/**
 * Server-driven player session controller (0.1.9, Phase 2).
 *
 * Replaces the legacy 6-field client state machine (streamOffset, pendingSeek,
 * hlsAttachToken, hlsLastAttachUrl, hlsSessionId, currentTime) with three
 * states (attaching | playing | seeking) and one server hop per gesture.
 *
 *   user clicks scrub → controller.seek(absSeconds)
 *     → POST /api/player/:id/seek
 *       reuse:   v.currentTime = action.localSeconds
 *       respawn: tear down hls.js, attach new playlist, v.currentTime = 0
 *
 *   periodic /state ping carries currentLocalSeconds + paused; server uses
 *   it for encode pacing and segment retention.
 *
 * The controller is wired into `<media-player>` in addition to (not instead
 * of) the legacy bootstrap; the legacy path is still selected when the
 * `PLAYER_SESSION` flag is off.
 */

import {
  apiPlayerOpen,
  apiPlayerSeek,
  apiPlayerState,
  apiPlayerTracks,
  apiPlayerClose,
  playerBeaconUrl,
  PlayerCapacityError,
  type PlayerOpenInput,
} from '../api.js';
import type { PlayerOpenResponse, CapacityExceeded } from '../types.js';

type HlsLikeInstance = {
  attachMedia(v: HTMLMediaElement): void;
  loadSource(src: string): void;
  destroy(): void;
  on?(evt: string, cb: (...args: unknown[]) => void): void;
};

interface HlsLikeDefault {
  new (cfg?: unknown): HlsLikeInstance;
  isSupported(): boolean;
}

interface HlsModule {
  default: HlsLikeDefault;
}

export type PlayerSessionState = 'idle' | 'attaching' | 'playing' | 'seeking' | 'capacity' | 'error';

export interface PlayerSessionEvents {
  onState(s: PlayerSessionState): void;
  /** Fired on /open and any /tracks response that returns a fresh bundle.
   *  The component re-renders chrome (audio, subs, chapters) from this. */
  onBundle(b: PlayerOpenResponse): void;
  /** Fired on each /state response; lets the scrubber draw the runway tick. */
  onEncodedWindow(w: { from: number; to: number }, encodePaused: boolean): void;
  /** Fired on a 503 capacity_exceeded response. */
  onCapacity(body: CapacityExceeded): void;
  /** Fired on hard errors that aren't capacity-exceeded. */
  onError(message: string): void;
}

export interface PlayerSessionOptions {
  videoEl: HTMLVideoElement;
  events: PlayerSessionEvents;
  /** Optional override for the playerId; tests / SSR scenarios. */
  playerId?: string;
}

const PLAYER_ID_KEY = 'homemedia.playerId';

/** RFC4122 v4 UUID using `crypto.randomUUID()` when available, otherwise
 *  a `crypto.getRandomValues()`-based fallback. The native API is gated on
 *  a secure context (HTTPS or localhost); the LAN deployment serves over
 *  plain HTTP, so we can't depend on it. */
function uuidV4(): string {
  const c = (typeof crypto !== 'undefined' ? crypto : undefined) as
    | (Crypto & { randomUUID?: () => string })
    | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // 16 random bytes, RFC4122 v4 layout.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC4122 variant
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

/** sessionStorage keeps the same id across soft reloads (back/forward, F5)
 *  so the same <video> instance maps to the same server-side session.
 *  Hard refresh (new tab) gets a fresh id, which the server treats as new. */
export function mintPlayerId(): string {
  try {
    const existing = sessionStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const id = uuidV4();
    sessionStorage.setItem(PLAYER_ID_KEY, id);
    return id;
  } catch {
    return uuidV4();
  }
}

export class PlayerSession {
  readonly playerId: string;
  private readonly videoEl: HTMLVideoElement;
  private readonly events: PlayerSessionEvents;
  private bundle: PlayerOpenResponse | null = null;
  private encodedWindow: { from: number; to: number } = { from: 0, to: 0 };
  private hls: HlsLikeInstance | null = null;
  private state: PlayerSessionState = 'idle';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatPaused = true;
  private currentRelPath: string | null = null;
  private currentSessionId: string | null = null;
  private seekToken = 0;
  /** When the client requested a seek in absolute seconds, this holds it
   *  until `loadedmetadata` (post-respawn). Cleared by `set-current-time`
   *  paths. */
  private pendingResumeAbs: number | null = null;

  constructor(opts: PlayerSessionOptions) {
    this.videoEl = opts.videoEl;
    this.events = opts.events;
    this.playerId = opts.playerId ?? mintPlayerId();
  }

  getState(): PlayerSessionState {
    return this.state;
  }

  getEncodedWindow(): { from: number; to: number } {
    return this.encodedWindow;
  }

  getBundle(): PlayerOpenResponse | null {
    return this.bundle;
  }

  /** Compute absolute source-seconds from the current `<video>.currentTime`. */
  absoluteTime(): number {
    return this.encodedWindow.from + this.videoEl.currentTime;
  }

  /** Adopt a bundle the caller has already fetched (e.g. the
   *  `<media-player>` component fetches /open before the <video>
   *  element renders). Skips the network hop, attaches the playlist,
   *  starts the heartbeat. */
  async adopt(bundle: PlayerOpenResponse): Promise<void> {
    this.bundle = bundle;
    this.encodedWindow = bundle.session.encodedWindow;
    this.currentRelPath = bundle.relPath;
    this.currentSessionId = bundle.session.sessionId;
    this.events.onBundle(bundle);
    this.events.onEncodedWindow(this.encodedWindow, false);
    await this.attachPlaylist(bundle.session.playlistUrl);
    this.startHeartbeat();
    this.setState('playing');
  }

  async open(input: PlayerOpenInput): Promise<void> {
    this.setState('attaching');
    let bundle: PlayerOpenResponse;
    try {
      bundle = await apiPlayerOpen(this.playerId, input);
    } catch (err) {
      if (err instanceof PlayerCapacityError) {
        this.setState('capacity');
        this.events.onCapacity(err.body);
        return;
      }
      this.setState('error');
      this.events.onError((err as Error).message);
      return;
    }
    this.bundle = bundle;
    this.encodedWindow = bundle.session.encodedWindow;
    this.currentRelPath = bundle.relPath;
    this.currentSessionId = bundle.session.sessionId;
    this.events.onBundle(bundle);
    this.events.onEncodedWindow(this.encodedWindow, false);
    await this.attachPlaylist(bundle.session.playlistUrl);
    this.startHeartbeat();
  }

  /** Scrub to an absolute source-second. Single round trip; server decides
   *  reuse vs respawn and returns the action the client should take. */
  async seek(absoluteSeconds: number): Promise<void> {
    if (!this.bundle) return;
    const token = ++this.seekToken;
    this.setState('seeking');
    try {
      const r = await apiPlayerSeek(this.playerId, absoluteSeconds);
      if (token !== this.seekToken) return; // a newer seek superseded us
      this.encodedWindow = r.encodedWindow;
      this.events.onEncodedWindow(this.encodedWindow, false);
      if (r.action.kind === 'set-current-time') {
        this.videoEl.currentTime = r.action.localSeconds;
        this.setState('playing');
        this.currentSessionId = r.sessionId;
        return;
      }
      // Respawn: reattach hls.js to the new playlist URL, then jump to
      // (target - encodedWindow.from). After respawn the new playlist
      // starts at encodedWindow.from, so the local target is computed
      // from the new window the server returned.
      this.pendingResumeAbs = absoluteSeconds;
      this.currentSessionId = r.sessionId;
      await this.attachPlaylist(r.playlistUrl);
      const local = Math.max(0, absoluteSeconds - r.encodedWindow.from);
      this.videoEl.currentTime = local;
      this.pendingResumeAbs = null;
      this.setState('playing');
    } catch (err) {
      if (err instanceof PlayerCapacityError) {
        this.setState('capacity');
        this.events.onCapacity(err.body);
        return;
      }
      this.setState('error');
      this.events.onError((err as Error).message);
    }
  }

  /** Change audio / burn-in / start. Always destructive — server respawns. */
  async changeTracks(body: {
    audioStreamIndex?: number;
    burnSubStreamIndex?: number | null;
    startSeconds?: number;
  }): Promise<void> {
    this.setState('attaching');
    try {
      const bundle = await apiPlayerTracks(this.playerId, body);
      this.bundle = bundle;
      this.encodedWindow = bundle.session.encodedWindow;
      this.currentSessionId = bundle.session.sessionId;
      this.events.onBundle(bundle);
      this.events.onEncodedWindow(this.encodedWindow, false);
      await this.attachPlaylist(bundle.session.playlistUrl);
      this.setState('playing');
    } catch (err) {
      if (err instanceof PlayerCapacityError) {
        this.setState('capacity');
        this.events.onCapacity(err.body);
        return;
      }
      this.setState('error');
      this.events.onError((err as Error).message);
    }
  }

  setPaused(paused: boolean): void {
    this.heartbeatPaused = paused;
    // Refresh the cadence — paused → 30s, playing → 5s.
    this.startHeartbeat();
  }

  /** Tear down — fired on disconnectedCallback / pagehide. */
  async close(useBeacon = false): Promise<void> {
    this.stopHeartbeat();
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* best-effort */
      }
      this.hls = null;
    }
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(playerBeaconUrl(this.playerId));
      return;
    }
    await apiPlayerClose(this.playerId);
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private setState(s: PlayerSessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.events.onState(s);
  }

  private async attachPlaylist(playlistUrl: string): Promise<void> {
    // Tear down any previous hls.js instance.
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* best-effort */
      }
      this.hls = null;
    }

    // hls.js path. Prefer hls.js whenever Media Source Extensions are
    // available — Chrome's "native" HLS (via the Safari engine) has
    // very limited seek support; setting v.currentTime out of buffer is
    // silently ignored. hls.js handles fragment fetching properly.
    // Fall back to native HLS only on browsers without MSE (iOS Safari).
    const mod = (await import(/* @vite-ignore */ 'hls.js')) as unknown as HlsModule;
    const Ctor = mod.default;
    if (Ctor && typeof Ctor.isSupported === 'function' && Ctor.isSupported()) {
      const inst = new Ctor({ enableWorker: true });
      inst.attachMedia(this.videoEl);
      inst.loadSource(playlistUrl);
      this.hls = inst;
      return;
    }

    // No MSE — fall back to native HLS (iOS Safari).
    if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      this.videoEl.src = playlistUrl;
      return;
    }

    this.events.onError('HLS not supported by this browser');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.heartbeatPaused ? 30_000 : 5_000;
    this.heartbeatTimer = setInterval(() => {
      void this.tickState();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async tickState(): Promise<void> {
    if (!this.bundle) return;
    try {
      const r = await apiPlayerState(
        this.playerId,
        Math.max(0, this.videoEl.currentTime),
        this.heartbeatPaused,
      );
      if (r.status === 'gone') {
        // The server forgot us (idle GC, restart, something). Treat as a
        // soft reseek to the current position to revive.
        await this.seek(this.absoluteTime());
        return;
      }
      this.encodedWindow = r.encodedWindow;
      this.events.onEncodedWindow(r.encodedWindow, r.encodePaused);
    } catch {
      // Transient errors — next tick will retry.
    }
  }
}
