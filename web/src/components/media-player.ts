import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  apiClientLog,
  apiLibrary,
  apiPlayerOpen,
  apiPlaybackGet,
  apiPlaybackPost,
  apiSeries,
  embeddedSubsUrl,
  hlsBeaconUrl,
  PlayerCapacityError,
  ShareOfflineError,
  subsUrl,
  type PlayerOpenInput,
} from '../api.js';
import { PlayerSession, mintPlayerId } from './player-session.js';
import type { CapacityExceeded, PlayerOpenResponse } from '../types.js';
import { getConsoleBuffer } from '../console-buffer.js';
import type {
  AudioStream,
  Chapter,
  LibraryItem,
  StreamProbe,
  SubInfo,
  SubStream,
  Episode,
  SeriesDetail,
} from '../types.js';
import { goBack, homeHref, navigate, playHref, seriesHref } from '../router.js';
import { getConnectionState } from '../connection-store.js';
import { forceBasicPlayer } from '../nav/basic-player.js';
import {
  cacheLibrary,
  cacheSeriesDetail,
  findCachedSeriesItemByEpisodePath,
  getCachedMovie,
  getCachedSeriesContaining,
} from './series-detail.js';
import './player-popover.js';
import './episode-grid.js';
import {
  iconBackChevron,
  iconPlay,
  iconPause,
  iconPrev,
  iconNext,
  iconVolume,
  iconVolumeMute,
  iconCC,
  iconAudio,
  iconGrid,
  iconSettings,
  iconFullscreen,
  iconFullscreenExit,
  iconPip,
  iconCheck,
  iconInfo,
  iconBug,
} from './icons.js';

/** sessionStorage prefix for the per-file sticky audio-track choice. The value
 *  is the chosen `audioIndex` (local within audio streams). (0.1.4.3) */
const AUDIO_PREF_PREFIX = 'homemedia.audioPref.v1:';
/** sessionStorage prefix for the per-file sticky subtitle choice. Stored as
 *  the discriminated string: `off` | `sibling:<i>` | `embedded:<index>` |
 *  `burn:<index>`. (0.1.4.3) */
const SUB_PREF_PREFIX = 'homemedia.subPref.v1:';

function readAudioPref(relPath: string): number | null {
  try {
    const raw = sessionStorage.getItem(AUDIO_PREF_PREFIX + relPath);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeAudioPref(relPath: string, audioIndex: number): void {
  try {
    sessionStorage.setItem(AUDIO_PREF_PREFIX + relPath, String(audioIndex));
  } catch { /* ignore */ }
}

function readSubPref(relPath: string): string | null {
  try {
    return sessionStorage.getItem(SUB_PREF_PREFIX + relPath);
  } catch {
    return null;
  }
}

function writeSubPref(relPath: string, value: string): void {
  try {
    sessionStorage.setItem(SUB_PREF_PREFIX + relPath, value);
  } catch { /* ignore */ }
}

/** Map an ISO 639 language code to a human-readable label. Falls back to the
 *  raw code when unknown. (0.1.4.3) */
const LANGUAGE_LABELS: Record<string, string> = {
  eng: 'English', en: 'English',
  jpn: 'Japanese', ja: 'Japanese',
  spa: 'Spanish', es: 'Spanish',
  fra: 'French', fre: 'French', fr: 'French',
  deu: 'German', ger: 'German', de: 'German',
  ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese',
  rus: 'Russian', ru: 'Russian',
  zho: 'Chinese', chi: 'Chinese', zh: 'Chinese',
  kor: 'Korean', ko: 'Korean',
  ara: 'Arabic', ar: 'Arabic',
  hin: 'Hindi', hi: 'Hindi',
  nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
  swe: 'Swedish', sv: 'Swedish',
  pol: 'Polish', pl: 'Polish',
  tur: 'Turkish', tr: 'Turkish',
};

export function languageLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const norm = code.toLowerCase();
  return LANGUAGE_LABELS[norm] ?? code;
}

export function describeAudioStream(s: AudioStream, fallbackIndex: number): string {
  const lang = languageLabel(s.language);
  const ch = s.channels >= 6 ? '5.1' : s.channels === 8 ? '7.1' : s.channels === 2 ? '2.0' : `${s.channels}ch`;
  const codec = (s.codec ?? '').toUpperCase() || `Track ${fallbackIndex + 1}`;
  const tail = s.title ? ` (${s.title})` : '';
  return `${lang} · ${ch} · ${codec}${tail}`;
}

export function describeSubStream(s: SubStream): string {
  const lang = languageLabel(s.language);
  const tail = s.title ? ` — ${s.title}` : '';
  const burn = !s.textBased ? ' (Burn-in — restarts playback)' : '';
  return `${lang}${tail}${burn}`;
}

const FLUSH_INTERVAL_MS = 10_000;
const WATCHED_RATIO = 0.9;
const IDLE_TIMEOUT_MS = 3_000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Strip directories + the file extension to get a human-ish title from a path.
 *  Used only as a last-resort fallback when neither the series cache nor the
 *  library cache has the file. */
export function titleFromPath(relPath: string): string {
  const slash = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  const file = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Format a season/episode pair as "S01E08". */
export function formatSeasonEpisode(season: number, episode: number): string {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `S${s}E${e}`;
}

type PopoverKey = 'cc' | 'audio' | 'settings' | 'grid' | 'info' | null;

/** Sticky volume preferences. Persisted across <media-player> instances so
 *  switching episodes (which remounts <video>) doesn't reset to the browser
 *  defaults, and across page reloads via localStorage. */
const VOLUME_STORAGE_KEY = 'homemedia.volume.v1';
interface VolumePrefs { volume: number; muted: boolean }
const volumePrefs: VolumePrefs = (() => {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VolumePrefs>;
      const v = typeof parsed.volume === 'number' ? parsed.volume : 1;
      return {
        volume: Math.max(0, Math.min(1, v)),
        muted: parsed.muted === true,
      };
    }
  } catch { /* fall through to defaults */ }
  return { volume: 1, muted: false };
})();
function saveVolumePrefs(): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(volumePrefs));
  } catch { /* localStorage unavailable — fine */ }
}

/** Throttles position writes during continuous playback and flushes on demand. */
export class PlaybackPersister {
  private lastFlushAt = 0;
  private lastSentPosition = -1;
  constructor(
    private readonly relPath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called from `timeupdate`. POSTs at most once per FLUSH_INTERVAL_MS. */
  maybeWrite(position: number, duration: number): void {
    if (duration <= 0) return;
    const t = this.now();
    // First write always goes through; thereafter throttle.
    if (this.lastFlushAt !== 0 && t - this.lastFlushAt < FLUSH_INTERVAL_MS) return;
    if (Math.abs(position - this.lastSentPosition) < 0.5) return;
    this.lastFlushAt = t;
    this.lastSentPosition = position;
    void apiPlaybackPost(this.relPath, { position, duration }).catch(() => {
      // Reset so the next tick retries.
      this.lastFlushAt = 0;
    });
  }

  /** Synchronous-ish flush for pause / visibilitychange (uses normal POST). */
  flushNow(position: number, duration: number): void {
    if (duration <= 0) return;
    this.lastFlushAt = this.now();
    this.lastSentPosition = position;
    void apiPlaybackPost(this.relPath, { position, duration }).catch(() => {
      this.lastFlushAt = 0;
    });
  }

  /** Last-resort flush at unload — use sendBeacon, payload matches POST schema. */
  flushBeacon(position: number, duration: number): void {
    if (duration <= 0) return;
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    const blob = new Blob([JSON.stringify({ position, duration })], {
      type: 'application/json',
    });
    navigator.sendBeacon(
      `/api/playback/${encodeURIComponent(this.relPath)}`,
      blob,
    );
  }

  fireWatched(position: number, duration: number): void {
    void apiPlaybackPost(this.relPath, { position, duration, watched: true }).catch(
      () => {},
    );
  }
}

interface SiblingInfo {
  prev: Episode | null;
  next: Episode | null;
  series: SeriesDetail | null;
  current: Episode | null;
}

/** One-line summary of the most informative fields in a trace data
 *  payload so the collapsed devtools row is useful at a glance. Falls
 *  back to a compact `key=value` rendering of every primitive field. */
function traceSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (typeof v === 'number') {
      parts.push(`${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`);
    } else if (typeof v === 'string' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    }
  };
  // Priority fields first.
  push('target', data['target']);
  push('position', data['position']);
  push('localSeconds', data['localSeconds']);
  push('mode', data['mode']);
  push('reused', data['reused']);
  if (data['encodedWindow']) {
    const w = data['encodedWindow'] as { from?: number; to?: number };
    if (typeof w.from === 'number' && typeof w.to === 'number') {
      parts.push(`enc=[${w.from.toFixed(0)},${w.to.toFixed(0)}]`);
    }
  }
  push('videoCT', data['videoCT']);
  push('videoBuffered', data['videoBuffered']);
  push('videoReady', data['videoReady']);
  push('paused', data['paused']);
  push('seeking', data['seeking']);
  push('encodePaused', data['encodePaused']);
  push('errorCode', data['errorCode']);
  push('errorMessage', data['errorMessage']);
  push('reason', data['reason']);
  push('sessionState', data['sessionState']);
  return parts.join(' ');
}

/** Minimal hls.js shape we touch — typed locally so the dynamic import
 *  doesn't force a build-time dep on the .d.ts surface. */
interface HlsLikeInstance {
  loadSource(url: string): void;
  attachMedia(v: HTMLMediaElement): void;
  destroy(): void;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
}
interface HlsLike {
  new (config: Record<string, unknown>): HlsLikeInstance;
  isSupported(): boolean;
}

