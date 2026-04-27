import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  apiClientLog,
  apiLibrary,
  apiPlaybackGet,
  apiPlaybackPost,
  apiSeries,
  apiStreamDiagnostics,
  apiStreamMeta,
  apiStreamProbe,
  apiSubsList,
  embeddedSubsUrl,
  EmptyFileError,
  hlsBeaconUrl,
  hlsPlaylistUrl,
  resolveHlsPlayerFlag,
  ShareOfflineError,
  streamUrl,
  subsUrl,
} from '../api.js';
import { getConsoleBuffer } from '../console-buffer.js';
import type {
  AudioStream,
  Chapter,
  LibraryItem,
  StreamDiagnostics,
  StreamProbe,
  SubInfo,
  SubStream,
  Episode,
  SeriesDetail,
} from '../types.js';
import { goBack, homeHref, navigate, playHref, seriesHref } from '../router.js';
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

// v6: decision logic changed — AC3/EAC3/DTS audio is now `remux` (transcoded
// to AAC inline), so old `external` cache entries for those files are stale.
// v7: decide() promoted Xvid / MPEG-2 / VC-1 / etc. to 'remux' (with the
// preferAccel hint), so v6 cache entries that said `external` for these are
// stale. Also adds the preferAccel field to the cached shape.
// v8: 0.1.4.3 — probe now carries audioStreams/subStreams/chapters; older
// blobs lack the new fields, so bump the prefix to force a fresh probe.
// v9: 0.1.4.3 follow-up — direct-stream probes now also fetch full track +
// chapter info via /api/stream-diagnostics; v8 entries cached `{decision:'direct'}`
// without those fields and are stale.
const PROBE_CACHE_PREFIX = 'homemedia.streamProbe.v9:';

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

function readCachedProbe(relPath: string): StreamProbe | null {
  try {
    const raw = sessionStorage.getItem(PROBE_CACHE_PREFIX + relPath);
    if (!raw) return null;
    return JSON.parse(raw) as StreamProbe;
  } catch {
    return null;
  }
}

function writeCachedProbe(relPath: string, probe: StreamProbe): void {
  try {
    sessionStorage.setItem(PROBE_CACHE_PREFIX + relPath, JSON.stringify(probe));
  } catch {
    /* sessionStorage not available — fine, just skip caching */
  }
}

const FLUSH_INTERVAL_MS = 10_000;
const WATCHED_RATIO = 0.9;
const IDLE_TIMEOUT_MS = 3_000;
/** How long the stream can sit without producing bytes before we treat it as
 *  failed and fall through the playback strategy chain. The clock resets on
 *  every <video> progress event; only a true stall trips it.
 *
 *  A "metadata-load timeout" of 8s used to live here. That measured the wrong
 *  thing — Xvid → H.264 NVENC startup can spend 4-5s on demuxer probe + NVENC
 *  init *while bytes ARE arriving in the browser*, and tripping the timeout
 *  killed perfectly healthy streams. Stall detection (no progress for N seconds)
 *  catches dead streams without false positives on slow-but-progressing ones. */
