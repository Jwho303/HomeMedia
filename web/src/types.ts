export interface LibraryItem {
  id: number;
  path: string;
  type: 'movie' | 'series';
  tmdbId: number | null;
  title: string | null;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  // 0.1.3.2 — home-screen metadata
  genres: string[];
  runtimeSeconds: number | null;
  position: number;
  duration: number;
  watched: boolean;
  watchedAt: number | null;
  /** mtime; used for NEW badge + Date Added chunking. (0.1.3.2) */
  addedAt: number;
  lastPlayedAt: number | null;
  /** IMDb /10 rating from OMDb. Null when unknown. (0.1.8) */
  imdbRating: number | null;
  /** IMDb vote count. Null when unknown. (0.1.8) */
  imdbVotes: number | null;
  /** 0.1.10 — soft-delete tombstone (epoch ms). Null when alive. Search view
   *  surfaces dimmed tiles for non-null and disables the play affordance.
   *  Optional on the type so test fixtures from older specs stay valid;
   *  the server always populates it (null = alive). */
  deletedAt?: number | null;
}

export interface Library {
  movies: LibraryItem[];
  series: LibraryItem[];
}

/** One row in `GET /api/continue`. (0.1.3.2) */
export interface ContinueRow {
  type: 'movie' | 'series';
  itemId: number;
  title: string | null;
  posterUrl: string | null;
  /** Movie file path or specific in-progress episode path. */
  resumePath: string;
  position: number;
  duration: number;
  runtimeSeconds: number | null;
  /** "S{n} · E{n}" for series; null for movies. */
  resumeLabel: string | null;
  lastPlayedAt: number;
}

export interface ContinueResponse {
  items: ContinueRow[];
}

export interface Episode {
  id: number;
  path: string;
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  stillUrl: string | null;
  /** Expected runtime in seconds: TMDB episode_run_time → ffprobe cache → null. (0.1.3.1) */
  runtimeSeconds: number | null;
  /** Resume position in seconds; 0 when never played. (0.1.3.1) */
  position: number;
  /** Player-reported duration in seconds; 0 when never played. (0.1.3.1) */
  duration: number;
  /** True iff the episode has been marked watched. (0.1.3.1) */
  watched: boolean;
  /** Epoch ms; null if never watched. (0.1.3.1) */
  watchedAt: number | null;
}

export interface SeriesDetail {
  series: LibraryItem;
  episodes: Episode[];
}

export interface ShareStatus {
  online: boolean;
  mountPath: string;
  lastSeen: number | null;
  /** 0.1.6 D13 / 0.1.7 — moved to `/api/config`. Stays optional on the
   *  type for back-compat with mid-upgrade browsers reading a 0.1.6 server. */
  hlsPlayer?: boolean;
}

/** 0.1.7 — `/api/config` payload. Read once on app boot; the player resolves
 *  the HLS flag from this rather than re-checking on every share-status poll. */
export interface ServerConfig {
  hlsPlayer: boolean;
}

/** GET /api/stream-meta/:relPath response (0.1.6). Lightweight read-only
 *  probe metadata for the HLS player UI (audio popover, sub picker, chapter
 *  ticks). The HLS pre-flight playlist fetch doesn't carry any of this. */
export interface StreamMeta {
  relPath: string;
  absPath: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  durationSeconds: number;
  audioStreams: AudioStream[];
  subStreams: SubStream[];
  chapters: Chapter[];
  subs: SubInfo[];
}

export interface Playback {
  position: number;
  duration: number;
  watched: boolean;
}

export interface ScanResult {
  scanned?: number;
  inserted?: number;
  updated?: number;
  errors?: number;
  /** 0.1.10 — paths that flipped from alive → soft-deleted on this run. */
  disappeared?: number;
  /** 0.1.10 — paths that flipped from soft-deleted → alive on this run. */
  resurrected?: number;
  /** 0.1.10 — the scan_runs row id for this run. */
  runId?: number;
  [k: string]: unknown;
}

/** 0.1.5.1 — events streamed over `GET /api/refresh-progress` (SSE). One
 *  protocol covers smart refresh, hard refresh, and per-item / library Re-probe. */
export type ScanProgressEvent =
  | { type: 'walk'; scanned: number }
  | { type: 'diff'; dirty: number; disappeared: number; total: number }
  | { type: 'cohort'; key: string; size: number }
  | {
      type: 'file';
      i: number;
      n: number;
      path: string;
      phase: 'identify' | 'persist';
    }
  | {
      type: 'probe';
      i: number;
      n: number;
      path: string;
      status: 'fresh' | 'reprobed' | 'failed' | 'skipped';
    }
  | { type: 'done'; result: Record<string, unknown> }
  | { type: 'error'; message: string };

export interface PlaybackPostBody {
  position: number;
  duration: number;
  watched?: boolean;
}

export type PlayDecision = 'direct' | 'remux' | 'external';

export interface SubInfo {
  path: string;
  lang: string | null;
  ext: 'srt' | 'vtt';
}

/** One audio stream surfaced by ffprobe. (0.1.4.3) */
export interface AudioStream {
  index: number;
  audioIndex: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels: number;
  default: boolean;
  forced: boolean;
}