@customElement('media-player')
export class MediaPlayer extends LitElement {
  static override styles = css`
    :host {
      --hm-accent: var(--accent);
      display: block;
      background: var(--bg);
      color: var(--on-scrim);
      width: 100%;
      min-height: calc(100vh - 60px);
    }
    .frame {
      position: relative;
      aspect-ratio: 16 / 9;
      width: 100%;
      max-width: 100vw;
      max-height: calc(100vh - 60px);
      margin: 0 auto;
      background: var(--bg);
      overflow: hidden;
      border-radius: var(--radius-lg);
      cursor: default;
    }
    :host(:fullscreen) .frame,
    .frame:fullscreen {
      border-radius: 0;
      max-width: 100vw;
      max-height: 100vh;
      width: 100%;
      height: 100%;
    }
    .frame.idle, .frame.idle * { cursor: none; }
    /* Fit the video so its 16:9 fills the frame. */
    video.stage-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: var(--bg);
      display: block;
    }

    /* Chrome layer — fades together. */
    .chrome {
      position: absolute;
      transition: opacity 250ms ease-out;
      opacity: 1;
    }
    .frame.idle .chrome {
      opacity: 0;
      pointer-events: none;
    }

    .gradient { left: 0; right: 0; pointer-events: none; }
    .gradient-top {
      top: 0;
      height: 110px;
      background: linear-gradient(to bottom, var(--scrim-strong), rgba(0,0,0,0));
    }
    .gradient-bottom {
      bottom: 0;
      height: 150px;
      background: linear-gradient(to top, var(--scrim-strong), rgba(0,0,0,0));
    }

    .topbar {
      top: 0;
      left: 0;
      right: 0;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .back-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--scrim-faint);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--on-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    .back-btn:hover { background: var(--scrim-soft); }

    /* Report button — sits at the right edge of the topbar. Same chrome as
     *  the back button, but flashes accent on hover and green/red on result. */
    .report-btn { margin-left: 4px; transition: background 200ms ease, color 200ms ease, box-shadow 200ms ease; }
    .report-btn:hover:not(:disabled) {
      background: var(--accent-subtle);
      color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .report-btn.report-sending {
      color: var(--accent);
      animation: report-pulse 1s ease-in-out infinite;
    }
    .report-btn.report-sent {
      background: var(--watched);
      color: var(--on-watched);
      border-color: var(--watched);
    }
    .report-btn.report-failed {
      background: var(--error);
      color: var(--on-error);
      border-color: var(--error);
    }
    @keyframes report-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.45; }
    }
    .title-stack {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .title-stack .show {
      font-size: 11px;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--on-scrim-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .title-stack .episode {
      font-size: 16px;
      color: var(--on-scrim);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      font-size: 10px;
      letter-spacing: 0.5px;
      background: rgba(40, 80, 60, 0.65);
      border: 1px solid rgba(120, 200, 160, 0.35);
      color: #cfc;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      font-family: monospace;
      flex-shrink: 0;
    }

    /* Centered play/pause */
    .center-play {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: var(--scrim-faint);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: var(--on-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      padding: 16px;
    }
    .center-play:hover { background: var(--scrim-soft); }

    /* Bottom controls */
    .bottom-controls {
      bottom: 0;
      left: 0;
      right: 0;
      padding: 0 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .scrubber-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .scrubber-row .time {
      font-size: 12px;
      color: var(--on-scrim-secondary);
      font-variant-numeric: tabular-nums;
      min-width: 50px;
    }
    .scrubber-row .time.right { text-align: right; }
    .scrubber {
      position: relative;
      flex: 1;
      height: 18px;
      display: flex;
      align-items: center;
      cursor: pointer;
    }
    .scrubber .track {
      position: absolute;
      left: 0;
      right: 0;
      height: 4px;
      border-radius: 2px;
      background: var(--scrub-track);
      overflow: hidden;
    }
    .scrubber .track .buffered {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      background: var(--scrub-buffered);
      width: var(--buffered-pct, 0%);
    }
    .scrubber .track .played {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      background: var(--scrub-played);
      width: var(--played-pct, 0%);
      box-shadow: var(--shadow-accent);
    }
    /* 0.1.9 — encoded-runway tick. Marks the absolute source-second up to
     * which ffmpeg has emitted segments. Sits beyond .buffered so the
     * visual hierarchy stays played > buffered > encoded. When the
     * encoder is paced-paused (D4) the tick gets a soft glow. */
    .scrubber .encoded-runway-tick {
      position: absolute;
      top: 50%;
      transform: translate(-1px, -50%);
      width: 2px;
      height: 12px;
      left: var(--encoded-pct, 0%);
      background: gold;
      pointer-events: none;
      opacity: 0.85;
    }
    .scrubber .encoded-runway-tick[data-paused] {
      box-shadow: 0 0 6px 1px rgba(255, 215, 0, 0.55);
    }
    /* 0.1.4.3 — chapter ticks. Rendered absolute inside .scrubber so they
     * sit on top of the track but below the range thumb. */
    .scrubber .chapters {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      height: 8px;
      pointer-events: none;
    }
    .scrubber .chapter-tick {
      position: absolute;
      top: 0;
      width: 2px;
      height: 100%;
      background: rgba(255, 255, 255, 0.5);
      transform: translateX(-1px);
      pointer-events: auto;
      cursor: pointer;
    }
    .scrubber .chapter-tick:hover { background: #fff; }
    /* Chapter hover tooltip — replaces the native title= attribute with a
     * styled popover that matches the rest of the player chrome. Anchored
     * above the hovered tick, two lines: title + start timestamp. */
    .scrubber .chapter-tooltip {
      position: absolute;
      bottom: calc(100% + 10px);
      transform: translateX(-50%);
      background: rgba(20, 20, 20, 0.95);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 6px 10px;
      pointer-events: none;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1.35;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      z-index: 5;
    }
    .scrubber .chapter-tooltip .ts {
      color: rgba(255, 255, 255, 0.6);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
    }
    .scrubber input[type='range'] {
      position: absolute;
      left: 0;
      right: 0;
      width: 100%;
      height: 18px;
      margin: 0;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;
    }
    .scrubber input[type='range']::-webkit-slider-runnable-track {
      height: 18px;
      background: transparent;
    }
    .scrubber input[type='range']::-moz-range-track {
      height: 18px;
      background: transparent;
    }
    .scrubber input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent);
      border: none;
      box-shadow: var(--shadow-accent);
      cursor: pointer;
      margin-top: 3px;
    }
    .scrubber input[type='range']::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent);
      border: none;
      box-shadow: var(--shadow-accent);
      cursor: pointer;
    }

    .controls-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .cluster {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .icon-btn {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 0;
      color: var(--on-scrim);
      cursor: pointer;
      border-radius: var(--radius-md);
      padding: 8px;
      position: relative;
    }
    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .icon-btn:disabled {
      color: rgba(255, 255, 255, 0.3);
      cursor: default;
    }
    .icon-btn:disabled:hover { background: transparent; }
    .icon-btn.active::after {
      content: '';
      position: absolute;
      bottom: 4px;
      left: 50%;
      transform: translateX(-50%);
      width: 14px;
      height: 2px;
      background: var(--accent);
      border-radius: 1px;
      box-shadow: var(--shadow-accent);
    }

    /* Volume — hover-expanding */
    .vol-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      position: relative;
    }
    .vol-slider {
      width: 0;
      overflow: hidden;
      transition: width 200ms ease-out;
      display: flex;
      align-items: center;
    }
    .vol-wrap:hover .vol-slider,
    .vol-wrap.vol-open .vol-slider {
      width: 70px;
    }
    .vol-slider input[type='range'] {
      width: 70px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--scrub-track);
      border-radius: 2px;
      outline: none;
    }
    .vol-slider input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: var(--shadow-accent);
      cursor: pointer;
    }
    .vol-slider input[type='range']::-moz-range-thumb {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: var(--shadow-accent);
      border: 0;
      cursor: pointer;
    }

    /* Right-cluster popover anchor */
    .popover-anchor {
      position: relative;
    }

    /* Popover content lists for CC, audio, settings */
    .menu-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 320px;
      overflow-y: auto;
    }
    .menu-list button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: transparent;
      color: var(--on-scrim-secondary);
      border: 0;
      border-radius: var(--radius-md);
      padding: 8px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      text-align: left;
      width: 100%;
    }
    .menu-list button:hover { background: rgba(255,255,255,0.08); color: var(--on-scrim); }
    .menu-list button.active {
      background: var(--accent-subtle);
      color: var(--on-scrim);
    }
    .menu-list button .check-mark {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      color: var(--accent);
      visibility: hidden;
    }
    .menu-list button.active .check-mark { visibility: visible; }
    .menu-section-title {
      font-size: 10px;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.5);
      padding: 6px 10px 4px;
    }
    .menu-divider {
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 6px 4px;
    }
    /* 0.1.11 — friendly "Technical difficulties" panel for playback errors
     *  (HLS load failure, /open 5xx, heartbeat revive failed). Full-bleed
     *  illustration with a single retry button overlapping the lower-center. */
    .error-panel {
      position: absolute;
      inset: 0;
      background: var(--bg) center / cover no-repeat;
      overflow: hidden;
    }
    .error-panel .error-art {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .error-panel .error-retry {
      position: absolute;
      left: 50%;
      bottom: 8%;
      transform: translateX(-50%);
      background: var(--accent);
      color: var(--bg);
      border: none;
      border-radius: 999px;
      padding: 12px 32px;
      cursor: pointer;
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    }
    .error-panel .error-retry:hover { filter: brightness(1.1); }
    .error-panel .error-retry:focus-visible {
      outline: none;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55), var(--shadow-accent);
    }
    /* 0.2.0 (D9) — low-key "Basic Player" escape hatch under the Retry button. */
    .error-panel .error-basic {
      position: absolute;
      left: 50%;
      bottom: 3%;
      transform: translateX(-50%);
      background: transparent;
      color: var(--on-scrim-secondary);
      border: none;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      text-decoration: underline;
    }
    .error-panel .error-basic:hover { color: var(--on-scrim); }
    /* Top-left back button overlay, matches the in-player .back-btn so the
     *  panel still feels like part of the player surface. */
    .error-panel .error-back {
      position: absolute;
      top: 16px;
      left: 16px;
    }
    .external-panel {
      position: absolute;
      inset: 0;
      padding: 24px;
      background: var(--surface-elevated);
      border-radius: var(--radius-lg);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 10px;
    }
    .external-panel h3 { margin: 0; color: var(--text-primary); }
    .external-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .external-panel input {
      width: 100%;
      padding: 6px;
      background: var(--bg);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
      font-family: monospace;
      font-size: 12px;
    }
    .loading-panel {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
    }

    /* Buffering spinner — rendered as an overlay above the video element
     * while hls.js is fetching segments and the video element fired the
     * "waiting" event without a paired "playing" yet. pointer-events: none
     * so the click region under it (toggle play/pause) keeps working. */
    .buffer-spinner {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 4;
    }
    .buffer-spinner .ring {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.18);
      border-top-color: rgba(255, 255, 255, 0.85);
      animation: hm-spin 0.85s linear infinite;
    }
    @keyframes hm-spin {
      to { transform: rotate(360deg); }
    }

    /* Native-controls escape-hatch keeps the layout sane in tests/debug. */
    .native-stage video { object-fit: contain; }
  `;

  @property({ type: String }) relPath!: string;
  /** Absolute current time in source seconds. For direct streams equals
   *  `video.currentTime`; for remux/nvenc equals `streamOffset + video.currentTime`. */
  @state() private currentTime = 0;
  @state() private duration = 0;
  @state() private paused = true;
  @state() private muted = volumePrefs.muted;
  @state() private volume = volumePrefs.volume;
  @state() private bufferedPct = 0;
  /** Chapter currently under the cursor (mouseenter/leave on a tick).
   *  Drives the rich chapter-tooltip overlay; null hides it. (Phase 4) */
  @state() private hoveredChapter: Chapter | null = null;
  /** True while the <video> element is waiting on data (hls.js fetching the
   *  next segment, scrub into an unbuffered region, etc.). Drives the
   *  spinner overlay. Set on `waiting`, cleared on `playing` / `canplay` /
   *  `seeked`. Debounced by ~200ms in the render to avoid flicker on brief
   *  network blips. */
  @state() private buffering = false;
  /** Wallclock millis when `buffering` was last flipped to true. The render
   *  hides the spinner until 200ms have elapsed so a 50ms stall doesn't
   *  flash a spinner. */
  @state() private bufferingSince = 0;
  /** Last `currentTime` seen in `timeupdate`. Used to detect a still-advancing
   *  play head so the spinner can be cleared even when Safari skips the
   *  `playing`/`canplay` event (old iPad native HLS). Not reactive. */
  private lastTimeUpdateCT = -1;
  @state() private error: string | null = null;
  @state() private nativeControls = false;
  @state() private probe: StreamProbe | null = null;
  @state() private probing = false;
  /** Ring buffer of the last 5 playback failures (newest first). Populated by
   *  `handlePlaybackFailure`; surfaced in the diagnostic overlay. */
  @state() private failureLog: Array<{
    at: number;
    reason: string;
    playMode: string;
    videoErrorCode?: number;
    videoErrorMessage?: string;
  }> = [];
  /** 0.1.7 — narrative trace buffer. Every meaningful state transition,
   *  video event, hls.js event, and player lifecycle action lands here in
   *  order so a post-failure report has full context. ~200 entries deep,
   *  oldest dropped. Drained into the report payload as `traceLog`. */
  private traceLog: Array<{ at: number; tag: string; data?: Record<string, unknown> }> = [];
  /** Report button state. Drives the icon flash so the user knows the POST
   *  landed (or didn't) without an intrusive toast. */
  @state() private reportStatus: 'idle' | 'sending' | 'sent' | 'failed' = 'idle';
  private reportSending = false;
  /** Tracks the relPath we've already auto-reported for so falling into the
   *  external-player panel only fires one report per file. Resets when the
   *  file changes. */
  private autoReportedExternalFor: string | null = null;
  /** Where the currently-piped ffmpeg stream started in the source. 0 when the
   *  stream is from the beginning. Updated when the user scrubs out-of-buffer. */
  @state() private streamOffset = 0;
  /** Briefly true after a scrub-restart so the UI can show "Seeking..." while
   *  the new ffmpeg pipe spins up. */
  @state() private seeking = false;
  /** Absolute target time the user is trying to reach. While set, the scrubber
   *  is bound to this value (not `currentTime`) so it doesn't visually revert
   *  while we're spawning a new ffmpeg pipe. Cleared on `loadedmetadata` of the
   *  new stream. If the new pipe fails, the fallback chain inherits this and
   *  applies it on the next successful load. */
  @state() private pendingSeek: number | null = null;
  @state() private subs: SubInfo[] = [];
  @state() private activeSubIndex = 0; // -1 = off; 0..subs.length-1 = chosen track
  /** 0.1.4.3 — selected audio track (local audio index). null = use default. */
  @state() private activeAudioIndex: number | null = null;
  /** 0.1.4.3 — selected embedded text-based sub stream's GLOBAL ffprobe index.
   *  When set, an extra `<track>` is rendered using `embeddedSubsUrl`. null
   *  means no embedded text track is active. */
  @state() private activeEmbeddedSubGlobalIndex: number | null = null;
  /** 0.1.4.3 — selected burn-in sub stream's local index. When set, the
   *  pipeline is respawned with `?burnSub=N`. */
  @state() private activeBurnSubIndex: number | null = null;
  /** Single source of truth for which popover is open. */
  @state() private openPopover: PopoverKey = null;
  /** Compat alias for the old subs-menu state — tests/imports may still read it.
   *  True when the CC popover is open. */
  private get subsMenuOpen(): boolean { return this.openPopover === 'cc'; }
  private set subsMenuOpen(v: boolean) {
    if (v) this.openPopover = 'cc';
    else if (this.openPopover === 'cc') this.openPopover = null;
  }
  /** True once we have a pointer/keyboard interaction; used to flip into idle. */
  @state() private chromeIdle = false;
  @state() private playbackRate = 1;
  @state() private isFullscreen = false;
  /** Movie metadata for the topbar title. Populated from `getCachedMovie` when
   *  available; otherwise lazily fetched via /api/library on first render. Null
   *  for series episodes (the series cache covers them) or when the path is
   *  not in the library yet. */
  @state() private movieMeta: LibraryItem | null = null;
  /** Path we already attempted a library lookup for, so we don't refetch on
   *  every render when the file genuinely isn't in the library. */
  private libraryFetchedFor: string | null = null;
  /** Source mode. Always `'hls'` for the active session; flips to
   *  `'external'` when a hard <video> error means the browser can't
   *  play the stream and the user is offered the external-player handoff. */
  @state() private playMode: 'external' | 'hls' = 'hls';
  /** 0.1.9 — server-driven player session controller. Owns hls.js
   *  lifecycle, /state polling, and seek/track round-trips. Non-null
   *  between the post-/open render and the next disconnect. */
  private playerSessionCtl: PlayerSession | null = null;
  /** 0.1.9 — bundle returned by /api/player/:id/open. The chrome reads
   *  duration / tracks / chapters / IMDb / sibling subs from this. Null
   *  until the bundle lands. */
  @state() private playerBundle: PlayerOpenResponse | null = null;
  /** 0.1.9 — the encoded window the server most recently reported, in
   *  absolute source-seconds. The buffered-runway tick in the scrubber
   *  renders at `encodedWindow.to - encodedWindow.from` (relative to the
   *  active stream-local origin). */
  @state() private serverEncodedWindow: { from: number; to: number } = { from: 0, to: 0 };
  /** 0.1.9 — true while ffmpeg is paced-paused on the server side. Surfaced
   *  as a glow on the runway tick. */
  @state() private serverEncodePaused = false;
  /** 0.1.9 — body of the most recent 503 capacity_exceeded response. When
   *  non-null, the player renders the "Encoder busy" panel instead of the
   *  video. */
  @state() private capacityError: CapacityExceeded | null = null;
  /** True while the <video> is in browser PiP. Drives the player-bar button's
   *  active state and lets us reflect external PiP exits in the UI. */
  @state() private pipActive = false;
  /** True between an episode auto-advance/change and the next `loadedmetadata`
   *  if PiP was active when the change started. The PiP window is bound to the
   *  old MediaSource and the browser drops out of PiP when hls.js re-attaches;
   *  this flag tells the new-stream handler to re-enter PiP once metadata for
   *  the next episode is ready. */
  private resumePipOnNextLoad = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferedRaf: number | null = null;
  private bufferedLastTick = 0;