const STREAM_STALL_TIMEOUT_MS = 15_000;
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
    .frame.idle { cursor: none; }
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
    .pip-row {
      padding: 4px 4px 0;
    }

    .error {
      position: absolute;
      inset: 0;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--error);
      color: var(--error);
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
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
  @state() private error: string | null = null;
  @state() private nativeControls = false;
  @state() private probe: StreamProbe | null = null;
  @state() private probing = false;
  /** 0.1.4.2 — diagnostic dump from `/api/stream-diagnostics/:relPath`.
   *  Lazily fetched when the info popover opens. */
  @state() private diagnostics: StreamDiagnostics | null = null;
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
  /** True iff the ffmpeg-args section in the info popover is expanded. */
  @state() private ffmpegArgsExpanded = false;
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
  /** Effective source mode. Distinct from `probe.decision`: starts at the
   *  decision but can be downgraded by the runtime fallback (e.g. remux ->
   *  nvenc when the browser can't decode HEVC). The legacy player uses
   *  direct/remux/nvenc/external; the HLS player path (D13) sets this to
   *  `'hls'` once mounted and never changes it during a session. */
  @state() private playMode: 'direct' | 'remux' | 'nvenc' | 'external' | 'hls' = 'direct';
  /** 0.1.6 D13 — true once we've decided this player instance uses HLS.
   *  Decided at mount from the cached share-status flag; never flips
   *  mid-playback. */
  @state() private useHls = false;
  /** 0.1.6 — server-issued session id from the playlist response header.
   *  Set after the first playlist fetch; used for the DELETE beacon on
   *  teardown and for sticky audio/sub respawns. */
  private hlsSessionId: string | null = null;
  /** 0.1.6 — handle to the live hls.js instance (only on browsers without
   *  native HLS support). null on Safari/iOS native HLS. */
  private hlsInstance: HlsLikeInstance | null = null;
  /** 0.1.6 — incremented on every HLS attach so a stale fetch landing late
   *  doesn't clobber the now-current attach. */
  private hlsAttachToken = 0;
  /** 0.1.6 — last URL we kicked off an HLS attach for. Lets us short-circuit
   *  redundant attaches when several `@state` fields change in quick
   *  succession but the resulting playlist URL is the same. */
  private hlsLastAttachUrl: string | null = null;
  /** 0.1.6 — coalesces the burst of `updated()` calls that fire when the
   *  HLS bootstrap completes. Without this we'd issue 15+ identical
   *  master.m3u8 fetches for a single mount. */
  private hlsAttachScheduled = false;
  /** True once we've already tried NVENC for this path. Prevents infinite retry. */
  private nvencTried = false;
  /** Stall watchdog. Set when the player is waiting for the stream to make
   *  progress; cleared once metadata loads OR the user dismisses the player.
   *  Re-armed on every `progress` event so a slow-but-progressing stream
   *  doesn't trip it. */
  private streamStallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Silent-decode watchdog. Some browser/codec combos (notably HEVC on
   *  Chromium-on-Mac without VideoToolbox MSE support) open the stream and
   *  play audio cleanly but never decode video — no `error` event fires, so
   *  the normal fallback chain never runs. We notice by comparing the video
   *  element's reported duration against the probe's known duration a few
   *  seconds after metadata loads; if the browser thinks the stream is far
   *  shorter than it actually is, that's the symptom. */
  private silentDecodeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferedRaf: number | null = null;
  private bufferedLastTick = 0;

  private clickTimer: ReturnType<typeof setTimeout> | null = null;

  private persister: PlaybackPersister | null = null;
  private watchedFired = false;
  private resumePosition = 0;
  private resumed = false;

  private get videoEl(): HTMLVideoElement | null {
    return this.renderRoot.querySelector('video');
  }
  private get gridEl(): HTMLElement | null {
    return this.renderRoot.querySelector('episode-grid');
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.nativeControls = new URLSearchParams(window.location.search).get(
      'nativeControls',
    ) === '1';
    this.persister = new PlaybackPersister(this.relPath);
    this.trace('connectedCallback', { relPath: this.relPath });
    void this.fetchResume();
    // 0.1.6 D13 — decide which player code path to take, once per mount.
    // The cached flag is populated by <share-banner>'s status poll (which
    // fires on app boot). resolveHlsPlayerFlag falls through to a fetch if
    // not cached — happens when the player is the first thing the app
    // touches (deep link, etc.).
    void resolveHlsPlayerFlag().then((on) => {
      this.trace('resolveHlsPlayerFlag', { hlsPlayer: on });
      if (on) {
        this.useHls = true;
        this.playMode = 'hls';
        void this.runHlsBootstrap();
      } else {
        void this.runPreProbe();
      }
    });
    void this.resolveTitleSource();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('click', this.onDocClick);
    // Start the idle timer once we're attached so chrome auto-hides even if no
    // mouse moves happen.
    this.kickIdleTimer();
  }

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
    // 0.1.6 — best-effort teardown so the server's idle GC doesn't have to
    // wait the full 60s window after a tab close.
    this.fireHlsBeacon();
    if (this.hlsInstance) {
      try { this.hlsInstance.destroy(); } catch { /* ignore */ }
      this.hlsInstance = null;
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
        // Tear down the prior HLS session before we forget its id.
        this.fireHlsBeacon();
        if (this.hlsInstance) {
          try { this.hlsInstance.destroy(); } catch { /* ignore */ }
          this.hlsInstance = null;
        }
        this.hlsLastAttachUrl = null;
        this.playMode = this.useHls ? 'hls' : 'direct';
        this.nvencTried = false;
        this.remuxTried = false;
        this.streamOffset = 0;
        this.seeking = false;
        this.pendingSeek = null;
        this.probedFor = null;
        this.bufferedPct = 0;
        this.clearStallTimer();
        this.clearSilentDecodeTimer();
        this.persister = new PlaybackPersister(this.relPath);
        this.movieMeta = null;
        this.libraryFetchedFor = null;
        this.diagnostics = null;
        this.failureLog = [];
        this.autoReportedExternalFor = null;
        void this.fetchResume();
        if (this.useHls) {
          void this.runHlsBootstrap();
        } else {
          void this.runPreProbe();
        }
        void this.resolveTitleSource();
      }
    }
    if (changed.has('subs')) {
      // After the <track> elements (re-)render, push the active selection through.
      this.applyActiveSubtitle();
    }
    const urlAffectingChange =
      changed.has('playMode') ||
      changed.has('probe') ||
      changed.has('streamOffset') ||
      changed.has('activeAudioIndex') ||
      changed.has('activeBurnSubIndex');
    if (urlAffectingChange) {
      // Whenever the source URL might have changed (mode swap, fresh probe,
      // or scrub-restart) force <video> to reload its src.
      const v = this.videoEl;
      if (v && (this.playMode === 'direct' || this.playMode === 'remux' || this.playMode === 'nvenc')) {
        v.load();
        this.kickStallTimer();
      }
      if (v && this.playMode === 'hls') {
        this.scheduleHlsAttach();
      }
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

  // ---------- stall watchdog ----------

  /** Arm or re-arm the stall watchdog. Called on `loadstart` and on every
   *  `progress` event from <video>; the latter is what keeps slow-but-healthy
   *  streams alive (each chunk arriving resets the clock). */
  private kickStallTimer(): void {
    if (this.streamStallTimer !== null) clearTimeout(this.streamStallTimer);
    this.streamStallTimer = setTimeout(() => {
      this.streamStallTimer = null;
      const v = this.videoEl;
      // HAVE_METADATA = 1; if we already passed that, the stream is fine —
      // any later stalls are normal "buffering" and the browser handles them.
      if (!v || v.readyState >= 1) return;
      this.recordFailure('stream-stall');
      this.handlePlaybackFailure('stream-stall');
    }, STREAM_STALL_TIMEOUT_MS);
  }

  private clearStallTimer(): void {
    if (this.streamStallTimer !== null) {
      clearTimeout(this.streamStallTimer);
      this.streamStallTimer = null;
    }
  }

  /** Arm the silent-decode watchdog. Only meaningful for ffmpeg-piped modes
   *  (remux/nvenc) where the probe carries the true source duration; direct
   *  range-served files don't need it. Skipped when the source is short
   *  (<60s) — the watchdog's signal-to-noise breaks down at that scale.
   *
   *  Signal: `videoEl.videoWidth === 0` while audio is advancing. A healthy
   *  decode populates `videoWidth` to the source resolution as soon as the
   *  first frame paints; the silent-decode pathology (audio plays, video
   *  never decodes — HEVC on Chromium without VideoToolbox, etc.) leaves
   *  `videoWidth` at 0 forever. Pairing that with `currentTime` advance
   *  ensures we don't trip on genuinely paused / not-yet-started streams.
   *  Buffered-progress was the prior signal but was too noisy: slow ramps
   *  from NVENC at 1080p look like "stuck" early on. */
  private armSilentDecodeWatchdog(): void {
    this.clearSilentDecodeTimer();
    if (this.playMode !== 'remux' && this.playMode !== 'nvenc') return;
    const probeDur = this.probe?.durationSeconds ?? 0;
    if (probeDur < 60) return;

    const SILENT_DECODE_POLL_MS = 2_000;
    /** Minimum currentTime advance before we trust audio is really moving. */
    const MIN_AUDIO_ADVANCE_S = 3;
    /** Max wait from arm time before we stop polling. */
    const ABSOLUTE_CAP_MS = 60_000;
    /** Once these conditions hold simultaneously for this long, trip:
     *  videoWidth === 0 AND currentTime has advanced ≥ MIN_AUDIO_ADVANCE_S
     *  since arm. Padding past the audio-advance threshold so we don't
     *  trip the moment audio crosses 3s (still possibly within startup). */
    const TRIP_AFTER_MS = 15_000;

    const startedAt = Date.now();
    const startCurrentTime = this.videoEl?.currentTime ?? 0;

    const poll = (): void => {
      this.silentDecodeTimer = null;
      const v = this.videoEl;
      if (!v) return;

      const now = Date.now();
      const elapsedMs = now - startedAt;
      const audioAdvance = v.currentTime - startCurrentTime;
      const videoWidth = v.videoWidth | 0;

      // The kill condition: we've waited long enough AND audio has clearly
      // started AND no video frame ever populated videoWidth. That means
      // the demuxer accepted the stream but the decoder never produced a
      // frame — exactly the "audio plays, screen black" pathology.
      if (
        elapsedMs >= TRIP_AFTER_MS &&
        audioAdvance >= MIN_AUDIO_ADVANCE_S &&
        videoWidth === 0
      ) {
        // eslint-disable-next-line no-console
        console.warn('[media-player] silent decode failure', {
          playMode: this.playMode,
          videoCodec: this.probe?.videoCodec,
          videoWidth,
          videoHeight: v.videoHeight,
          audioAdvance,
          elapsedMs,
          streamOffset: this.streamOffset,
        });
        this.recordFailure('silent-decode');
        this.handlePlaybackFailure('silent-decode');
        return;
      }

      // Once a video frame paints, we're done — the decoder works for this
      // stream, no point polling further.
      if (videoWidth > 0) return;

      if (elapsedMs >= ABSOLUTE_CAP_MS) return;
      this.silentDecodeTimer = setTimeout(poll, SILENT_DECODE_POLL_MS);
    };

    this.silentDecodeTimer = setTimeout(poll, SILENT_DECODE_POLL_MS);
  }

  private clearSilentDecodeTimer(): void {
    if (this.silentDecodeTimer !== null) {
      clearTimeout(this.silentDecodeTimer);
      this.silentDecodeTimer = null;
    }
  }

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
  private initialPlayMode(probe: StreamProbe): 'direct' | 'remux' | 'nvenc' | 'external' {
    if (probe.decision === 'remux' && probe.preferAccel === 'nvenc' && probe.accel?.nvenc) {
      // Mark NVENC as already-tried so a later <video> error doesn't try to
      // re-trigger the same path it's already on.
      this.nvencTried = true;
      return 'nvenc';
    }
    return probe.decision;
  }

  private async runPreProbe(): Promise<void> {
    if (this.probedFor === this.relPath) return; // already probed (or in flight) for this path
    this.probedFor = this.relPath;

    const cached = readCachedProbe(this.relPath);
    if (cached) {
      this.probe = cached;
      this.subs = cached.subs;
      this.nvencTried = false;
      this.remuxTried = false;
      this.playMode = this.initialPlayMode(cached);
      this.applyStickyPrefs(cached);
      this.applyResumeOffset();
      if (cached.decision === 'direct') {
        void this.fetchDirectSubs();
      }
      return;
    }
    this.probing = true;
    try {
      const probe = await apiStreamProbe(this.relPath);
      this.probe = probe;
      this.subs = probe.subs;
      this.nvencTried = false;
      this.remuxTried = false;
      this.playMode = this.initialPlayMode(probe);
      this.applyStickyPrefs(probe);
      this.applyResumeOffset();
      writeCachedProbe(this.relPath, probe);
      if (probe.decision === 'direct') void this.fetchDirectSubs();
    } catch (err) {
      if (err instanceof ShareOfflineError) {
        this.error = 'Stream unavailable — desktop appears to be offline. Reconnect from the banner above.';
      } else if (err instanceof EmptyFileError) {
        this.error = 'This file is empty (0 bytes) — likely an incomplete download. Finish the download or remove the file, then re-scan the library.';
      } else {
        this.error = `Stream unavailable: ${(err as Error).message}`;
      }
    } finally {
      this.probing = false;
    }
  }

  /** 0.1.6 — fetch read-only stream metadata (audio streams, sub streams,
   *  chapters, sibling subs) for the HLS player UI. Stuffs the data into
   *  the existing `probe` slot so the popover/scrubber rendering paths
   *  don't need a parallel state shape. */
  private async runHlsBootstrap(): Promise<void> {
    if (this.probedFor === this.relPath) {
      this.trace('runHlsBootstrap.skip', { reason: 'already probed', probedFor: this.probedFor });
      return;
    }
    this.trace('runHlsBootstrap.start', { relPath: this.relPath });
    this.probedFor = this.relPath;
    this.probing = true;
    try {
      // 0.1.7 — fetch stream-meta + the playback resume position in
      // parallel, but AWAIT BOTH before deciding the playlist URL.
      //
      // Race we're avoiding: connectedCallback() kicks off `fetchResume()`
      // and `runHlsBootstrap()` separately. If runHlsBootstrap reaches
      // `attachHlsToVideo()` before `fetchResume` has populated
      // `resumePosition`, the playlist URL is built with no `?start=`,
      // ffmpeg spawns at source-t=0, and segments cover stream-local
      // [0, 7.5s]. fetchResume then lands, sees no videoEl-but-not-resumed
      // window... actually that's safe. But if fetchResume lands AFTER the
      // <video> element renders but BEFORE runHlsBootstrap sets
      // `resumed=true`, fetchResume sets `v.currentTime = 113` on a video
      // whose MSE buffer only holds [0, 7.5s] — DEMUXER error on the
      // first parse pass.
      //
      // Cleanest fix: seed resumePosition here from the playback API,
      // synchronously decide streamOffset, then attach. fetchResume can
      // run in parallel for tooltip/UI seeding but doesn't drive the URL.
      const [meta, pb] = await Promise.all([
        apiStreamMeta(this.relPath),
        apiPlaybackGet(this.relPath).catch(() => ({ position: 0, duration: 0, watched: false })),
      ]);
      this.trace('runHlsBootstrap.fetched', {
        videoCodec: meta.videoCodec,
        audioCodec: meta.audioCodec,
        durationSeconds: meta.durationSeconds,
        playbackPosition: pb.position,
        playbackWatched: pb.watched,
      });
      // Seed resumePosition before any URL-building logic reads it.
      if (typeof pb.position === 'number' && pb.position > 0) {
        this.resumePosition = pb.position;
      }
      const probeShape: StreamProbe = {
        decision: 'remux',
        subs: meta.subs,
        durationSeconds: meta.durationSeconds,
        container: meta.container,
        videoCodec: meta.videoCodec,
        audioCodec: meta.audioCodec,
        audioStreams: meta.audioStreams,
        subStreams: meta.subStreams,
        chapters: meta.chapters,
      };
      this.probe = probeShape;
      this.subs = meta.subs;
      this.applyStickyPrefs(probeShape);
      // For HLS the server handles the resume offset via `?start=`, so seed
      // streamOffset on apply and let buildHlsStreamSrc include it.
      if (this.resumePosition > 0 && !this.resumed) {
        this.streamOffset = this.resumePosition;
        this.currentTime = this.resumePosition;
        this.resumed = true;
        this.trace('runHlsBootstrap.appliedResume', { streamOffset: this.streamOffset });
      } else {
        this.trace('runHlsBootstrap.noResume', { resumePosition: this.resumePosition, resumed: this.resumed });
      }
      // Trigger a render — `updated()` will see the playMode/probe change
      // and `attachHlsToVideo` will fire when the <video> element shows up.
      this.requestUpdate();
    } catch (err) {
      this.trace('runHlsBootstrap.error', { err: String((err as Error)?.message ?? err) });
      if (err instanceof ShareOfflineError) {
        this.error = 'Stream unavailable — desktop appears to be offline. Reconnect from the banner above.';
      } else {
        this.error = `Stream unavailable: ${(err as Error).message}`;
      }
    } finally {
      this.probing = false;
    }
  }

  /** 0.1.6 — Build the HLS playlist URL with the current sticky audio/sub
   *  selection and resume offset baked in. */
  private buildHlsStreamSrc(): string {
    const opts: { startSeconds?: number; audioStreamIndex?: number; burnSubStreamIndex?: number } = {};
    if (this.streamOffset > 0) opts.startSeconds = Math.floor(this.streamOffset);
    if (this.activeAudioIndex !== null) opts.audioStreamIndex = this.activeAudioIndex;
    if (this.activeBurnSubIndex !== null) opts.burnSubStreamIndex = this.activeBurnSubIndex;
    return hlsPlaylistUrl(this.relPath, opts);
  }

  /** 0.1.6 — Coalesce the burst of state changes that the bootstrap +
   *  hls.js attach fire into a single attach per microtask. Without this,
   *  a single player mount would issue 10+ identical master.m3u8 fetches
   *  (each `@state` change triggers `updated()` which fires the attach). */
  private scheduleHlsAttach(): void {
    if (this.hlsAttachScheduled) {
      this.trace('scheduleHlsAttach.alreadyScheduled');
      return;
    }
    this.hlsAttachScheduled = true;
    this.trace('scheduleHlsAttach.queue');
    queueMicrotask(() => {
      this.hlsAttachScheduled = false;
      const v = this.videoEl;
      if (!v || this.playMode !== 'hls') {
        this.trace('scheduleHlsAttach.skip', { hasVideo: !!v, playMode: this.playMode });
        return;
      }
      const url = this.buildHlsStreamSrc();
      // If the playlist URL hasn't actually changed since the last attach,
      // skip — the live session is already serving the right stream.
      if (url === this.hlsLastAttachUrl && this.hlsSessionId !== null) {
        this.trace('scheduleHlsAttach.unchanged', { url });
        return;
      }
      this.trace('scheduleHlsAttach.respawn', {
        prevUrl: this.hlsLastAttachUrl,
        nextUrl: url,
        prevSessionId: this.hlsSessionId,
      });
      // Tear down any previous HLS session before reattaching with the
      // new params (audio track switch, burn-in sub, scrub-restart).
      this.fireHlsBeacon();
      if (this.hlsInstance) {
        try { this.hlsInstance.destroy(); } catch { /* ignore */ }
        this.hlsInstance = null;
      }
      void this.attachHlsToVideo();
    });
  }

  /** 0.1.6 — Attach the HLS playlist to the <video> element. Native first
   *  (Safari/iOS), hls.js fallback otherwise. The session id is captured
   *  from the playlist response header and used for the cleanup beacon. */
  private async attachHlsToVideo(): Promise<void> {
    const v = this.videoEl;
    if (!v) {
      this.trace('attachHlsToVideo.noVideoEl');
      return;
    }
    const token = ++this.hlsAttachToken;
    const url = this.buildHlsStreamSrc();
    this.hlsLastAttachUrl = url;
    this.trace('attachHlsToVideo.start', { token, url });

    // Tear down any prior hls.js instance first.
    if (this.hlsInstance) {
      try { this.hlsInstance.destroy(); } catch { /* ignore */ }
      this.hlsInstance = null;
    }

    // Pre-fetch the playlist so we can capture the session id from the
    // response header. Native HLS in Safari fetches via the <video>
    // element's internal loader, which doesn't expose response headers
    // through a JS API — going through fetch() first gives us the header
    // and then sets src= which Safari serves from its own cache anyway.
    let sessionId: string | null = null;
    try {
      const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/vnd.apple.mpegurl' } });
      this.trace('attachHlsToVideo.preflightResponse', { status: r.status, sessionId: r.headers.get('x-hls-session-id') });
      if (r.ok) {
        sessionId = r.headers.get('x-hls-session-id');
        // Drain to free the connection — we don't need the body, the
        // <video> / hls.js fetch will re-fetch.
        try { await r.text(); } catch { /* ignore */ }
      } else if (r.status === 415) {
        const body = (await r.json().catch(() => ({}))) as { decision?: string; absPath?: string; error?: string };
        // 0.1.7 — graceful recovery: when the burn-in target is image-based,
        // ffmpeg's filter graph fails. The server pre-flight rejects with
        // `burn_image_sub_unsupported`; we drop the sticky pref + retry
        // without burn-in instead of forcing the user into the external
        // player just because of a sub track they once picked.
        if (body.error === 'burn_image_sub_unsupported' && this.activeBurnSubIndex !== null) {
          if (this.hlsAttachToken !== token) return;
          this.trace('attachHlsToVideo.burnImageRetry', { droppedBurnIndex: this.activeBurnSubIndex });
          this.activeBurnSubIndex = null;
          // Wipe the sticky pref so this doesn't re-fire on the next mount.
          try { sessionStorage.removeItem('homemedia.subPref.v1:' + this.relPath); } catch { /* ignore */ }
          // Re-render — `updated()` will see activeBurnSubIndex change and
          // re-fire scheduleHlsAttach with a clean URL.
          this.requestUpdate();
          return;
        }
        if (body.decision === 'external') {
          if (this.hlsAttachToken !== token) return;
          this.playMode = 'external';
          if (body.absPath && this.probe) {
            this.probe = { ...this.probe, absPath: body.absPath };
          }
          return;
        }
        this.error = `Stream unavailable (${r.status})`;
        return;
      } else {
        this.error = `Stream unavailable (${r.status})`;
        return;
      }
    } catch (err) {
      this.error = `Stream unavailable: ${(err as Error).message}`;
      return;
    }
    if (this.hlsAttachToken !== token) {
      this.trace('attachHlsToVideo.tokenStale.afterPreflight', { token, current: this.hlsAttachToken });
      return;
    }
    this.hlsSessionId = sessionId;

    // 0.1.7 — Native-HLS gate.
    //
    // `canPlayType('application/vnd.apple.mpegurl')` is famously unreliable
    // on Chrome. Desktop Chrome returns `'maybe'` for this MIME despite NOT
    // having a working native HLS pipeline — it'll set `v.src`, fetch the
    // playlist, fetch a few segments, then bail with
    // DEMUXER_ERROR_COULD_NOT_PARSE on segment boundaries. Trusting
    // canPlayType alone is what was breaking every HEVC playback on
    // Windows Chrome in this project.
    //
    // Real native HLS lives only on Safari/iOS. We restrict the native
    // path to:
    //   - canPlayType returns 'probably' (the strongest claim), AND
    //   - the UA is Safari (and not Chrome/Edge spoofing as such)
    //
    // Everything else takes the hls.js fallback path, which Just Works
    // across Chrome/Firefox/Edge.
    const native = v.canPlayType('application/vnd.apple.mpegurl');
    const ua = navigator.userAgent;
    const isSafari = /Safari\//.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua);
    const useNative = native === 'probably' && isSafari;
    this.trace('attachHlsToVideo.detectNative', { canPlayType: native, isSafari, useNative });

    if (useNative) {
      // Native HLS (Safari, iOS).
      this.trace('attachHlsToVideo.native', { url, sessionId });
      v.src = url;
      v.load();
      this.kickStallTimer();
      // The `autoplay` attribute is honored on initial load only; an episode
      // switch reuses the <video> element and won't auto-fire unless we ask.
      // Swallow the well-known AbortError that fires when this races a
      // subsequent source swap (see console-buffer's filter).
      try { await v.play(); } catch (err) {
        this.trace('attachHlsToVideo.native.playReject', { name: (err as Error)?.name, message: (err as Error)?.message });
      }
      return;
    }

    // hls.js fallback — lazy import so non-Safari browsers only pay the
    // ~30KB bundle when they actually need it.
    try {
      const mod = await import('hls.js');
      if (this.hlsAttachToken !== token) {
        this.trace('attachHlsToVideo.tokenStale.afterImport', { token, current: this.hlsAttachToken });
        return;
      }
      const HlsCtor = (mod as { default: HlsLike }).default;
      if (!HlsCtor.isSupported()) {
        this.trace('attachHlsToVideo.unsupported');
        this.error = 'Your browser does not support HLS playback.';
        return;
      }
      const hls = new HlsCtor({}) as unknown as HlsLikeInstance;
      // 0.1.7 — surface every hls.js event into the trace log so we can see
      // what hls.js was doing right before any failure.
      this.attachHlsJsEventLogging(hls, sessionId ?? '?');
      hls.loadSource(url);
      hls.attachMedia(v);
      this.hlsInstance = hls;
      this.trace('attachHlsToVideo.hlsjs', { url, sessionId });
      this.kickStallTimer();
      // Same as the native path: re-trigger play() since `autoplay` is only
      // honored on the element's first load.
      try { await v.play(); } catch (err) {
        this.trace('attachHlsToVideo.hlsjs.playReject', { name: (err as Error)?.name, message: (err as Error)?.message });
      }
    } catch (err) {
      this.trace('attachHlsToVideo.error', { err: String((err as Error)?.message ?? err) });
      this.error = `Failed to load HLS player: ${(err as Error).message}`;
    }
  }

  /** Bind comprehensive event listeners on an hls.js instance. We use the
   *  string event names (`'hlsError'`, `'hlsManifestLoaded'`, etc.) rather
   *  than the typed `Hls.Events` enum so the dynamic-import shape stays
   *  loose. Any data hls.js passes is recorded into the trace. */
  private attachHlsJsEventLogging(hls: HlsLikeInstance, sessionId: string): void {
    const events: Array<{ name: string; level: 'info' | 'warn' }> = [
      { name: 'hlsMediaAttached', level: 'info' },
      { name: 'hlsMediaDetached', level: 'info' },
      { name: 'hlsManifestLoading', level: 'info' },
      { name: 'hlsManifestLoaded', level: 'info' },
      { name: 'hlsManifestParsed', level: 'info' },
      { name: 'hlsLevelLoading', level: 'info' },
      { name: 'hlsLevelLoaded', level: 'info' },
      { name: 'hlsLevelUpdated', level: 'info' },
      { name: 'hlsFragLoading', level: 'info' },
      { name: 'hlsFragLoaded', level: 'info' },
      { name: 'hlsFragChanged', level: 'info' },
      { name: 'hlsBufferAppending', level: 'info' },
      { name: 'hlsBufferAppended', level: 'info' },
      { name: 'hlsBufferEos', level: 'info' },
      { name: 'hlsBufferFlushing', level: 'info' },
      { name: 'hlsBufferFlushed', level: 'info' },
      { name: 'hlsError', level: 'warn' },
      { name: 'hlsDestroying', level: 'warn' },
    ];
    for (const { name } of events) {
      try {
        hls.on?.(name, (...args: unknown[]) => {
          // hls.js typically passes (event, data). Pull the most useful bits
          // without snapshotting megabytes of fragment payload.
          const data = args[1] as Record<string, unknown> | undefined;
          const slim: Record<string, unknown> = { sessionId };
          if (data && typeof data === 'object') {
            for (const k of ['type', 'details', 'fatal', 'reason', 'frag', 'level', 'url', 'stats', 'response', 'error']) {
              if (k in data) {
                const v = (data as Record<string, unknown>)[k];
                // `frag` is a heavy object — pull just the identity bits.
                if (k === 'frag' && v && typeof v === 'object') {
                  const f = v as Record<string, unknown>;
                  slim[k] = { sn: f.sn, level: f.level, url: f.url, start: f.start, duration: f.duration };
                } else if (k === 'stats' && v && typeof v === 'object') {
                  const s = v as Record<string, unknown>;
                  slim[k] = { loaded: s.loaded, total: s.total };
                } else if (typeof v !== 'function') {
                  slim[k] = v;
                }
              }
            }
          }
          this.trace(`hls.${name.replace(/^hls/, '').toLowerCase()}`, slim);
        });
      } catch { /* hls.js shape mismatch — best-effort */ }
    }
  }

  /** 0.1.6 — Best-effort DELETE beacon for the current HLS session. Called
   *  on disconnect / pagehide and before respawning the session for a new
   *  audio/sub selection. */
  private fireHlsBeacon(): void {
    const id = this.hlsSessionId;
    if (!id) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(hlsBeaconUrl(id));
      }
    } catch { /* best-effort */ }
    this.hlsSessionId = null;
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

  private async fetchDirectSubs(): Promise<void> {
    // 0.1.4.3 — for direct streams the 200-OK pre-probe doesn't carry
    // audioStreams / subStreams / chapters; the 415 body that the player
    // gets for remux/external sources does. Fetch them via the diagnostics
    // endpoint instead so the audio popover, embedded-sub picker, and
    // chapter ticks all have data to render against.
    const [subsResult, diagResult] = await Promise.allSettled([
      apiSubsList(this.relPath),
      apiStreamDiagnostics(this.relPath),
    ]);
    const subs = subsResult.status === 'fulfilled' ? subsResult.value : [];
    const diag = diagResult.status === 'fulfilled' ? diagResult.value : null;
    if (!this.probe) return;
    const next: StreamProbe = { ...this.probe };
    if (subs.length > 0) {
      next.subs = subs;
      this.subs = subs;
    }
    if (diag) {
      const p = diag.probe;
      if (p.container) next.container = p.container;
      if (p.videoCodec) next.videoCodec = p.videoCodec;
      if (p.audioCodec) next.audioCodec = p.audioCodec;
      if (typeof p.durationSeconds === 'number' && p.durationSeconds > 0) {
        next.durationSeconds = p.durationSeconds;
      }
      if (p.audioStreams && p.audioStreams.length > 0) next.audioStreams = p.audioStreams;
      if (p.subStreams && p.subStreams.length > 0) next.subStreams = p.subStreams;
      if (p.chapters && p.chapters.length > 0) next.chapters = p.chapters;
    }
    this.probe = next;
    writeCachedProbe(this.relPath, next);
    // Re-apply sticky prefs now that audioStreams / subStreams are known.
    this.applyStickyPrefs(next);
    this.requestUpdate();
  }

  private async fetchResume(): Promise<void> {
    this.trace('fetchResume.start');
    try {
      const pb = await apiPlaybackGet(this.relPath);
      this.trace('fetchResume.fetched', { position: pb.position, duration: pb.duration, watched: pb.watched });
      this.resumePosition = pb.position;
      this.applyResumeOffset();
      const v = this.videoEl;
      // 0.1.7 — for HLS, the resume offset rides in the playlist URL as
      // `?start=N`; the player's <video> element runs on a STREAM-LOCAL
      // timeline starting at 0. Setting `v.currentTime = pb.position`
      // here would seek the element to source-time-N in a buffer that
      // only covers stream-local [0, target-duration*N]. MSE then fails
      // with DEMUXER_ERROR_COULD_NOT_PARSE because there's no presentable
      // picture at that timestamp. Skip the direct seek for HLS; the
      // `runHlsBootstrap` path has already seeded streamOffset.
      if (this.playMode === 'hls') {
        this.trace('fetchResume.skipForHls');
        return;
      }
      if (v && v.readyState >= 1 && !this.resumed && pb.position > 0) {
        this.trace('fetchResume.directSeek', { position: pb.position, readyState: v.readyState });
        v.currentTime = pb.position;
        this.resumed = true;
      } else {
        this.trace('fetchResume.skipDirectSeek', {
          hasVideo: !!v, readyState: v?.readyState, resumed: this.resumed, position: pb.position,
        });
      }
    } catch (err) {
      this.trace('fetchResume.error', { err: String((err as Error)?.message ?? err) });
      if (err instanceof ShareOfflineError) {
        // Continue without resume; the stream itself will surface the offline error.
      }
    }
  }

  /** True duration we trust for the scrubber. */
  private resolveDuration(videoDuration: number): number {
    const probed = this.probe?.durationSeconds;
    const fromServer = typeof probed === 'number' && probed > 0 ? probed : 0;
    if (this.playMode === 'remux' || this.playMode === 'nvenc') {
      if (fromServer > 0) return fromServer;
    }
    // 0.1.6 — for HLS the server starts ffmpeg at streamOffset, so the
    // <video>.duration would be (totalDuration - streamOffset) and tries to
    // scrub-to-end based on that look like prematurely ending. Trust the
    // probe duration whenever it's known.
    if (this.playMode === 'hls' && fromServer > 0) return fromServer;
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
    if (this.playMode !== 'remux' && this.playMode !== 'nvenc' && this.playMode !== 'hls') return;

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

  /** Build the `<video src>` for the current playMode + streamOffset. */
  private buildStreamSrc(): string {
    const base = streamUrl(this.relPath);
    const params = new URLSearchParams();
    if (this.playMode === 'nvenc') params.set('accel', 'nvenc');
    else if (this.playMode === 'remux') params.set('remux', 'true');
    if (this.streamOffset > 0 && (this.playMode === 'remux' || this.playMode === 'nvenc')) {
      params.set('start', String(Math.floor(this.streamOffset)));
    }
    // 0.1.4.3 — audio-track override and burn-in subtitle. The route
    // transparently upgrades a `direct` source to a remux when `audio=` is
    // set, so we send the param even on direct-mode plays.
    if (this.activeAudioIndex !== null && (this.playMode === 'remux' || this.playMode === 'nvenc' || this.playMode === 'direct')) {
      params.set('audio', String(this.activeAudioIndex));
      // Direct → remux upgrade so the override is honored.
      if (this.playMode === 'direct') params.set('remux', 'true');
    }
    if (this.activeBurnSubIndex !== null) {
      params.set('burnSub', String(this.activeBurnSubIndex));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private onTimeUpdate = (): void => {
    const v = this.videoEl;
    if (!v || !this.persister) return;
    const absolute = this.absoluteTime(v);
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
    // Bytes are arriving — reset the stall watchdog. Done eagerly (not in the
    // throttled rAF below) so even a slow stream that hasn't loaded metadata
    // yet but IS making progress doesn't trip the watchdog.
    if (this.streamStallTimer !== null) this.kickStallTimer();
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
    // Also surface in the regular console (caught by console-buffer.ts).
    // eslint-disable-next-line no-console
    console.info(`[player] ${tag}`, data ?? '');
  }

  /** Snapshot of state useful for context lines next to a video event. */
  private playerSnapshot(): Record<string, unknown> {
    const v = this.videoEl;
    return {
      playMode: this.playMode,
      streamOffset: this.streamOffset,
      currentTime: this.currentTime,
      paused: this.paused,
      seeking: this.seeking,
      resumed: this.resumed,
      resumePosition: this.resumePosition,
      hlsSessionId: this.hlsSessionId,
      hlsLastAttachUrl: this.hlsLastAttachUrl,
      hlsAttachToken: this.hlsAttachToken,
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

  private onPlay = (): void => {
    this.paused = false;
    this.trace('video.play', this.playerSnapshot());
  };
  private onPause = (): void => {
    this.paused = true;
    this.trace('video.pause', this.playerSnapshot());
    const v = this.videoEl;
    if (v && this.persister && this.duration > 0) {
      this.persister.flushNow(this.absoluteTime(v), this.duration);
    }
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
          if (this.playMode === 'remux' || this.playMode === 'nvenc') {
            this.streamOffset = absoluteNow;
            this.pendingSeek = absoluteNow;
            this.seeking = true;
            this.requestUpdate();
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
    // 0.1.6 — HLS has no fallback chain (universal format is the whole point).
    // hls.js handles its own buffer-stall recovery; a hard <video> error here
    // means the file is genuinely unplayable and the right answer is to
    // surface the external-player handoff.
    if (this.playMode === 'hls') {
      this.playMode = 'external';
      return;
    }
    this.handlePlaybackFailure('video-error');
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

  /** Track whether we tried plain remux too (separate from nvencTried so the
   *  fallback chain works in either entry order: nvenc-first via preferAccel
   *  can still fall back to remux, or remux-first can fall forward to nvenc). */
  private remuxTried = false;

  /** Drives the playback fallback chain. The chain is order-agnostic — wherever
   *  we are now, try the OTHER strategy if we haven't yet, else go external. */
  private handlePlaybackFailure(reason: 'video-error' | 'stream-stall' | 'silent-decode'): void {
    this.clearStallTimer();
    this.clearSilentDecodeTimer();

    // eslint-disable-next-line no-console
    console.warn('[media-player] playback failure', {
      reason,
      playMode: this.playMode,
      remuxTried: this.remuxTried,
      nvencTried: this.nvencTried,
      preferAccel: this.probe?.preferAccel,
      accelAvailable: this.probe?.accel?.nvenc,
    });

    // Mark whatever we just tried as exhausted.
    if (this.playMode === 'remux') this.remuxTried = true;
    if (this.playMode === 'nvenc') this.nvencTried = true;

    // Forward fallback: remux → nvenc.
    if (
      this.playMode === 'remux' &&
      !this.nvencTried &&
      this.probe?.accel?.nvenc
    ) {
      this.playMode = 'nvenc';
      return;
    }

    // Reverse fallback: nvenc → remux. Only safe when the server didn't
    // explicitly mark the source as `preferAccel: nvenc`. For preferAccel
    // sources the server has already decided remux can't work (e.g. Xvid in
    // AVI), and `-c:v copy` produces an MP4 the browser silently treats as
    // audio-only — worse than a clean external-player handoff. Sources that
    // fell into nvenc without a preferAccel hint (e.g. a clean h264 source
    // that hit a transient nvenc error) can still try plain remux.
    if (
      this.playMode === 'nvenc' &&
      !this.remuxTried &&
      this.probe?.decision === 'remux' &&
      this.probe?.preferAccel !== 'nvenc'
    ) {
      this.playMode = 'remux';
      return;
    }

    // Both pipelines exhausted (or none available) → external player.
    if (this.probe) {
      this.playMode = 'external';
      return;
    }

    this.error =
      'Stream unavailable — desktop appears to be offline. Reconnect from the banner above.';
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
    // 0.1.6 — drop the HLS session server-side so the cache dir gets cleaned
    // up immediately rather than waiting for the 60s idle GC.
    this.fireHlsBeacon();
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

  /** Close any open popover when the click landed outside the player. */
  private onDocClick = (e: MouseEvent): void => {
    if (this.openPopover === null) return;
    const path = e.composedPath();
    // Anything inside the player frame is "inside" — popovers + triggers handle
    // their own toggling via stopPropagation in their click handlers.
    if (path.includes(this)) return;
    this.openPopover = null;
  };

  /** Whether `targetAbs` lies inside the current ffmpeg pipe's buffered range. */
  private isInBuffer(targetAbs: number): boolean {
    const v = this.videoEl;
    if (!v) return false;
    if (this.playMode === 'direct') return true;
    // 0.1.6 — HLS uses absolute source-seconds (ffmpeg starts at
    // streamOffset and writes from there; the player's currentTime is
    // local-to-the-stream too). Same calculation works.
    const local = targetAbs - this.streamOffset;
    if (local < 0) return false;
    const ranges = v.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (local >= ranges.start(i) && local <= ranges.end(i)) return true;
    }
    return false;
  }

  /** True when the current playMode lets us seek by setting v.currentTime
   *  to the absolute source-second rather than translating through
   *  streamOffset. Only `direct` qualifies — for that path the <video>
   *  fetches the original file and its currentTime IS the absolute time.
   *  Remux/nvenc/hls all encode from `?start=streamOffset`, so the player's
   *  currentTime is local to that stream and seeks in absolute coordinates
   *  must subtract streamOffset (or respawn when outside the encoded window). */
  private isInPlaceSeekMode(): boolean {
    return this.playMode === 'direct';
  }

  private onScrubInput(e: Event): void {
    const v = this.videoEl;
    if (!v) return;
    const t = Number((e.target as HTMLInputElement).value);
    this.pendingSeek = t;
    this.currentTime = t;
    if (this.isInBuffer(t)) {
      v.currentTime = this.isInPlaceSeekMode() ? t : t - this.streamOffset;
    }
  }

  private onScrubCommit(e: Event): void {
    const v = this.videoEl;
    if (!v) return;
    const t = Number((e.target as HTMLInputElement).value);
    const inBuffer = this.isInBuffer(t);
    this.trace('onScrubCommit', { target: t, inBuffer, playMode: this.playMode, streamOffset: this.streamOffset });
    if (inBuffer) {
      v.currentTime = this.isInPlaceSeekMode() ? t : t - this.streamOffset;
      this.pendingSeek = null;
      this.currentTime = t;
      return;
    }
    // Out of buffer: respawn the encoded stream at the new offset. Same
    // path for HLS, remux, and nvenc — all three put `?start=N` on the
    // server side, which makes the new <video>.currentTime origin t=0.
    if (this.playMode === 'hls' || this.playMode === 'remux' || this.playMode === 'nvenc') {
      this.trace('onScrubCommit.respawn', { newStreamOffset: t });
      this.pendingSeek = t;
      this.streamOffset = t;
      this.currentTime = t;
      this.seeking = true;
      this.requestUpdate();
    }
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
    // Lazy-fetch diagnostics the first time the info popover opens for this
    // path. The endpoint is read-only — no ffmpeg spawn.
    if (key === 'info' && this.openPopover === 'info' && !this.diagnostics) {
      void this.fetchDiagnostics();
    }
  }

  private async fetchDiagnostics(): Promise<void> {
    const target = this.relPath;
    try {
      const d = await apiStreamDiagnostics(target);
      // Discard if the path changed mid-flight.
      if (this.relPath === target) this.diagnostics = d;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[media-player] diagnostics fetch failed', err);
    }
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
    if (!v?.requestPictureInPicture) return;
    void v.requestPictureInPicture().catch(() => {});
    this.openPopover = null;
  }

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
    if (this.error) {
      return html`<div class="error">${this.error}</div>`;
    }
    if (this.probing || !this.probe) {
      return html`<div class="loading-panel">Checking playback…</div>`;
    }
    if (this.playMode === 'external') {
      return this.renderExternalPanel();
    }
    // HLS: <video> has no src= in the template — attachHlsToVideo() either
    // sets v.src (Safari native) or hands the element to hls.js.
    const isHls = this.playMode === 'hls';
    const src = isHls ? null : this.buildStreamSrc();
    const embeddedSubStream = this.activeEmbeddedSubGlobalIndex !== null
      ? (this.probe?.subStreams ?? []).find((s) => s.index === this.activeEmbeddedSubGlobalIndex)
      : undefined;
    return html`
      <video
        class="stage-video"
        src=${src ?? nothing}
        ?controls=${this.nativeControls}
        autoplay
        @loadedmetadata=${this.onLoadedMetadata}
        @loadstart=${this.onTraceEvent}
        @loadeddata=${this.onTraceEvent}
        @canplay=${this.onTraceEvent}
        @canplaythrough=${this.onTraceEvent}
        @durationchange=${this.onDurationChange}
        @timeupdate=${this.onTimeUpdate}
        @progress=${this.onProgress}
        @play=${this.onPlay}
        @playing=${this.onTraceEvent}
        @pause=${this.onPause}
        @waiting=${this.onTraceEvent}
        @stalled=${this.onTraceEvent}
        @suspend=${this.onTraceEvent}
        @seeking=${this.onTraceEvent}
        @seeked=${this.onTraceEvent}
        @ratechange=${this.onTraceEvent}
        @volumechange=${this.onTraceEvent}
        @abort=${this.onTraceEvent}
        @emptied=${this.onTraceEvent}
        @ended=${this.onEnded}
        @error=${this.onError}
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
      ${this.nativeControls ? null : this.renderChrome()}
    `;
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
        ${this.playMode === 'nvenc'
          ? html`<span class="badge" title="Server is transcoding HEVC → H.264 on GPU">NVENC</span>`
          : null}
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
    const chapters = this.probe?.chapters ?? [];
    const showTicks = this.duration > 0 && chapters.length > 1;
    return html`
      <div class="scrubber-row">
        <span class="time">
          ${this.seeking ? html`<em style="color:#aaa;">…</em> ` : null}${this.formatTime(cur)}
        </span>
        <div class="scrubber" style=${`--played-pct:${playedPct}%; --buffered-pct:${bufferedPct}%;`}>
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
                    @click=${(e: Event): void => {
                      e.stopPropagation();
                      this.onChapterClick(c);
                    }}
                  ></div>`;
                })}
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

  /** 0.1.4.3 — clicking a chapter tick scrubs to its start via the standard
   *  scrub-restart path (in-buffer → seek; out-of-buffer → respawn ffmpeg). */
  private onChapterClick(chapter: Chapter): void {
    const v = this.videoEl;
    if (!v) return;
    const target = Math.max(0, Math.min(this.duration, chapter.startSeconds));
    if (this.isInBuffer(target)) {
      v.currentTime = this.isInPlaceSeekMode() ? target : target - this.streamOffset;
      this.pendingSeek = null;
      this.currentTime = target;
      return;
    }
    if (this.playMode === 'hls' || this.playMode === 'remux' || this.playMode === 'nvenc') {
      this.pendingSeek = target;
      this.streamOffset = target;
      this.currentTime = target;
      this.seeking = true;
      this.requestUpdate();
    }
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
   *  audio-track switches and burn-sub switches. (0.1.4.3) */
  private respawnAtCurrentTime(): void {
    const v = this.videoEl;
    const targetTime = v ? this.absoluteTime(v) : this.currentTime;
    if (this.playMode === 'direct') {
      this.playMode = 'remux';
    }
    this.streamOffset = Math.max(0, targetTime);
    this.pendingSeek = targetTime;
    this.currentTime = targetTime;
    this.seeking = true;
    this.requestUpdate();
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
    // If the file has only one audio track AND it's already the default, no
    // respawn is needed.
    const v = this.videoEl;
    const targetTime = v ? this.absoluteTime(v) : this.currentTime;
    this.activeAudioIndex = audio.audioIndex;
    writeAudioPref(this.relPath, audio.audioIndex);
    // Force a respawn from the current absolute position. For direct streams
    // buildStreamSrc() will add `?remux=true&audio=N`; for remux/nvenc it adds
    // `?audio=N`. Either way <video> reloads via `updated()` watching playMode/
    // probe/streamOffset.
    if (this.playMode === 'direct') {
      // Promote to remux so the audio override is honored.
      this.playMode = 'remux';
    }
    this.streamOffset = Math.max(0, targetTime);
    this.pendingSeek = targetTime;
    this.currentTime = targetTime;
    this.seeking = true;
    this.requestUpdate();
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
          <div class="menu-divider"></div>
          <div class="pip-row menu-list">
            <button style="--stagger-index:0" @click=${(): void => this.onPipClick()}>
              <span style="display:flex;align-items:center;gap:8px;">
                <span style="width:16px;height:16px;display:inline-flex;">${iconPip()}</span>
                Picture-in-picture
              </span>
              <span class="check-mark">${iconCheck()}</span>
            </button>
          </div>
        </div>
      </player-popover>
    `;
  }

  /** Build a copy/paste-friendly diagnostic block. Surfaces everything the
   *  pre-probe and runtime fallback know: container/codecs, decision vs the
   *  effective playMode (so you can spot a remux→nvenc downgrade), the
   *  chosen pipeline profile, audio strategy, the resolved duration, and the
   *  active stream URL. The textarea is selected on click so one tap +
   *  Cmd/Ctrl-C copies the whole report. */
  private buildInfoReport(): string {
    const p = this.probe;
    const v = this.videoEl;
    const d = this.diagnostics;
    const lines: string[] = [];
    lines.push(`Path:            ${this.relPath}`);
    if (p?.absPath) lines.push(`Abs path:        ${p.absPath}`);
    if (p?.container) lines.push(`Container:       ${p.container}`);
    if (p?.videoCodec) lines.push(`Video codec:     ${p.videoCodec}`);
    if (p?.audioCodec) lines.push(`Audio codec:     ${p.audioCodec}`);
    if (p?.decision) {
      const note = p.decision !== this.playMode ? ` (now: ${this.playMode})` : '';
      lines.push(`Decision:        ${p.decision}${note}`);
    } else {
      lines.push(`Play mode:       ${this.playMode}`);
    }
    const profile = d?.profile?.name ?? p?.profile;
    if (profile) lines.push(`Profile:         ${profile}`);
    if (d?.profile?.audioStrategy) {
      lines.push(`Audio strategy:  ${d.profile.audioStrategy}`);
    }
    if (p?.accel?.nvenc) lines.push(`NVENC avail:     yes${this.nvencTried ? ' (tried)' : ''}`);
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
    if (d?.ffmpegArgs && this.ffmpegArgsExpanded) {
      lines.push(`ffmpeg args:     ${d.ffmpegArgs.join(' ')}`);
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
      diagnostics: this.diagnostics,
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
        diagnostics: this.diagnostics,
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
    const args = this.diagnostics?.ffmpegArgs ?? null;
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
          ${args
            ? html`
                <details
                  ?open=${this.ffmpegArgsExpanded}
                  @toggle=${(e: Event): void => {
                    this.ffmpegArgsExpanded = (e.target as HTMLDetailsElement).open;
                  }}
                  style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#bcd;"
                >
                  <summary style="cursor:pointer;letter-spacing:1px;text-transform:uppercase;font-size:10px;color:var(--hm-accent);">ffmpeg args (${args.length})</summary>
                  <pre style="white-space:pre-wrap;word-break:break-all;margin:6px 0 0;background:#0c0c0c;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;line-height:1.45;">${args.join(' ')}</pre>
                </details>
              `
            : null}
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