/** One subtitle stream surfaced by ffprobe. (0.1.4.3) */
export interface SubStream {
  index: number;
  subIndex: number;
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  textBased: boolean;
}

/** One chapter marker. (0.1.4.3) */
export interface Chapter {
  index: number;
  startSeconds: number;
  endSeconds: number;
  title: string | null;
}

/** 0.1.9 — server-driven player session bundle, returned by /api/player/:id/open. */
export interface PlayerOpenResponse {
  playerId: string;
  relPath: string;
  reused: boolean;
  session: {
    sessionId: string;
    playlistUrl: string;
    encodedWindow: { from: number; to: number };
    startSeconds: number;
  };
  metadata: {
    durationSeconds: number;
    container: string;
    videoCodec: string;
    audioCodec: string;
    audioStreams: AudioStream[];
    subStreams: SubStream[];
    chapters: Chapter[];
    siblingSubs: SubInfo[];
    title: string | null;
    posterUrl: string | null;
    backdropUrl: string | null;
    imdbRating: number | null;
    manualOverride: boolean;
    activeAudioStreamIndex: number | null;
    activeBurnSubStreamIndex: number | null;
  };
  resume: {
    position: number;
    duration: number;
    watched: boolean;
  };
}

/** 0.1.9 — /api/player/:id/seek response. */
export interface PlayerSeekResponse {
  sessionId: string;
  playlistUrl: string;
  encodedWindow: { from: number; to: number };
  mode: 'reuse' | 'respawn';
  action:
    | { kind: 'set-current-time'; localSeconds: number }
    | { kind: 'reattach'; pendingResumeAt: number };
}

/** 0.1.9 — /api/player/:id/state response. */
export interface PlayerStateResponse {
  status: 'alive' | 'gone';
  encodedWindow: { from: number; to: number };
  encodePaused: boolean;
}

/** 0.1.9 — body of a 503 capacity_exceeded reply. */
export interface CapacityExceeded {
  error: 'capacity_exceeded';
  kind: 'global' | 'per_ip';
  limit: number;
  active: number;
  retryAfterSeconds: number | null;
}

export interface StreamProbe {
  decision: PlayDecision;
  subs: SubInfo[];
  /** Set when decision is 'external'; absolute on-disk path for the user to copy. */
  absPath?: string;
  /** Duration in seconds, from server-side ffprobe. Set for remux/external. */
  durationSeconds?: number;
  /** ffprobe `format_name` (e.g. 'matroska,webm'). Set for remux/external. */
  container?: string;
  /** Video stream codec name (e.g. 'hevc'). Set for remux/external. */
  videoCodec?: string;
  /** Audio stream codec name (e.g. 'eac3'). Set for remux/external. */
  audioCodec?: string;
  /** Hardware encoders the server can use to transcode. Currently only NVENC is wired. */
  accel?: { nvenc: boolean };
  /** Server tells the player to skip the plain remux attempt and start in this
   *  accel mode. Set when the source video codec is one no browser decodes. */
  preferAccel?: 'nvenc';
  /** 0.1.4.2 — name of the pipeline profile the next stream request would
   *  use ('remux-modern', 'nvenc-modern', 'nvenc-legacy-avi', etc.). */
  profile?: string;
  /** Every audio stream the source contains. (0.1.4.3) */
  audioStreams?: AudioStream[];
  /** Every subtitle stream the source contains. (0.1.4.3) */
  subStreams?: SubStream[];
  /** Chapter markers from the source. (0.1.4.3) */
  chapters?: Chapter[];
}

/** One search result returned by `/api/manual-identify/search`. (0.1.5.2) */
export interface ManualIdentifyCandidate {
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  type: 'movie' | 'series';
  overview: string | null;
  posterUrl: string | null;
  score: number;
  sources: string[];
}

/** Request body for `POST /api/manual-identify/item/:id`. (0.1.5.2) */
export type ManualIdentifyItemBody =
  | { tmdbId: number; type: 'movie' | 'series' }
  | { link: string };

/** Request body for `POST /api/manual-identify/episode/:id`. (0.1.5.2) */
export type ManualIdentifyEpisodeBody =
  | {
      tmdbId: number;
      type: 'movie' | 'series';
      season?: number;
      episode?: number;
      seInput?: string;
    }
  | {
      link: string;
      season?: number;
      episode?: number;
      seInput?: string;
    };

/** GET /api/stream-diagnostics response (0.1.4.2). */
export interface StreamDiagnostics {
  relPath: string;
  decision: PlayDecision;
  probe: {
    container: string;
    videoCodec: string;
    audioCodec: string;
    durationSeconds: number;
    /** 0.1.4.3 — every audio stream. */
    audioStreams?: AudioStream[];
    /** 0.1.4.3 — every subtitle stream. */
    subStreams?: SubStream[];
    /** 0.1.4.3 — chapter markers. */
    chapters?: Chapter[];
  };
  profile: {
    name: string;
    accel: 'nvenc' | null;
    audioStrategy: 'copy' | 'transcode';
  } | null;
  ffmpegArgs: string[] | null;
  encoderCaps: { nvenc: boolean; qsv: boolean; videotoolbox: boolean };
  preferAccel: 'nvenc' | null;
}