  private clickTimer: ReturnType<typeof setTimeout> | null = null;

  private persister: PlaybackPersister | null = null;
  private watchedFired = false;
  private resumePosition = 0;
  private resumed = false;
  /** Set in `onEnded` when we navigate to the next episode. Tells the next
   *  /open call to pass `startSeconds: 0` so a stale playback row doesn't
   *  spawn ffmpeg into the middle of the new episode. Cleared after consumption. */
  private skipResumeOnNextOpen = false;

  private get videoEl(): HTMLVideoElement | null {
    return this.renderRoot.querySelector('video');
  }
  private get gridEl(): HTMLElement | null {
    return this.renderRoot.querySelector('episode-grid');
  }
  private get pipSupported(): boolean {
    const d = document as Document & { pictureInPictureEnabled?: boolean };
    return d.pictureInPictureEnabled === true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.nativeControls = new URLSearchParams(window.location.search).get(
      'nativeControls',
    ) === '1';
    this.persister = new PlaybackPersister(this.relPath);
    this.trace('connectedCallback', { relPath: this.relPath });
    void this.fetchResume();
    this.playMode = 'hls';
    this.runPlayerSessionBootstrap();
    void this.resolveTitleSource();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('click', this.onDocClick);
    // 0.1.11 — retry bootstrap after the server returns. The connection store
    // fires `library-invalidated` on unreachable→reachable transitions, which
    // is exactly when this should re-attempt.
    document.addEventListener('library-invalidated', this.libraryInvalidatedListener);
    // Start the idle timer once we're attached so chrome auto-hides even if no
    // mouse moves happen.
    this.kickIdleTimer();
  }

  /** 0.1.11 — recovery handler. Fired by the connection-store on
   *  `unreachable → reachable`. Covers three cases:
   *  1. Bootstrap never ran because we were unreachable on mount → the guard
   *     in runPlayerSessionBootstrap returned early; clear `probedFor` and
   *     run it now.
   *  2. Bootstrap succeeded earlier but the server restarted mid-playback,
   *     the heartbeat revive failed, and we landed in error state. The
   *     stale playerId is dead; mint a fresh one via retryPlayback().
   *  3. Bootstrap is in progress / finished and the player is healthy. No-op. */
  private libraryInvalidatedListener = (): void => {
    if (this.error != null) {
      this.retryPlayback();
      return;
    }
    if (this.playerBundle == null && this.probedFor === this.relPath) {
      // Bootstrap was skipped by the unreachable guard; re-arm it.
      this.probedFor = null;
      void this.runPlayerSessionBootstrap();
    }
  };

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Final synchronous flush before tearing down (e.g. user navigates away).
    const v = this.videoEl;
    if (v && this.persister && this.duration > 0) {
      this.persister.flushNow(this.absoluteTime(v), this.duration);
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('click', this.onDocClick);
    document.removeEventListener('library-invalidated', this.libraryInvalidatedListener);
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.bufferedRaf !== null) {
      cancelAnimationFrame(this.bufferedRaf);
      this.bufferedRaf = null;
    }
    this.clearStallTimer();
    this.clearSilentDecodeTimer();
    // 0.1.9 — best-effort beacon so the server's idle GC doesn't have to
    // wait the full window after a tab close. PlayerSession.close() also
    // tears down hls.js.
    if (this.playerSessionCtl) {
      void this.playerSessionCtl.close(true).catch(() => undefined);
      this.playerSessionCtl = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('relPath')) {
      const previous = changed.get('relPath') as string | undefined;
      // Only reset when it's a real path change. Lit fires `updated()` once on
      // the initial mount with `previous === undefined`, and `connectedCallback`
      // has already kicked off `runPreProbe()` and `fetchResume()` for the
      // current path — wiping their results here would put the player into a
      // permanent loading state because `probedFor` is already set.
      if (previous !== undefined && previous !== this.relPath) {
        this.trace('updated.relPathChange', { previous, next: this.relPath });
        // If PiP was active when the episode changed, the browser drops out
        // of PiP as soon as hls.js re-attaches a new MediaSource to the
        // <video>. Latch the intent here so `onLoadedMetadata` can re-enter
        // PiP for the new stream. (Capture from the doc rather than our
        // `pipActive` flag — the leave event may already have flipped it.)
        const docPip = document as Document & {
          pictureInPictureElement?: Element | null;
        };
        if (this.pipActive || docPip.pictureInPictureElement === this.videoEl) {
          this.resumePipOnNextLoad = true;
        }
        this.watchedFired = false;
        this.resumePosition = 0;
        this.resumed = false;
        this.error = null;
        this.probe = null;
        this.subs = [];
        this.activeSubIndex = 0;
        this.activeAudioIndex = null;
        this.activeEmbeddedSubGlobalIndex = null;
        this.activeBurnSubIndex = null;
        this.openPopover = null;
        this.playMode = 'hls';
        this.seeking = false;
        this.probedFor = null;
        this.bufferedPct = 0;
        this.clearStallTimer();
        this.clearSilentDecodeTimer();
        this.persister = new PlaybackPersister(this.relPath);
        this.movieMeta = null;
        this.libraryFetchedFor = null;
        this.failureLog = [];
        this.autoReportedExternalFor = null;
        // 0.1.9.2 — episode change: AWAIT the close before starting the
        // new /open. With sendBeacon (or even an unawaited fetch), the
        // delete can land AFTER the new /open, wiping the freshly
        // spawned session and triggering an unrecoverable 410/404
        // heartbeat cycle.
        const oldCtl = this.playerSessionCtl;
        this.playerSessionCtl = null;
        this.playerBundle = null;
        this.serverEncodedWindow = { from: 0, to: 0 };
        void (async () => {
          if (oldCtl) {
            try {
              await oldCtl.close(false);
            } catch {
              /* server may already be gone — fall through to /open */
            }
          }
          void this.fetchResume();
          this.runPlayerSessionBootstrap();
        })();
        void this.resolveTitleSource();
      }
    }
    if (changed.has('subs')) {
      // After the <track> elements (re-)render, push the active selection through.
      this.applyActiveSubtitle();
    }
    if (changed.has('playMode') && this.playMode === 'external') {
      // Auto-fire a diagnostic report the first time we land on the external-
      // player panel for a given file. Saves the user clicking Report on
      // every unsupported codec — the server log is the place we care about
      // these landing in. Guard ensures it doesn't double-fire on re-renders.
      if (this.autoReportedExternalFor !== this.relPath) {
        this.autoReportedExternalFor = this.relPath;
        void this.sendReport('player-external-fallback');
      }
    }
    if (changed.has('openPopover')) {
      const wasNonNull = (changed.get('openPopover') as PopoverKey) !== null;
      const isNonNull = this.openPopover !== null;
      if (wasNonNull && !isNonNull) {
        // Just closed — re-arm idle timer.
        this.kickIdleTimer();
      }
      // If we just opened the grid, scroll it to the current ep before the
      // genie animation runs (next frame, after render).
      if (this.openPopover === 'grid') {
        requestAnimationFrame(() => {
          const grid = this.gridEl as { scrollToCurrent?: (o: { instant: boolean }) => void } | null;
          grid?.scrollToCurrent?.({ instant: true });
        });
      }
    }
    if (changed.has('paused')) {
      // Resuming play after a manual pause should re-arm the idle timer.
      this.kickIdleTimer();
    }
    if (changed.has('playbackRate')) {
      const v = this.videoEl;
      if (v) v.playbackRate = this.playbackRate;
    }
  }

  // ---------- idle state machine ----------

  private kickIdleTimer = (): void => {
    this.chromeIdle = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.paused) return;
    if (this.openPopover !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.chromeIdle = true;
    }, IDLE_TIMEOUT_MS);
  };

  // ---------- legacy stall + silent-decode watchdogs (HLS Phase 4 cleanup) ----------
  // hls.js owns recovery for transient errors under the HLS-only architecture;
  // these are kept as no-ops so existing call sites compile without disrupting
  // unrelated wiring. Will be removed in a follow-up sweep.
  private kickStallTimer(): void { /* no-op */ }
  private clearStallTimer(): void { /* no-op */ }
  private armSilentDecodeWatchdog(): void { /* no-op */ }
  private clearSilentDecodeTimer(): void { /* no-op */ }

  private probedFor: string | null = null;

  /** Locate the file's metadata. Series cache wins (it knows episode siblings);
   *  movie cache covers movies. If neither has it, hit /api/library and, when
   *  that turns out to be an episode, fetch the series detail too so prev/next
   *  buttons and the episode grid have data to render against. */
  private async resolveTitleSource(): Promise<void> {
    if (getCachedSeriesContaining(this.relPath)) return; // already have full detail
    const movie = getCachedMovie(this.relPath);
    if (movie) {
      this.movieMeta = movie;
      return;
    }
    // Maybe library is already cached but the series detail hasn't been fetched.
    const known = findCachedSeriesItemByEpisodePath(this.relPath);
    if (known) {
      await this.fetchSeriesDetail(known.id);
      return;
    }
    if (this.libraryFetchedFor === this.relPath) return;
    this.libraryFetchedFor = this.relPath;
    try {
      const lib = await apiLibrary({ includeStale: true });
      cacheLibrary(lib);
      const m = getCachedMovie(this.relPath);
      if (m) {
        this.movieMeta = m;
        return;
      }
      const seriesItem = findCachedSeriesItemByEpisodePath(this.relPath);
      if (seriesItem) await this.fetchSeriesDetail(seriesItem.id);
    } catch {
      /* falls back to the cleaned filename + no series controls */
    }
  }

  private async fetchSeriesDetail(id: number): Promise<void> {
    try {
      const detail = await apiSeries(id);
      cacheSeriesDetail(detail);
      // siblings reads from the module cache — bump Lit so the topbar +
      // prev/next/grid recompute now that data is available.
      this.requestUpdate();
    } catch {
      /* ignore — controls stay hidden */
    }
  }

  /** Pick the initial play mode from a probe. Honors the server's
   *  `preferAccel` hint: when the source video codec has no chance of
   *  decoding in any browser (Xvid, MPEG-2, VC-1, etc.) the server tells
   *  us to start in NVENC mode and skip the wasted remux attempt. */
  /** 0.1.9 — server-driven bootstrap. Mints a playerId, calls /open, and
   *  hands the returned bundle to the chrome rendering paths. The legacy
   *  multi-fetch dance (`apiStreamMeta` + `apiPlaybackGet` + library
   *  lookup) is collapsed into one round trip; the bundle's metadata
   *  populates `probe`, `subs`, and the popovers identically to D3.
   *
   *  Sequencing: call /open first (no <video> needed), apply the bundle to
   *  populate `probe`, which lets the next render produce a <video>
   *  element, then attach hls.js to it. */
  private async runPlayerSessionBootstrap(): Promise<void> {
    if (this.probedFor === this.relPath) return;
    // 0.1.11 — skip the open call while server is unreachable. The
    // `library-invalidated` listener will re-call us once the server is back.
    // We leave `probedFor` null so this method doesn't permanently guard out.
    if (getConnectionState()?.kind === 'unreachable') return;
    this.probedFor = this.relPath;
    this.probing = true;

    const playerId = this.playerSessionCtl?.playerId ?? mintPlayerId();
    const skipResume = this.skipResumeOnNextOpen;
    this.skipResumeOnNextOpen = false;
    let bundle: PlayerOpenResponse;
    try {
      const openInput: PlayerOpenInput = { relPath: this.relPath };
      if (skipResume) openInput.startSeconds = 0;
      bundle = await apiPlayerOpen(playerId, openInput);
    } catch (err) {
      if (err instanceof PlayerCapacityError) {
        this.capacityError = err.body;
        this.probing = false;
        return;
      }
      this.error = `Stream unavailable: ${(err as Error).message}`;
      this.probing = false;
      return;
    }

    this.playerBundle = bundle;
    this.applyBundleToProbe(bundle);
    this.probing = false;
    // Wait one render so the <video> element exists, then attach.
    await this.updateComplete;
    const v = this.videoEl;
    if (!v) {
      this.error = 'Failed to mount video element';
      return;
    }
    this.playerSessionCtl = new PlayerSession({
      videoEl: v,
      playerId,
      events: {
        onState: (s) => {
          this.seeking = s === 'seeking' || s === 'attaching';
          this.buffering = this.seeking;
        },
        onBundle: (b) => {
          this.playerBundle = b;
          this.applyBundleToProbe(b);
        },
        onEncodedWindow: (w, paused) => {
          this.serverEncodedWindow = w;
          this.serverEncodePaused = paused;
          this.streamOffset = w.from;
        },
        onCapacity: (body) => {
          this.capacityError = body;
        },
        onError: (msg) => {
          this.error = msg;
        },
      },
    });
    // Adopt the bundle the manager already pre-fetched and attach hls.js
    // to the playlist URL the server returned.
    await this.playerSessionCtl.adopt(bundle);
  }

  /** 0.1.9 — flatten a /open bundle into the `probe` shape the existing
   *  popover / scrubber code already reads. */
  private applyBundleToProbe(b: PlayerOpenResponse): void {
    const m = b.metadata;
    const probeShape: StreamProbe = {
      decision: 'remux',
      subs: m.siblingSubs,
      durationSeconds: m.durationSeconds,
      container: m.container,
      videoCodec: m.videoCodec,
      audioCodec: m.audioCodec,
      audioStreams: m.audioStreams,
      subStreams: m.subStreams,
      chapters: m.chapters,
    };
    this.probe = probeShape;
    this.subs = m.siblingSubs;
    this.applyStickyPrefs(probeShape);
    if (m.activeAudioStreamIndex !== null) this.activeAudioIndex = m.activeAudioStreamIndex;
    if (m.activeBurnSubStreamIndex !== null) this.activeBurnSubIndex = m.activeBurnSubStreamIndex;
    if (b.resume.position > 0) {
      this.resumePosition = b.resume.position;
    }
    // The server is authoritative on streamOffset under the new path.
    this.streamOffset = b.session.encodedWindow.from;
    this.serverEncodedWindow = b.session.encodedWindow;
  }


  /** Restore the per-file sticky audio + subtitle selection from sessionStorage,
   *  clamping invalid values (e.g. a remembered audio index for a re-encoded
   *  file that no longer has that track). (0.1.4.3) */
  private applyStickyPrefs(probe: StreamProbe): void {
    const audios = probe.audioStreams ?? [];
    if (audios.length > 0) {
      const remembered = readAudioPref(this.relPath);
      if (remembered !== null && audios.some((a) => a.audioIndex === remembered)) {
        this.activeAudioIndex = remembered;
      } else {
        this.activeAudioIndex = null;
      }
    }
    const subPref = readSubPref(this.relPath);
    if (subPref) {
      if (subPref === 'off') {
        this.activeSubIndex = -1;
      } else if (subPref.startsWith('sibling:')) {
        const i = Number(subPref.slice('sibling:'.length));
        if (Number.isInteger(i) && i >= 0 && i < this.subs.length) {
          this.activeSubIndex = i;
        }
      } else if (subPref.startsWith('embedded:')) {
        const i = Number(subPref.slice('embedded:'.length));
        const subs = probe.subStreams ?? [];
        const match = subs.find((s) => s.index === i && s.textBased);
        if (match) {
          this.activeEmbeddedSubGlobalIndex = i;
        }
      } else if (subPref.startsWith('burn:')) {
        // 0.1.7 — burn-in only supports text-based subs in our HLS pipeline
        // (ffmpeg's `subtitles=` filter doesn't handle image subs like
        // dvd_subtitle/PGS). The original 0.1.4.3 design saved `burn:N`
        // for image-based subs because those couldn't be rendered as a
        // <track>. With HLS that combo just makes the file unplayable.
        // Restore burn-in only when the target is text-based; for image
        // subs we drop the pref entirely so the file plays without subs
        // rather than dead-locking the player. The server has its own
        // 415 pre-flight as a backstop.
        const i = Number(subPref.slice('burn:'.length));
        const subs = probe.subStreams ?? [];
        const match = subs.find((s) => s.subIndex === i);
        if (match && match.textBased) {
          this.activeBurnSubIndex = i;
        } else if (match && !match.textBased) {
          // Image-based: drop the pref so it doesn't re-fire next mount.
          try { sessionStorage.removeItem('homemedia.subPref.v1:' + this.relPath); } catch { /* ignore */ }
        }
      }
    }
  }

  private async fetchResume(): Promise<void> {
    this.trace('fetchResume.start');
    try {
      const pb = await apiPlaybackGet(this.relPath);
      this.trace('fetchResume.fetched', { position: pb.position, duration: pb.duration, watched: pb.watched });
      this.resumePosition = pb.position;
      this.applyResumeOffset();
      // The /open bundle's resume.position is the authoritative resume
      // signal under HLS; the playlist starts at streamOffset, so we never
      // touch <video>.currentTime directly here.
    } catch (err) {
      this.trace('fetchResume.error', { err: String((err as Error)?.message ?? err) });
      if (err instanceof ShareOfflineError) {
        // Continue without resume; the stream itself will surface the offline error.
      }
    }
  }

  /** True duration we trust for the scrubber. The server sets ffmpeg's
   *  start at streamOffset, so <video>.duration would be
   *  (totalDuration - streamOffset) and scrub-to-end would prematurely
   *  end. Trust the bundle's duration whenever it's known. */
  private resolveDuration(videoDuration: number): number {
    const probed = this.probe?.durationSeconds;
    const fromServer = typeof probed === 'number' && probed > 0 ? probed : 0;
    if (fromServer > 0) return fromServer;
    if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;
    return fromServer;
  }

  private onLoadedMetadata = (): void => {
    const v = this.videoEl;
    if (!v) {
      this.trace('onLoadedMetadata.noVideoEl');
      return;
    }
    this.trace('onLoadedMetadata.start', this.playerSnapshot());
    // Metadata is here — the stream is real. Cancel the stall watchdog.
    this.clearStallTimer();
    this.seeking = false;
    this.duration = this.resolveDuration(v.duration);
    if (!this.resumed && this.resumePosition > 0 && this.resumePosition < this.duration) {
      this.trace('onLoadedMetadata.applyResumeSeek', {
        position: this.resumePosition, duration: this.duration, playMode: this.playMode,
      });
      v.currentTime = this.resumePosition;
      this.resumed = true;
    }
    if (this.pendingSeek !== null) {
      this.trace('onLoadedMetadata.consumedPendingSeek', { pendingSeek: this.pendingSeek });
      this.currentTime = this.streamOffset;
      this.pendingSeek = null;
    }
    if (this.playbackRate !== 1) v.playbackRate = this.playbackRate;
    this.applyVolumePrefs();
    this.applyActiveSubtitle();
    this.armSilentDecodeWatchdog();
    if (this.resumePipOnNextLoad) {
      this.resumePipOnNextLoad = false;
      const vp = v as HTMLVideoElement & {
        requestPictureInPicture?: () => Promise<unknown>;
      };
      if (vp.requestPictureInPicture && document.pictureInPictureElement !== v) {
        vp.requestPictureInPicture().catch(() => {});
      }
    }
    this.trace('onLoadedMetadata.done', this.playerSnapshot());
  };

  /** Push the sticky volume/mute preferences onto the current <video> element.
   *  Called after every loadedmetadata so a freshly mounted episode picks up
   *  whatever the user had set on the previous one. */
  private applyVolumePrefs(): void {
    const v = this.videoEl;
    if (!v) return;
    v.volume = this.volume;
    v.muted = this.muted;
  }

  private onDurationChange = (): void => {
    const v = this.videoEl;
    if (!v) return;
    this.duration = this.resolveDuration(v.duration);
  };

  /** Absolute source-relative time. */
  private absoluteTime(v: HTMLVideoElement): number {
    return this.streamOffset + v.currentTime;
  }

  /** Seed `streamOffset` so ffmpeg starts from the saved time. Skips the
   *  resume entirely when the saved position is at/past 95% of the duration —
   *  that's the "already watched" boundary; resuming there means the stream
   *  starts seconds from EOF, plays a fragment, and `<video>` correctly fires
   *  `ended`, which we'd then mistake for "user wants to auto-advance." */
  private applyResumeOffset(): void {
    if (this.resumed) return;
    if (this.streamOffset > 0) return; // already applied
    if (this.resumePosition <= 0) return;
    if (this.playMode !== 'hls') return;

    // Skip resume if the position is past the 95% watched threshold the
    // server uses to auto-mark watched. Don't resume, just start from 0.
    const probed = this.probe?.durationSeconds ?? 0;
    if (probed > 0 && this.resumePosition >= probed * 0.95) {
      this.resumed = true; // mark consumed so we don't re-apply later
      return;
    }

    this.streamOffset = this.resumePosition;
    this.currentTime = this.resumePosition;
    this.resumed = true;
  }

  /** Build the `<video src>` URL — the server-driven path keeps this
   *  authoritative on the bundle. */
  private buildStreamSrc(): string {
    return this.playerBundle?.session.playlistUrl ?? '';
  }

  private onTimeUpdate = (): void => {
    const v = this.videoEl;
    if (!v || !this.persister) return;
    const absolute = this.absoluteTime(v);
    // 0.2.0 — spinner safety net for native-HLS Safari (old iPads especially).
    // Old WebKit fires `waiting` but often never the paired `playing`/`canplay`,
    // so the buffering flag — and the spinner — would stick on forever during
    // smooth playback. A monotonically advancing currentTime (while not paused
    // or mid-seek) is proof we're playing, regardless of which events fired; use
    // it to clear the spinner that the event handlers missed.
    if (
      this.buffering &&
      !this.seeking &&
      this.pendingSeek === null &&
      !v.paused &&
      v.currentTime !== this.lastTimeUpdateCT
    ) {
      this.buffering = false;
      this.bufferingSince = 0;
    }
    this.lastTimeUpdateCT = v.currentTime;
    if (this.pendingSeek === null) {
      this.currentTime = absolute;
    }
    if (this.duration > 0 && !this.watchedFired) {
      if (absolute / this.duration >= WATCHED_RATIO) {
        this.watchedFired = true;
        this.persister.fireWatched(absolute, this.duration);
      }
    }
    this.persister.maybeWrite(absolute, this.duration);
  };

  private onProgress = (): void => {
    // Throttle the buffered-range update to ~30fps via rAF + timestamp gate.
    if (this.bufferedRaf !== null) return;
    this.bufferedRaf = requestAnimationFrame(() => {
      this.bufferedRaf = null;
      const now = performance.now();
      if (now - this.bufferedLastTick < 33) return;
      this.bufferedLastTick = now;
      const v = this.videoEl;
      if (!v || this.duration <= 0) return;
      const ranges = v.buffered;
      let endLocal = 0;
      for (let i = 0; i < ranges.length; i++) {
        const e = ranges.end(i);
        if (e > endLocal) endLocal = e;
      }
      const endAbs = this.streamOffset + endLocal;
      this.bufferedPct = Math.min(100, (endAbs / this.duration) * 100);
    });
  };

  /** 0.1.7 — push a tagged entry into the in-memory traceLog ring + the
   *  global console buffer. Tag is short ("video.play", "hls.attach",
   *  "scheduleHlsAttach", etc). data is any extra structured payload. */
  private trace(tag: string, data?: Record<string, unknown>): void {
    const entry: { at: number; tag: string; data?: Record<string, unknown> } = { at: Date.now(), tag };
    if (data !== undefined) entry.data = data;
    this.traceLog.push(entry);
    if (this.traceLog.length > 200) this.traceLog.shift();
    // Surface in the regular console (caught by console-buffer.ts).
    // The summary keeps the collapsed devtools row useful without
    // requiring a click to expand the object.
    // eslint-disable-next-line no-console
    if (data === undefined) {
      console.info(`[player] ${tag}`);
    } else {
      console.info(`[player] ${tag} ${traceSummary(data)}`, data);
    }
  }

  /** Snapshot of state useful for context lines next to a video event. */
  private playerSnapshot(): Record<string, unknown> {
    const v = this.videoEl;
    const ctl = this.playerSessionCtl;
    const bundle = this.playerBundle;
    return {
      playMode: this.playMode,
      streamOffset: this.streamOffset,
      currentTime: this.currentTime,
      paused: this.paused,
      seeking: this.seeking,
      resumed: this.resumed,
      resumePosition: this.resumePosition,
      playerId: ctl?.playerId ?? null,
      sessionId: bundle?.session.sessionId ?? null,
      sessionState: ctl?.getState() ?? 'idle',
      encodedWindow: this.serverEncodedWindow,
      encodePaused: this.serverEncodePaused,
      probedFor: this.probedFor,
      relPath: this.relPath,
      videoCT: v?.currentTime,
      videoDur: v && Number.isFinite(v.duration) ? v.duration : null,
      videoReady: v?.readyState,
      videoNet: v?.networkState,
      videoPaused: v?.paused,
      videoBuffered: v ? this.bufferedSummary(v) : null,
    };
  }

  /** Compact buffered range list: "[0,7.5][12,18.3]". */
  private bufferedSummary(v: HTMLVideoElement): string {
    try {
      const ranges = v.buffered;
      const parts: string[] = [];
      for (let i = 0; i < ranges.length; i++) {
        parts.push(`[${ranges.start(i).toFixed(2)},${ranges.end(i).toFixed(2)}]`);
      }
      return parts.join('') || '(empty)';
    } catch { return '(unavailable)'; }
  }

  /** Generic trace handler bound to <video>'s less-interesting events. */
  private onTraceEvent = (e: Event): void => {
    this.trace(`video.${e.type}`, this.playerSnapshot());
  };

  /** Buffering spinner control. The <video> element fires `waiting` when
   *  it dropped below HAVE_FUTURE_DATA — typical causes: hls.js still
   *  fetching the next segment, scrub into unbuffered region, network
   *  blip. We flip the buffering flag (debounced in the render to ~200ms
   *  so brief stalls don't flicker the spinner). */
  private onBufferingStart = (e: Event): void => {
    if (!this.buffering) {
      this.buffering = true;
      this.bufferingSince = Date.now();
    }
    this.trace(`video.${e.type}`, this.playerSnapshot());
  };

  /** Spinner clear. `playing` fires when playback (re)starts after a stall;
   *  `canplay`/`canplaythrough` cover post-seek and initial-load resumes.
   *  `seeked` covers the case where a seek lands in already-buffered data
   *  and produces no `waiting` either side. */
  private onBufferingEnd = (e: Event): void => {
    if (this.buffering) {
      this.buffering = false;
      this.bufferingSince = 0;
    }
    this.trace(`video.${e.type}`, this.playerSnapshot());
  };

  private onPlay = (): void => {
    this.paused = false;
    this.trace('video.play', this.playerSnapshot());
    // Switch /state polling to the playing cadence (5s).
    this.playerSessionCtl?.setPaused(false);
  };
  private onPause = (): void => {
    this.paused = true;
    this.trace('video.pause', this.playerSnapshot());
    const v = this.videoEl;
    if (v && this.persister && this.duration > 0) {
      this.persister.flushNow(this.absoluteTime(v), this.duration);
    }
    // Slow /state polling to the paused cadence (30s); the encoder
    // pace controller flips into the conservative mode in response.
    this.playerSessionCtl?.setPaused(true);
  };

  private onEnded = (): void => {
    const v = this.videoEl;
    // eslint-disable-next-line no-console
    console.warn('[media-player] <video> ended', {
      relPath: this.relPath,
      playMode: this.playMode,
      videoCurrentTime: v?.currentTime,
      videoDuration: v?.duration,
      streamOffset: this.streamOffset,
      probedDuration: this.duration,
      readyState: v?.readyState,
    });
    if (v && this.persister && this.duration > 0) {
      this.persister.flushNow(this.absoluteTime(v), this.duration);
    }

    // Premature `ended` events are common on remux/nvenc streams: the
    // <video> element doesn't know the true total duration of a fragmented
    // MP4 pipe and will fire `ended` whenever its internal duration estimate
    // matches `currentTime`, which can happen mid-stream for various reasons
    // (network stall flagged as EOF, progressive duration discovery, etc.).
    //
    // Only auto-advance when the user is genuinely near the source's end —
    // within ~10 seconds of the probed total. For direct streams the browser
    // gets this right by definition (Content-Length matches), so the guard
    // is only necessary on remux/nvenc but it's safe everywhere.
    const absoluteNow = v ? this.absoluteTime(v) : this.currentTime;
    const totalKnown = this.duration > 0;
    const nearEnd = totalKnown && absoluteNow >= this.duration - 10;
    // Spurious `ended` events fire on remux/nvenc streams whose fragmented MP4
    // tells the browser duration === currentTime even though only a couple of
    // seconds of bytes have arrived. Detect by checking whether the spawned
    // stream itself produced enough output: `v.currentTime` is local to the
    // current ffmpeg pipe (resets to 0 on each scrub-restart), so a tiny value
    // here is the giveaway that the stream EOFed prematurely. Auto-advance
    // requires both "near absolute end" AND "this pipe actually played 5+ seconds".
    const localPlayed = v?.currentTime ?? 0;
    const looksGenuine = localPlayed >= 5;
    if (!nearEnd || !looksGenuine) {
      // Spurious end event — usually a remux/nvenc fragmented MP4 confused
      // the <video> element about its duration. Try to nudge playback back
      // alive: if more bytes are buffered ahead, kick `play()`. The browser
      // will pick up where it left off. If that fails (e.g. buffer is
      // genuinely empty and we need ffmpeg to send more), fall back to a
      // scrub-restart from the current absolute time, which respawns ffmpeg.
      if (v) {
        v.play().catch(() => {
          // play() rejected — usually a fragmented-MP4 EOF. Re-seek via
          // the controller; the server respawns ffmpeg from absoluteNow.
          if (this.playerSessionCtl) {
            this.seeking = true;
            void this.playerSessionCtl.seek(absoluteNow);
          }
        });
      }
      return;
    }

    const series = getCachedSeriesContaining(this.relPath);
    if (!series) return;
    const idx = series.episodes.findIndex((e) => e.path === this.relPath);
    if (idx < 0) return;
    const next = series.episodes[idx + 1];
    // Replace history so the player → next-episode (or series after the finale)
    // hop is not a separate back-step. Back from any episode lands on the
    // series view, not the previous episode.
    if (next) {
      // Auto-advance always starts the next episode at 0 — bypass any stale
      // playback_state row that might still hold a position from an earlier
      // partial watch. Without this, marking the next episode "unwatched"
      // before letting the previous one auto-advance can land in the middle
      // of the episode if the row's position survived (e.g. row was rewritten
      // by a stray POST after the kebab clear).
      this.skipResumeOnNextOpen = true;
      navigate(playHref(next.path), { replace: true });
    } else {
      navigate(seriesHref(series.series.id), { replace: true });
    }
  };

  private onError = (): void => {
    const v = this.videoEl;
    const mediaError = v?.error;
    // 0.1.7 — full state snapshot at the moment of failure, plus the
    // recent traceLog (already in `this.traceLog`, surfaced via the report).
    const errorContext = {
      playMode: this.playMode,
      relPath: this.relPath,
      videoCodec: this.probe?.videoCodec,
      audioCodec: this.probe?.audioCodec,
      ...this.playerSnapshot(),
      errorCode: mediaError?.code,
      errorMessage: mediaError?.message,
    };
    this.trace('video.error', errorContext);
    // eslint-disable-next-line no-console
    console.warn('[media-player] <video> error', errorContext);
    this.recordFailure('video-error', mediaError?.code, mediaError?.message);
    // HLS has no fallback chain (universal format is the whole point).
    // hls.js handles its own buffer-stall recovery; a hard <video> error
    // means the file is genuinely unplayable and the right answer is to
    // surface the external-player handoff.
    this.playMode = 'external';
  };

  /** Push a failure into the ring buffer (last 5, newest first). */
  private recordFailure(reason: string, code?: number, message?: string): void {
    const entry: {
      at: number;
      reason: string;
      playMode: string;
      videoErrorCode?: number;
      videoErrorMessage?: string;
    } = { at: Date.now(), reason, playMode: this.playMode };
    if (typeof code === 'number') entry.videoErrorCode = code;
    if (message) entry.videoErrorMessage = message;
    this.failureLog = [entry, ...this.failureLog].slice(0, 5);
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      const v = this.videoEl;
      if (v && this.persister && this.duration > 0) {
        this.persister.flushBeacon(this.absoluteTime(v), this.duration);
      }
    }
  };

  private onPageHide = (): void => {
    const v = this.videoEl;
    if (v && this.persister && this.duration > 0) {
      this.persister.flushBeacon(this.absoluteTime(v), this.duration);
    }
    // 0.1.9 — DELETE the player session via beacon so the server cache dir
    // gets cleaned up immediately rather than waiting for the idle GC.
    if (this.playerSessionCtl) {
      void this.playerSessionCtl.close(true).catch(() => undefined);
    }
  };

  private onFullscreenChange = (): void => {
    this.isFullscreen = document.fullscreenElement !== null;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const v = this.videoEl;
    const tag = (e.target as HTMLElement | null)?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Escape: popover → fullscreen → no-op
    if (e.key === 'Escape') {
      if (this.openPopover !== null) {
        e.preventDefault();
        this.openPopover = null;
        return;
      }
      if (document.fullscreenElement) {
        e.preventDefault();
        void document.exitFullscreen();
        return;
      }
      return;
    }
    if (!v) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (v.paused) void v.play(); else v.pause();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      v.currentTime = Math.min(v.duration || v.currentTime + 5, v.currentTime + 5);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      v.currentTime = Math.max(0, v.currentTime - 5);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.toggleFullscreen();
    }
    this.kickIdleTimer();
  };

  private toggleFullscreen(): void {
    const root = this.renderRoot.querySelector('.frame') as HTMLElement | null;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void root.requestFullscreen?.();
    }
  }

  /** Single-click toggles play/pause; double-click toggles fullscreen. */
  private onVideoClick = (e: MouseEvent): void => {
    if (this.nativeControls) return;
    e.preventDefault();
    if (this.clickTimer !== null) return; // dblclick will handle it
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.togglePlay();
    }, 250);
  };

  private onVideoDblClick = (e: MouseEvent): void => {
    if (this.nativeControls) return;
    e.preventDefault();
    if (this.clickTimer !== null) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.toggleFullscreen();
  };

  /** Close any open popover when the click landed outside the trigger.
   *  Clicks on a popover-anchor (its trigger button or popover content) are
   *  ignored — those handle their own toggling via stopPropagation. Clicks
   *  anywhere else (the video, scrubber, top bar, page outside the player)
   *  close the open popover. */
  private onDocClick = (e: MouseEvent): void => {
    if (this.openPopover === null) return;
    const path = e.composedPath();
    for (const node of path) {
      if (node instanceof HTMLElement && node.classList.contains('popover-anchor')) {
        return;
      }
    }
    this.openPopover = null;
  };

  /** Whether a stream-local second lies inside what hls.js has fetched
   *  into MSE. Used by the scrubber to decide when a drag preview can
   *  scrub <video>.currentTime locally for instant feedback. */
  private isInLocalBuffer(v: HTMLVideoElement, local: number): boolean {
    if (local < 0) return false;
    const ranges = v.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (local >= ranges.start(i) && local <= ranges.end(i)) return true;
    }
    return false;
  }

  private onScrubInput(e: Event): void {
    const v = this.videoEl;
    if (!v) return;
    const t = Number((e.target as HTMLInputElement).value);
    this.pendingSeek = t;
    this.currentTime = t;
    // Live drag preview: if the target is inside what hls.js has buffered
    // we can scrub <video>.currentTime locally for instant feedback. Out
    // of buffer the scrubber-thumb just moves; commit sends /seek.
    const w = this.serverEncodedWindow;
    if (t >= w.from && t <= w.to) {
      const local = t - w.from;
      if (this.isInLocalBuffer(v, local)) {
        v.currentTime = local;
      }
    }
  }

  private onScrubCommit(e: Event): void {
    const v = this.videoEl;
    if (!v) return;
    const t = Number((e.target as HTMLInputElement).value);
    // One round trip to /seek decides reuse-vs-respawn. The client never
    // inspects the encoded window or does streamOffset arithmetic.
    this.trace('onScrubCommit', { target: t });
    this.currentTime = t;
    this.seeking = true;
    void this.playerSessionCtl?.seek(t);
  }

  private onVolume(e: Event): void {
    const v = this.videoEl;
    if (!v) return;
    const x = Number((e.target as HTMLInputElement).value);
    v.volume = x;
    this.volume = x;
    if (x === 0) { v.muted = true; this.muted = true; }
    else if (this.muted) { v.muted = false; this.muted = false; }
    volumePrefs.volume = this.volume;
    volumePrefs.muted = this.muted;
    saveVolumePrefs();
  }

  private togglePlay(): void {
    const v = this.videoEl;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }

  private toggleMute(): void {
    const v = this.videoEl;
    if (!v) return;
    v.muted = !v.muted;
    this.muted = v.muted;
    volumePrefs.muted = this.muted;
    saveVolumePrefs();
  }

  private applyActiveSubtitle(): void {
    const v = this.videoEl;
    if (!v || !v.textTracks) return;
    // 0.1.4.3 — track ordering: subs[0..N-1] then optional embedded track at
    // index N. The embedded entry is "showing" iff activeEmbeddedSubGlobalIndex
    // is non-null; otherwise the sibling entry at activeSubIndex is showing
    // (or all are hidden if activeSubIndex < 0).
    const wantEmbedded = this.activeEmbeddedSubGlobalIndex !== null;
    const embeddedTrackIdx = this.subs.length;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (!t) continue;
      let show: boolean;
      if (wantEmbedded) {
        show = i === embeddedTrackIdx;
      } else {
        show = i === this.activeSubIndex;
      }
      t.mode = show ? 'showing' : 'disabled';
    }
  }

  private selectSubtitle(index: number): void {
    this.activeSubIndex = index;
    // Sibling-file selection clears any embedded-stream / burn-in selection.
    if (this.activeEmbeddedSubGlobalIndex !== null) this.activeEmbeddedSubGlobalIndex = null;
    if (this.activeBurnSubIndex !== null) {
      this.activeBurnSubIndex = null;
      this.respawnAtCurrentTime();
    }
    if (index < 0) writeSubPref(this.relPath, 'off');
    else writeSubPref(this.relPath, `sibling:${index}`);
    this.openPopover = null;
    this.applyActiveSubtitle();
  }

  private toggleNamedPopover(key: Exclude<PopoverKey, null>): void {
    this.openPopover = this.openPopover === key ? null : key;
  }

  private formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00';
    const total = Math.floor(s);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ---------- siblings / context ----------

  private get siblings(): SiblingInfo {
    const series = getCachedSeriesContaining(this.relPath);
    if (!series) return { prev: null, next: null, series: null, current: null };
    const eps = series.episodes;
    const idx = eps.findIndex((e) => e.path === this.relPath);
    if (idx < 0) return { prev: null, next: null, series, current: null };
    const current = eps[idx] ?? null;
    const prev = idx > 0 ? eps[idx - 1] ?? null : null;
    const next = idx < eps.length - 1 ? eps[idx + 1] ?? null : null;
    return { prev, next, series, current };
  }

  private onPrevEpisode(): void {
    const { prev } = this.siblings;
    // Replace so back collapses every in-player episode hop into a single step.
    if (prev) navigate(playHref(prev.path), { replace: true });
  }
  private onNextEpisode(): void {
    const { next } = this.siblings;
    if (next) navigate(playHref(next.path), { replace: true });
  }
  private onBackClick(): void {
    // Prefer the browser history step so the user returns through the same path
    // they came in by — home → series → player back-steps to series, then home.
    // The fallback covers deep-linked plays where there's no in-app history yet.
    const { series } = this.siblings;
    goBack(series ? seriesHref(series.series.id) : homeHref());
  }

  private onEpisodeSelected = (e: Event): void => {
    const detail = (e as CustomEvent<{ path: string }>).detail;
    if (!detail?.path) return;
    this.openPopover = null;
    // Episode-grid jumps stay within the player — replace so back doesn't
    // walk through the chain of episodes you tried.
    navigate(playHref(detail.path), { replace: true });
  };

  private onViewAllEpisodes = (): void => {
    const { series } = this.siblings;
    if (series) {
      this.openPopover = null;
      navigate(seriesHref(series.series.id));
    }
  };

  private onPipClick(): void {
    const v = this.videoEl as HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
    } | null;
    if (!v) return;
    const doc = document as Document & {
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    if (doc.pictureInPictureElement === v && doc.exitPictureInPicture) {
      void doc.exitPictureInPicture().catch(() => {});
      return;
    }
    if (!v.requestPictureInPicture) return;
    void v.requestPictureInPicture().catch(() => {});
    this.openPopover = null;
  }

  private onEnterPip = (): void => {
    this.pipActive = true;
  };

  /** Browser fired `leavepictureinpicture`. Two cases:
   *   - User-initiated exit: just clear the flag.
   *   - Episode change: hls.js's `attachMedia` swap drops us out of PiP. We
   *     can't tell the cases apart from this event alone, so we rely on
   *     `resumePipOnNextLoad` (set in `updated` when relPath changes while
   *     `pipActive` is true) to re-enter PiP after the next `loadedmetadata`. */
  private onLeavePip = (): void => {
    this.pipActive = false;
  };

  private setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    const v = this.videoEl;
    if (v) v.playbackRate = rate;
  }

  // ---------- render ----------

  override render(): unknown {
    const idle = this.chromeIdle && !this.paused && this.openPopover === null;
    const frameClass = `frame${idle ? ' idle' : ''}`;
    return html`
      <div
        class=${frameClass}
        @mousemove=${this.kickIdleTimer}
        @mousedown=${this.kickIdleTimer}
        @touchstart=${this.kickIdleTimer}
        @focusin=${this.kickIdleTimer}
      >
        ${this.renderStage()}
      </div>
    `;
  }

  private renderStage(): unknown {
    if (this.capacityError) {
      return this.renderCapacityPanel();
    }
    if (this.error) {
      return this.renderErrorPanel();
    }
    if (this.probing || !this.probe) {
      return html`<div class="loading-panel">Checking playback…</div>`;
    }
    if (this.playMode === 'external') {
      return this.renderExternalPanel();
    }
    // <video> has no src= in the template — PlayerSession.attachPlaylist()
    // either sets v.src (Safari native HLS) or hands the element to hls.js.
    const embeddedSubStream = this.activeEmbeddedSubGlobalIndex !== null
      ? (this.probe?.subStreams ?? []).find((s) => s.index === this.activeEmbeddedSubGlobalIndex)
      : undefined;
    return html`
      <video
        class="stage-video"
        src=${nothing}
        ?controls=${this.nativeControls}
        autoplay
        @loadedmetadata=${this.onLoadedMetadata}
        @loadstart=${this.onTraceEvent}
        @loadeddata=${this.onTraceEvent}
        @canplay=${this.onBufferingEnd}
        @canplaythrough=${this.onBufferingEnd}
        @durationchange=${this.onDurationChange}
        @timeupdate=${this.onTimeUpdate}
        @progress=${this.onProgress}
        @play=${this.onPlay}
        @playing=${this.onBufferingEnd}
        @pause=${this.onPause}
        @waiting=${this.onBufferingStart}
        @stalled=${this.onBufferingStart}
        @suspend=${this.onTraceEvent}
        @seeking=${this.onBufferingStart}
        @seeked=${this.onBufferingEnd}
        @ratechange=${this.onTraceEvent}
        @volumechange=${this.onTraceEvent}
        @abort=${this.onTraceEvent}
        @emptied=${this.onTraceEvent}
        @ended=${this.onEnded}
        @error=${this.onError}
        @enterpictureinpicture=${this.onEnterPip}
        @leavepictureinpicture=${this.onLeavePip}
        @click=${this.onVideoClick}
        @dblclick=${this.onVideoDblClick}
      >
        ${this.subs.map((s) => html`
          <track
            kind="subtitles"
            src=${subsUrl(s.path)}
            srclang=${s.lang ?? 'und'}
            label=${s.lang ?? 'Subtitles'}
          />
        `)}
        ${embeddedSubStream
          ? html`<track
              kind="subtitles"
              src=${embeddedSubsUrl(this.relPath, embeddedSubStream.index)}
              srclang=${embeddedSubStream.language ?? 'und'}
              label=${languageLabel(embeddedSubStream.language) || 'Embedded'}
              default
            />`
          : null}
      </video>
      ${this.renderBufferSpinner()}
      ${this.nativeControls ? null : this.renderChrome()}
    `;
  }

  /** Buffering spinner overlay. Shown only when `<video>` reports `waiting`
   *  AND that state has persisted ≥200ms — short blips don't flicker the
   *  spinner. The 200ms gate is enforced by checking `bufferingSince` in
   *  the render path; once the state passes the threshold, this method
   *  schedules a re-render at the threshold tick so the spinner appears. */
  private renderBufferSpinner(): unknown {
    if (!this.buffering || this.bufferingSince === 0) return null;
    const elapsed = Date.now() - this.bufferingSince;
    const SHOW_AFTER_MS = 200;
    if (elapsed < SHOW_AFTER_MS) {
      // Schedule one re-render at the threshold so the spinner appears
      // exactly when the timer expires (not on the next unrelated update).
      window.setTimeout(() => this.requestUpdate(), SHOW_AFTER_MS - elapsed);
      return null;
    }
    return html`<div class="buffer-spinner"><div class="ring"></div></div>`;
  }

  private renderChrome(): unknown {
    return html`
      <div class="gradient gradient-top chrome"></div>
      <div class="gradient gradient-bottom chrome"></div>
      ${this.renderTopBar()}
      ${this.renderCenterPlay()}
      ${this.renderBottomControls()}
    `;
  }

  private renderTopBar(): unknown {
    const { series, current } = this.siblings;
    let primary: string;
    let secondary: string | null = null;
    if (series && current) {
      primary = series.series.title ?? titleFromPath(this.relPath);
      const sxxeyy = formatSeasonEpisode(current.season, current.episode);
      secondary = current.title ? `${sxxeyy} — ${current.title}` : sxxeyy;
    } else if (this.movieMeta?.title) {
      primary = this.movieMeta.title;
    } else {
      primary = titleFromPath(this.relPath);
    }
    return html`
      <div class="topbar chrome">
        <button class="back-btn" title="Back" @click=${(): void => this.onBackClick()}>
          ${iconBackChevron()}
        </button>
        <div class="title-stack">
          ${secondary
            ? html`
                <div class="show">${primary}</div>
                <div class="episode">${secondary}</div>
              `
            : html`<div class="episode">${primary}</div>`}
        </div>
        ${this.playMode === 'hls'
          ? html`<span class="badge" title="Streaming via HLS (HTTP Live Streaming)">HLS</span>`
          : null}
        <button
          class=${`back-btn report-btn report-${this.reportStatus}`}
          title=${this.reportStatusTitle()}
          ?disabled=${this.reportSending}
          @click=${(e: Event): void => {
            e.stopPropagation();
            void this.sendReport();
          }}
        >
          ${iconBug()}
        </button>
      </div>
    `;
  }

  private reportStatusTitle(): string {
    switch (this.reportStatus) {
      case 'sending': return 'Sending report…';
      case 'sent':    return 'Report sent — check the server log';
      case 'failed':  return 'Report failed to send';
      default:        return 'Send diagnostic report to the server log';
    }
  }

  private renderCenterPlay(): unknown {
    return html`
      <button
        class="center-play chrome"
        @click=${(e: Event): void => {
          e.stopPropagation();
          this.togglePlay();
        }}
      >
        ${this.paused ? iconPlay() : iconPause()}
      </button>
    `;
  }

  private renderBottomControls(): unknown {
    return html`
      <div class="bottom-controls chrome">
        ${this.renderScrubberRow()}
        ${this.renderControlsRow()}
      </div>
    `;
  }

  private renderScrubberRow(): unknown {
    const cur = this.pendingSeek ?? this.currentTime;
    const playedPct = this.duration > 0 ? Math.min(100, (cur / this.duration) * 100) : 0;
    const bufferedPct = Math.max(playedPct, this.bufferedPct);
    // 0.1.9 — encoded-runway tick at `serverEncodedWindow.to` (absolute
    // source-second up to which ffmpeg has emitted segments). Sits beyond
    // the played head so the user knows how much runway they have.
    const encodedAbs = this.serverEncodedWindow.to;
    const encodedPct =
      this.duration > 0 && encodedAbs > 0
        ? Math.min(100, (encodedAbs / this.duration) * 100)
        : 0;
    const chapters = this.probe?.chapters ?? [];
    const showTicks = this.duration > 0 && chapters.length > 1;
    return html`
      <div class="scrubber-row">
        <span class="time">
          ${this.seeking ? html`<em style="color:#aaa;">…</em> ` : null}${this.formatTime(cur)}
        </span>
        <div class="scrubber" style=${`--played-pct:${playedPct}%; --buffered-pct:${bufferedPct}%; --encoded-pct:${encodedPct}%;`}>
          ${encodedPct > bufferedPct
            ? html`<div class="encoded-runway-tick" title=${this.serverEncodePaused ? 'Encoder paused' : 'Encoded ahead'} ?data-paused=${this.serverEncodePaused}></div>`
            : null}
          <div class="track">
            <div class="buffered"></div>
            <div class="played"></div>
          </div>
          ${showTicks
            ? html`<div class="chapters">
                ${chapters.map((c) => {
                  const pct = Math.max(0, Math.min(100, (c.startSeconds / this.duration) * 100));
                  const title = c.title ?? `Chapter ${c.index + 1}`;
                  return html`<div
                    class="chapter-tick"
                    title=${title}
                    style=${`left:${pct}%;`}
                    @mouseenter=${(): void => { this.hoveredChapter = c; }}
                    @mouseleave=${(): void => {
                      if (this.hoveredChapter?.index === c.index) this.hoveredChapter = null;
                    }}
                    @click=${(e: Event): void => {
                      e.stopPropagation();
                      this.onChapterClick(c);
                    }}
                  ></div>`;
                })}
                ${this.hoveredChapter
                  ? (() => {
                      const hc = this.hoveredChapter;
                      const pct = Math.max(0, Math.min(100, (hc.startSeconds / this.duration) * 100));
                      const ttl = hc.title ?? `Chapter ${hc.index + 1}`;
                      return html`<div class="chapter-tooltip" style=${`left:${pct}%;`}>
                        <div>${ttl}</div>
                        <div class="ts">${this.formatTime(hc.startSeconds)}</div>
                      </div>`;
                    })()
                  : null}
              </div>`
            : null}
          <input
            type="range"
            min="0"
            max=${this.duration || 0}
            step="0.1"
            .value=${String(cur)}
            @input=${(e: Event): void => this.onScrubInput(e)}
            @change=${(e: Event): void => this.onScrubCommit(e)}
          />
        </div>
        <span class="time right">${this.formatTime(this.duration)}</span>
      </div>
    `;
  }

  /** 0.1.4.3 — clicking a chapter tick scrubs to its start. The server
   *  decides reuse-vs-respawn via /seek; the client just reports the
   *  absolute target. */
  private onChapterClick(chapter: Chapter): void {
    if (!this.videoEl) return;
    const target = Math.max(0, Math.min(this.duration, chapter.startSeconds));
    this.currentTime = target;
    this.seeking = true;
    void this.playerSessionCtl?.seek(target);
  }

  private renderControlsRow(): unknown {
    return html`
      <div class="controls-row">
        ${this.renderLeftCluster()}
        ${this.renderRightCluster()}
      </div>
    `;
  }

  private renderLeftCluster(): unknown {
    const { prev, next, series } = this.siblings;
    const showEpisodeNav = !!series;
    const onlyOneEp = series ? series.episodes.length <= 1 : false;
    const showPrevNext = showEpisodeNav && !onlyOneEp;
    const volIcon = this.muted || this.volume === 0 ? iconVolumeMute() : iconVolume();
    return html`
      <div class="cluster">
        ${showPrevNext
          ? html`
              <button
                class="icon-btn"
                title="Previous episode"
                ?disabled=${!prev}
                @click=${(): void => this.onPrevEpisode()}
              >${iconPrev()}</button>
            `
          : null}
        <button class="icon-btn" title=${this.paused ? 'Play' : 'Pause'} @click=${(): void => this.togglePlay()}>
          ${this.paused ? iconPlay() : iconPause()}
        </button>
        ${showPrevNext
          ? html`
              <button
                class="icon-btn"
                title="Next episode"
                ?disabled=${!next}
                @click=${(): void => this.onNextEpisode()}
              >${iconNext()}</button>
            `
          : null}
        <div class="vol-wrap">
          <button class="icon-btn" title="Mute" @click=${(): void => this.toggleMute()}>
            ${volIcon}
          </button>
          <div class="vol-slider">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              .value=${String(this.muted ? 0 : this.volume)}
              @input=${(e: Event): void => this.onVolume(e)}
            />
          </div>
        </div>
      </div>
    `;
  }

  private renderRightCluster(): unknown {
    const { series, current } = this.siblings;
    const showGrid = !!series && !!current;
    const subsOn =
      this.activeSubIndex >= 0 ||
      this.activeEmbeddedSubGlobalIndex !== null ||
      this.activeBurnSubIndex !== null;
    const popKey = this.openPopover;
    return html`
      <div class="cluster">
        <div class="popover-anchor">
          <button
            class=${`icon-btn${subsOn ? ' active' : ''}${popKey === 'cc' ? ' active' : ''}`}
            title="Subtitles"
            @click=${(e: Event): void => {
              e.stopPropagation();
              this.toggleNamedPopover('cc');
            }}
          >${iconCC()}</button>
          ${this.renderCcPopover()}
        </div>
        <div class="popover-anchor">
          <button
            class=${`icon-btn${popKey === 'audio' ? ' active' : ''}`}
            title="Audio"
            @click=${(e: Event): void => {
              e.stopPropagation();
              this.toggleNamedPopover('audio');
            }}
          >${iconAudio()}</button>
          ${this.renderAudioPopover()}
        </div>
        ${showGrid
          ? html`
              <div class="popover-anchor">
                <button
                  class=${`icon-btn${popKey === 'grid' ? ' active' : ''}`}
                  title="Episodes"
                  @click=${(e: Event): void => {
                    e.stopPropagation();
                    this.toggleNamedPopover('grid');
                  }}
                >${iconGrid()}</button>
                ${this.renderGridPopover()}
              </div>
            `
          : null}
        ${this.pipSupported
          ? html`
              <button
                class=${`icon-btn${this.pipActive ? ' active' : ''}`}
                title=${this.pipActive ? 'Exit picture-in-picture' : 'Picture-in-picture'}
                @click=${(e: Event): void => {
                  e.stopPropagation();
                  this.onPipClick();
                }}
              >${iconPip()}</button>
            `
          : null}
        <div class="popover-anchor">
          <button
            class=${`icon-btn${popKey === 'settings' ? ' active' : ''}`}
            title="Settings"
            @click=${(e: Event): void => {
              e.stopPropagation();
              this.toggleNamedPopover('settings');
            }}
          >${iconSettings()}</button>
          ${this.renderSettingsPopover()}
        </div>
        <div class="popover-anchor">
          <button
            class=${`icon-btn${popKey === 'info' ? ' active' : ''}`}
            title="Stream info"
            @click=${(e: Event): void => {
              e.stopPropagation();
              this.toggleNamedPopover('info');
            }}
          >${iconInfo()}</button>
          ${this.renderInfoPopover()}
        </div>
        <button class="icon-btn" title="Fullscreen" @click=${(): void => this.toggleFullscreen()}>
          ${this.isFullscreen ? iconFullscreenExit() : iconFullscreen()}
        </button>
      </div>
    `;
  }

  /** CC popover. Renders sibling SRT/VTT files plus embedded sub streams from
   *  the probe. (0.1.4.3) */
  private renderCcPopover(): unknown {
    const open = this.openPopover === 'cc';
    const embedded = this.probe?.subStreams ?? [];
    const isOff =
      this.activeSubIndex < 0 &&
      this.activeEmbeddedSubGlobalIndex === null &&
      this.activeBurnSubIndex === null;
    return html`
      <player-popover ?open=${open} .width=${280} .notchRightPx=${18}>
        <div @click=${(e: Event): void => e.stopPropagation()}>
          <div class="menu-list">
            <button
              class=${isOff ? 'active' : ''}
              style="--stagger-index:0"
              @click=${(): void => this.selectSubtitleOff()}
            >
              <span>Off</span>
              <span class="check-mark">${iconCheck()}</span>
            </button>
          </div>
          ${this.subs.length > 0
            ? html`
                <div class="menu-section-title">Sibling files</div>
                <div class="menu-list">
                  ${this.subs.map((s, i) => html`
                    <button
                      class=${this.activeSubIndex === i &&
                        this.activeEmbeddedSubGlobalIndex === null &&
                        this.activeBurnSubIndex === null ? 'active' : ''}
                      style="--stagger-index:0"
                      @click=${(): void => this.selectSubtitle(i)}
                    >
                      <span>${languageLabel(s.lang) || `Track ${i + 1}`}</span>
                      <span class="check-mark">${iconCheck()}</span>
                    </button>
                  `)}
                </div>
              `
            : null}
          ${embedded.length > 0
            ? html`
                <div class="menu-section-title">Embedded</div>
                <div class="menu-list">
                  ${embedded.map((s) => {
                    const active = s.textBased
                      ? this.activeEmbeddedSubGlobalIndex === s.index
                      : this.activeBurnSubIndex === s.subIndex;
                    return html`<button
                      class=${active ? 'active' : ''}
                      style="--stagger-index:0"
                      @click=${(): void => this.selectEmbeddedSub(s)}
                    >
                      <span>${describeSubStream(s)}</span>
                      <span class="check-mark">${iconCheck()}</span>
                    </button>`;
                  })}
                </div>
              `
            : null}
        </div>
      </player-popover>
    `;
  }

  /** "Off" — disable every subtitle source. */
  private selectSubtitleOff(): void {
    this.openPopover = null;
    this.activeSubIndex = -1;
    if (this.activeEmbeddedSubGlobalIndex !== null) {
      this.activeEmbeddedSubGlobalIndex = null;
    }
    if (this.activeBurnSubIndex !== null) {
      // Burn-in is baked into the video — turning it off requires a respawn.
      this.activeBurnSubIndex = null;
      this.respawnAtCurrentTime();
    }
    writeSubPref(this.relPath, 'off');
    this.applyActiveSubtitle();
  }

  /** Pick an embedded sub stream. Text-based: add a `<track>`. Image-based
   *  (PGS / VobSub): respawn the pipeline with `burnSub=N`. (0.1.4.3) */
  private selectEmbeddedSub(s: SubStream): void {
    this.openPopover = null;
    if (s.textBased) {
      this.activeBurnSubIndex = null;
      this.activeEmbeddedSubGlobalIndex = s.index;
      this.activeSubIndex = -1; // sibling-file selection cleared
      writeSubPref(this.relPath, `embedded:${s.index}`);
      // Defer to the updated() hook to populate the new <track>.
      this.applyActiveSubtitle();
      this.requestUpdate();
    } else {
      // Burn-in: write the pref, set the burn index, respawn ffmpeg.
      this.activeEmbeddedSubGlobalIndex = null;
      this.activeBurnSubIndex = s.subIndex;
      this.activeSubIndex = -1;
      writeSubPref(this.relPath, `burn:${s.subIndex}`);
      this.respawnAtCurrentTime();
    }
  }

  /** Respawn the ffmpeg pipe at the current absolute time. Shared between
   *  audio-track switches and burn-sub switches. (0.1.4.3, 0.1.9) */
  private respawnAtCurrentTime(): void {
    const v = this.videoEl;
    const targetTime = v ? this.absoluteTime(v) : this.currentTime;
    this.seeking = true;
    this.currentTime = targetTime;
    void this.playerSessionCtl?.changeTracks({
      ...(this.activeAudioIndex !== null ? { audioStreamIndex: this.activeAudioIndex } : {}),
      burnSubStreamIndex: this.activeBurnSubIndex ?? null,
      startSeconds: targetTime,
    });
  }

  private renderAudioPopover(): unknown {
    const open = this.openPopover === 'audio';
    const audios = this.probe?.audioStreams ?? [];
    if (audios.length === 0) {
      // No tracks enumerated (probe pre-0.1.4.3 or single-stream file with no
      // probe). Surface the codec only — non-interactive.
      const label = this.probe?.audioCodec || 'Track 1';
      return html`
        <player-popover ?open=${open} .width=${220} .notchRightPx=${18}>
          <div class="menu-list" @click=${(e: Event): void => e.stopPropagation()}>
            <button class="active" style="--stagger-index:0">
              <span>${label}</span>
              <span class="check-mark">${iconCheck()}</span>
            </button>
          </div>
        </player-popover>
      `;
    }
    // Resolve which entry is currently active. null → use the file's default.
    const activeIdx = this.activeAudioIndex
      ?? audios.find((a) => a.default)?.audioIndex
      ?? audios[0]!.audioIndex;
    const directNote =
      this.probe?.decision === 'direct' && audios.length > 1
        ? html`<div class="menu-section-title">Direct stream — switching upgrades to remux</div>`
        : null;
    return html`
      <player-popover ?open=${open} .width=${260} .notchRightPx=${18}>
        <div @click=${(e: Event): void => e.stopPropagation()}>
          ${directNote}
          <div class="menu-list">
            ${audios.map((a, i) => html`
              <button
                class=${a.audioIndex === activeIdx ? 'active' : ''}
                style="--stagger-index:0"
                @click=${(): void => this.selectAudioTrack(a)}
              >
                <span>${describeAudioStream(a, i)}</span>
                <span class="check-mark">${iconCheck()}</span>
              </button>
            `)}
          </div>
        </div>
      </player-popover>
    `;
  }

  /** 0.1.4.3 — pick a different audio track. Captures the current absolute
   *  time, sets `activeAudioIndex`, and respawns the pipeline at the same
   *  position via the standard scrub-restart path. */
  private selectAudioTrack(audio: AudioStream): void {
    this.openPopover = null;
    if (audio.audioIndex === this.activeAudioIndex) return; // no-op
    const v = this.videoEl;
    const targetTime = v ? this.absoluteTime(v) : this.currentTime;
    this.activeAudioIndex = audio.audioIndex;
    writeAudioPref(this.relPath, audio.audioIndex);
    this.seeking = true;
    this.currentTime = targetTime;
    void this.playerSessionCtl?.changeTracks({
      audioStreamIndex: audio.audioIndex,
      startSeconds: targetTime,
    });
  }

  private renderSettingsPopover(): unknown {
    const open = this.openPopover === 'settings';
    return html`
      <player-popover ?open=${open} .width=${220} .notchRightPx=${18}>
        <div @click=${(e: Event): void => e.stopPropagation()}>
          <div class="menu-section-title">Speed</div>
          <div class="menu-list">
            ${SPEEDS.map((rate) => html`
              <button
                class=${this.playbackRate === rate ? 'active' : ''}
                style="--stagger-index:0"
                @click=${(): void => this.setPlaybackRate(rate)}
              >
                <span>${rate === 1 ? 'Normal' : `${rate}x`}</span>
                <span class="check-mark">${iconCheck()}</span>
              </button>
            `)}
          </div>
        </div>
      </player-popover>
    `;
  }

  /** Build a copy/paste-friendly diagnostic block. Surfaces what the HLS
   *  metadata + runtime state knows: container/codecs, the effective
   *  playMode, the resolved duration, and the active stream URL. The
   *  textarea is selected on click so one tap + Cmd/Ctrl-C copies the
   *  whole report. */
  private buildInfoReport(): string {
    const p = this.probe;
    const v = this.videoEl;
    const lines: string[] = [];
    lines.push(`Path:            ${this.relPath}`);
    if (p?.absPath) lines.push(`Abs path:        ${p.absPath}`);
    if (p?.container) lines.push(`Container:       ${p.container}`);
    if (p?.videoCodec) lines.push(`Video codec:     ${p.videoCodec}`);
    if (p?.audioCodec) lines.push(`Audio codec:     ${p.audioCodec}`);
    lines.push(`Play mode:       ${this.playMode}`);
    if (typeof p?.durationSeconds === 'number' && p.durationSeconds > 0) {
      lines.push(`Probe duration:  ${p.durationSeconds.toFixed(2)}s`);
    }
    if (this.duration > 0) lines.push(`Resolved dur:    ${this.duration.toFixed(2)}s`);
    if (v && Number.isFinite(v.duration)) {
      lines.push(`<video>.dur:     ${Number(v.duration).toFixed(2)}s`);
    }
    lines.push(`Stream offset:   ${this.streamOffset}s`);
    lines.push(`Current time:    ${this.currentTime.toFixed(2)}s`);
    lines.push(`Stream URL:      ${this.buildStreamSrc()}`);
    if (this.subs.length > 0) {
      lines.push(`Subtitles:       ${this.subs.map((s) => s.lang ?? '?').join(', ')}`);
    }
    if (this.failureLog.length > 0) {
      lines.push(`Last failures:`);
      for (const f of this.failureLog) {
        const t = new Date(f.at).toISOString();
        const code = f.videoErrorCode != null ? ` code=${f.videoErrorCode}` : '';
        const msg = f.videoErrorMessage ? ` msg="${f.videoErrorMessage}"` : '';
        lines.push(`  ${t} ${f.reason} mode=${f.playMode}${code}${msg}`);
      }
    }
    lines.push(`User agent:      ${navigator.userAgent}`);
    return lines.join('\n');
  }

  /** Build the structured "Copy diagnostic dump" JSON blob. Bundles the
   *  overlay state, server-side diagnostics, and recent failure ring buffer
   *  into a single clipboard-friendly payload. */
  private buildDiagnosticDump(): string {
    const v = this.videoEl;
    const dump = {
      relPath: this.relPath,
      streamUrl: this.buildStreamSrc(),
      probe: this.probe,
      playMode: this.playMode,
      streamOffset: this.streamOffset,
      currentTime: this.currentTime,
      duration: this.duration,
      videoElement: v
        ? {
            readyState: v.readyState,
            networkState: v.networkState,
            duration: Number.isFinite(v.duration) ? v.duration : null,
            currentTime: v.currentTime,
            paused: v.paused,
          }
        : null,
      failureLog: this.failureLog,
      consoleBuffer: getConsoleBuffer(),
      userAgent: navigator.userAgent,
      capturedAt: new Date().toISOString(),
    };
    return JSON.stringify(dump, null, 2);
  }

  /** "Report" button handler. Bundles the same diagnostic dump as
   *  `buildDiagnosticDump()` and POSTs it to `/api/client-log`, where it lands
   *  in the server log. Useful for remote sessions where copy/pasting console
   *  output isn't practical. */
  private async sendReport(tag = 'player-report'): Promise<void> {
    if (this.reportSending) return;
    this.reportSending = true;
    this.reportStatus = 'sending';
    try {
      const v = this.videoEl;
      const payload = {
        tag,
        relPath: this.relPath,
        streamUrl: this.buildStreamSrc(),
        probe: this.probe,
        playMode: this.playMode,
        streamOffset: this.streamOffset,
        currentTime: this.currentTime,
        duration: this.duration,
        videoElement: v
          ? {
              readyState: v.readyState,
              networkState: v.networkState,
              duration: Number.isFinite(v.duration) ? v.duration : null,
              currentTime: v.currentTime,
              paused: v.paused,
              videoErrorCode: v.error?.code ?? null,
              videoErrorMessage: v.error?.message ?? null,
            }
          : null,
        failureLog: this.failureLog,
        consoleBuffer: getConsoleBuffer(),
        // 0.1.7 — full narrative trace of player events leading up to the
        // failure. Includes every <video> event, hls.js event, and player
        // state transition. Server-side client-log route doesn't interpret
        // it; humans read it to find where the state machine went wrong.
        traceLog: this.traceLog.slice(),
        userAgent: navigator.userAgent,
        capturedAt: new Date().toISOString(),
      };
      await apiClientLog(payload);
      this.reportStatus = 'sent';
    } catch (err) {
      console.warn('[media-player] report send failed', err);
      this.reportStatus = 'failed';
    } finally {
      this.reportSending = false;
      // Clear the status pill after a beat so the button returns to idle.
      window.setTimeout(() => {
        if (this.reportStatus !== 'sending') this.reportStatus = 'idle';
      }, 2000);
    }
  }

  private async copyInfoReport(): Promise<void> {
    const text = this.buildInfoReport();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* fall through to manual select */ }
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>('.info-report');
    if (ta) {
      ta.focus();
      ta.select();
    }
  }

  private async copyDiagnosticDump(): Promise<void> {
    const text = this.buildDiagnosticDump();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* fall through */ }
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>('.info-report');
    if (ta) {
      ta.value = text;
      ta.focus();
      ta.select();
    }
  }

  private renderInfoPopover(): unknown {
    const open = this.openPopover === 'info';
    const text = open ? this.buildInfoReport() : '';
    return html`
      <player-popover ?open=${open} .width=${380} .notchRightPx=${18}>
        <div @click=${(e: Event): void => e.stopPropagation()} style="--stagger-index:0">
          <div class="menu-section-title" style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <span>Stream info</span>
            <span style="display:flex;gap:6px;">
              <button
                class="icon-btn"
                style="width:auto;height:auto;padding:4px 8px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--hm-accent);"
                title="Copy text report"
                @click=${(): void => { void this.copyInfoReport(); }}
              >Copy</button>
              <button
                class="icon-btn"
                style="width:auto;height:auto;padding:4px 8px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--hm-accent);"
                title="Copy diagnostic dump (JSON)"
                @click=${(): void => { void this.copyDiagnosticDump(); }}
              >Copy dump</button>
            </span>
          </div>
          <textarea
            class="info-report"
            readonly
            .value=${text}
            @click=${(e: Event): void => (e.target as HTMLTextAreaElement).select()}
            style="width:100%;min-height:240px;background:#0c0c0c;color:#cdd;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;box-sizing:border-box;resize:vertical;"
          ></textarea>
        </div>
      </player-popover>
    `;
  }

  private renderGridPopover(): unknown {
    const open = this.openPopover === 'grid';
    const { series } = this.siblings;
    return html`
      <player-popover ?open=${open} .width=${348} .notchRightPx=${18}>
        <div @click=${(e: Event): void => e.stopPropagation()} style="--stagger-index:0">
          <episode-grid
            .detail=${series}
            .currentPath=${this.relPath}
            @episode-selected=${this.onEpisodeSelected}
            @view-all-episodes=${this.onViewAllEpisodes}
          ></episode-grid>
        </div>
      </player-popover>
    `;
  }

  /** 0.1.9 — "Encoder busy" panel rendered when /open returns 503
   *  capacity_exceeded. The user has to close another player to free a
   *  slot. Retry just calls /open again. */
  /** 0.1.11 — friendly playback-error panel. Surfaces when the HLS load
   *  failed, the heartbeat revive gave up after a server restart, or the
   *  `/open` call errored. Offers a Retry that re-runs the session
   *  bootstrap with a fresh playerId. */
  private renderErrorPanel(): unknown {
    return html`
      <div class="error-panel">
        <img class="error-art" src="/404.jpg" alt="Technical difficulties" />
        <button
          class="back-btn error-back"
          title="Back"
          @click=${(): void => this.onBackClick()}
        >${iconBackChevron()}</button>
        <button class="error-retry" @click=${(): void => this.retryPlayback()}>
          Retry
        </button>
        <!-- 0.2.0 (D9) — escape hatch. A stalled modern player on a TV is
             unrecoverable without devtools; this one action drops to the
             native-HLS legacy client. Detection is wrong ~5% of the time, so
             this turns a dead end into a minor downgrade. -->
        <button class="error-basic" @click=${(): void => forceBasicPlayer()}>
          Trouble playing? Switch to Basic Player
        </button>
      </div>
    `;
  }

  /** 0.1.11 — clear the error and re-run the session bootstrap. Used by
   *  the manual Retry button AND by the automatic recovery path when the
   *  connection-store fires `library-invalidated` after the server is back. */
  private retryPlayback(): void {
    this.error = null;
    // Tear down the stale PlayerSession (if any) — the server forgot our
    // playerId, so the next /open call mints a fresh one.
    if (this.playerSessionCtl) {
      void this.playerSessionCtl.close(false).catch(() => undefined);
      this.playerSessionCtl = null;
    }
    this.playerBundle = null;
    this.probedFor = null;
    void this.runPlayerSessionBootstrap();
  }

  private renderCapacityPanel(): unknown {
    const c = this.capacityError;
    if (!c) return null;
    const reason =
      c.kind === 'global'
        ? `${c.active}/${c.limit} encoder slots are in use across the household.`
        : `Another player from this device is already running (${c.active}/${c.limit}).`;
    return html`
      <div class="external-panel">
        <div class="external-actions">
          <button
            class="back-btn"
            title="Back"
            @click=${(): void => this.onBackClick()}
          >${iconBackChevron()}</button>
          <h3 style="flex:1;">Encoder busy</h3>
        </div>
        <div class="external-body">
          <p>${reason}</p>
          <p>Close one of the other players, then try again.</p>
          <p>
            <button
              class="back-btn"
              @click=${(): void => {
                this.capacityError = null;
                this.runPlayerSessionBootstrap();
              }}
            >Retry</button>
          </p>
        </div>
      </div>
    `;
  }

  private renderExternalPanel(): unknown {
    const abs = this.probe?.absPath ?? '';
    const video = this.probe?.videoCodec ?? '';
    const audio = this.probe?.audioCodec ?? '';
    const container = this.probe?.container ?? '';
    const videoOk = ['h264', 'vp8', 'vp9', 'av1'].includes(video);
    const audioOk = ['aac', 'mp3', 'opus', 'vorbis'].includes(audio);
    const blockers: string[] = [];
    if (video && !videoOk) blockers.push(`video codec ${video.toUpperCase()}`);
    if (audio && !audioOk) blockers.push(`audio codec ${audio.toUpperCase()}`);
    return html`
      <div class="external-panel">
        <div class="external-actions">
          <button
            class="back-btn"
            title="Back"
            @click=${(): void => this.onBackClick()}
          >${iconBackChevron()}</button>
          <h3 style="flex:1;">Open in external player</h3>
          <button
            class=${`back-btn report-btn report-${this.reportStatus}`}
            title=${this.reportStatusTitle()}
            ?disabled=${this.reportSending}
            @click=${(e: Event): void => {
              e.stopPropagation();
              void this.sendReport('player-external-manual');
            }}
          >${iconBug()}</button>
        </div>
        <p style="margin:0;color:#bbb;">
          ${blockers.length > 0
            ? html`Browser can't play this file: <strong style="color:#fff;">${blockers.join(' + ')}</strong>.`
            : html`This file uses codecs that don't play in the browser without re-encoding.`}
          Open the path below in VLC, IINA, or another desktop player.
        </p>
        ${video || audio || container
          ? html`
              <p style="margin:0;color:#888;font-family:monospace;font-size:12px;">
                ${container ? html`container: ${container}` : null}${container && (video || audio) ? ' · ' : ''}${video ? html`video: <span style=${videoOk ? 'color:#9c9;' : 'color:#fc9;'}>${video}</span>` : null}${(video) && audio ? ' · ' : ''}${audio ? html`audio: <span style=${audioOk ? 'color:#9c9;' : 'color:#fc9;'}>${audio}</span>` : null}
              </p>
            `
          : null}
        <input
          type="text"
          readonly
          .value=${abs}
          @click=${(e: Event): void => (e.target as HTMLInputElement).select()}
        />
      </div>
    `;
  }

  /** Test-facing alias preserved from 0.1.4. */
  private renderSubtitleMenu(): unknown {
    if (this.subs.length === 0) return null;
    return this.renderCcPopover();
  }
}
