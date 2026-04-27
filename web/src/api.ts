import type {
  Library,
  LibraryItem,
  Episode,
  SeriesDetail,
  ShareStatus,
  ServerConfig,
  Playback,
  PlaybackPostBody,
  StreamProbe,
  StreamDiagnostics,
  StreamMeta,
  SubInfo,
  ContinueResponse,
  ContinueRow,
  ManualIdentifyCandidate,
  ManualIdentifyItemBody,
  ManualIdentifyEpisodeBody,
} from './types.js';

export class ShareOfflineError extends Error {
  constructor() {
    super('share_offline');
    this.name = 'ShareOfflineError';
  }
}

export class EmptyFileError extends Error {
  constructor() {
    super('empty_file');
    this.name = 'EmptyFileError';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (r.status === 503) {
    const body = await r.json().catch(() => ({}));
    if ((body as { error?: string }).error === 'share_offline') {
      throw new ShareOfflineError();
    }
  }
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText}`);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export const apiLibrary = (opts: { includeStale?: boolean } = {}): Promise<Library> =>
  api<Library>(`/api/library${opts.includeStale ? '?includeStale=true' : ''}`);

export const apiSeries = (id: number): Promise<SeriesDetail> =>
  api<SeriesDetail>(`/api/series/${id}`);

/** Continue Watching — unified resumable list. (0.1.3.2) */
export const apiContinue = async (): Promise<ContinueRow[]> => {
  const r = await api<ContinueResponse>('/api/continue');
  return r.items;
};

export const apiShareStatus = (): Promise<ShareStatus> =>
  api<ShareStatus>('/api/share/status');

/** 0.1.7 — `/api/config` is read-once on app boot. The HLS-player flag
 *  used to ride on every share-status response; this endpoint exists so
 *  the share poll stops doubling as the flag carrier. */
export const apiConfig = (): Promise<ServerConfig> =>
  api<ServerConfig>('/api/config');

/** 0.1.7 — module-level cache for the server config. Populated lazily by
 *  `resolveHlsPlayerFlag()` (or eagerly by app boot if a future caller wants
 *  to). One fetch per page load. */
let cachedConfig: ServerConfig | null = null;
/** Resolve the HLS player flag — fetch `/api/config` once if not cached.
 *  Returns `false` if the request fails (graceful degrade to the legacy
 *  player path). */
export async function resolveHlsPlayerFlag(): Promise<boolean> {
  if (cachedConfig) return cachedConfig.hlsPlayer;
  try {
    cachedConfig = await apiConfig();
  } catch {
    cachedConfig = { hlsPlayer: false };
  }
  return cachedConfig.hlsPlayer;
}
/** Test-only: clear the cached config so successive tests can mock fresh fetches. */
export function resetCachedConfigForTests(): void {
  cachedConfig = null;
}

export const apiReconnect = (): Promise<ShareStatus> =>
  api<ShareStatus>('/api/share/reconnect', { method: 'POST' });

export const apiPlaybackGet = (relPath: string): Promise<Playback> =>
  api<Playback>(`/api/playback/${encodeURIComponent(relPath)}`);

export const apiPlaybackPost = (
  relPath: string,
  body: PlaybackPostBody,
): Promise<Playback> =>
  api<Playback>(`/api/playback/${encodeURIComponent(relPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Wipe playback for a single path. Used by the per-card "Reset / Mark unwatched"
 *  action — wipes watched flag and resume position both. (0.1.3.2) */
export const apiPlaybackDelete = (relPath: string): Promise<void> =>
  api<void>(`/api/playback/${encodeURIComponent(relPath)}`, { method: 'DELETE' });

/** Set watched flag for a single path, preserving any existing position/duration.
 *  Used by the per-episode kebab. (0.1.3.2) */
export const apiPathSetWatched = (relPath: string, watched: boolean): Promise<void> =>
  api<void>(`/api/playback-watched/${encodeURIComponent(relPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watched }),
  });

/** Mark a whole library item (movie or series) watched / unwatched. For series
 *  this fans out across every episode. (0.1.3.2) */
export const apiItemSetWatched = (id: number, watched: boolean): Promise<void> =>
  api<void>(`/api/items/${id}/watched`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watched }),
  });

/** 0.1.5.1 — `POST /api/refresh` returns 202 + a jobId immediately. The
 *  scan runs in the background; the SSE channel (`GET /api/refresh-progress`)
 *  delivers progress events and the final ScanResult via the `done` event.
 *  Callers that want to await completion go through `<app-shell>`'s
 *  EventSource, which multiplexes events across views. */
export interface RefreshKickoff {
  jobId: string;
  full: boolean;
}

export const apiRefresh = (full = false): Promise<RefreshKickoff> =>
  api<RefreshKickoff>(`/api/refresh${full ? '?full=true' : ''}`, { method: 'POST' });

/** 0.1.4.3 — explicit "Re-probe library" action. Now returns 202 + jobId
 *  (per 0.1.5.1); the actual probe totals arrive via the SSE `done` event. */
export interface ReprobeKickoff {
  jobId: string;
  kind: 'reprobe-library' | 'reprobe-item' | 'reprobe-episode';
  files: number;
}

export const apiReprobeLibrary = (): Promise<ReprobeKickoff> =>
  api<ReprobeKickoff>(`/api/reprobe-library`, { method: 'POST' });

/** 0.1.5.1 — per-item Re-probe (movie or series). Force-probes every file
 *  under the item; does NOT touch identity. Shares scan-lock + SSE channel
 *  with refresh / reprobe-library. */
export const apiReprobeItem = (id: number): Promise<ReprobeKickoff> =>
  api<ReprobeKickoff>(`/api/reprobe-item/${id}`, { method: 'POST' });

export const apiReprobeEpisode = (id: number): Promise<ReprobeKickoff> =>
  api<ReprobeKickoff>(`/api/reprobe-episode/${id}`, { method: 'POST' });

export const streamUrl = (relPath: string): string =>
  `/api/stream/${encodeURIComponent(relPath)}`;

/** 0.1.6 — HLS playlist URL for a path. The relPath rides as `?path=…`
 *  because Fastify's router requires wildcards in the last URL segment.
 *  Caller may pass start/audio/burnSub overrides. */
export interface HlsUrlOpts {
  startSeconds?: number;
  audioStreamIndex?: number;
  burnSubStreamIndex?: number;
}

export function hlsPlaylistUrl(relPath: string, opts: HlsUrlOpts = {}): string {
  const params = new URLSearchParams();
  params.set('path', relPath);
  if (opts.startSeconds && opts.startSeconds > 0) {
    params.set('start', String(Math.floor(opts.startSeconds)));
  }
  if (opts.audioStreamIndex !== undefined) {
    params.set('audio', String(opts.audioStreamIndex));
  }
  if (opts.burnSubStreamIndex !== undefined) {
    params.set('burnSub', String(opts.burnSubStreamIndex));
  }
  return `/api/hls/master.m3u8?${params.toString()}`;
}

/** 0.1.6 — DELETE the HLS session (best-effort cleanup on player teardown). */
export function hlsDeleteUrl(sessionId: string): string {
  return `/api/hls/${sessionId}`;
}

/** 0.1.6 — sendBeacon-friendly POST endpoint that aliases DELETE. The Beacon
 *  API doesn't let you set the HTTP method, so the route accepts POST as
 *  equivalent to DELETE for tab-close cleanup. */
export function hlsBeaconUrl(sessionId: string): string {
  return `/api/hls/${sessionId}/delete`;
}

/** 0.1.6 — GET /api/stream-meta/:relPath (read-only probe metadata for the
 *  HLS player UI). */
export const apiStreamMeta = (relPath: string): Promise<StreamMeta> =>
  api<StreamMeta>(`/api/stream-meta/${encodeURIComponent(relPath)}`);

export const subsUrl = (relPath: string): string =>
  `/api/subs/${encodeURIComponent(relPath)}`;

/** 0.1.4.3 — URL for an embedded text-based subtitle track, extracted on the
 *  server and converted to WebVTT. */
export const embeddedSubsUrl = (relPath: string, streamIndex: number): string =>
  `/api/embedded-subs/${encodeURIComponent(relPath)}?stream=${streamIndex}`;

/**
 * Pre-probe a stream URL with a 1-byte Range request. Three outcomes:
 *  - 206/200 → direct play (server is happy to stream the file as-is)
 *  - 415 + JSON body → server signals remux/external; subs[] also present
 *  - 503 share_offline → throws ShareOfflineError
 *  - anything else → throws Error
 */
export async function apiStreamProbe(relPath: string): Promise<StreamProbe> {
  const r = await fetch(streamUrl(relPath), {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
  });
  if (r.status === 503) {
    const body = await r.json().catch(() => ({}));
    if ((body as { error?: string }).error === 'share_offline') {
      throw new ShareOfflineError();
    }
  }
  if (r.status === 404) {
    const body = await r.json().catch(() => ({}));
    if ((body as { error?: string }).error === 'empty_file') {
      throw new EmptyFileError();
    }
  }
  if (r.status === 206 || r.status === 200) {
    // Drain & discard the 1-byte body so the connection can be reused.
    try { await r.arrayBuffer(); } catch { /* ignore */ }
    return { decision: 'direct', subs: [] };
  }
  if (r.status === 415) {
    const body = (await r.json().catch(() => ({}))) as Partial<StreamProbe>;
    const result: StreamProbe = {
      decision: body.decision ?? 'external',
      subs: body.subs ?? [],
    };
    if (body.absPath) result.absPath = body.absPath;
    if (typeof body.durationSeconds === 'number' && body.durationSeconds > 0) {
      result.durationSeconds = body.durationSeconds;
    }
    if (body.container) result.container = body.container;
    if (body.videoCodec) result.videoCodec = body.videoCodec;
    if (body.audioCodec) result.audioCodec = body.audioCodec;
    if (body.accel) result.accel = body.accel;
    if (body.preferAccel === 'nvenc') result.preferAccel = 'nvenc';
    if (body.profile) result.profile = body.profile;
    if (body.audioStreams) result.audioStreams = body.audioStreams;
    if (body.subStreams) result.subStreams = body.subStreams;
    if (body.chapters) result.chapters = body.chapters;
    return result;
  }
  throw new Error(`stream probe failed: ${r.status} ${r.statusText}`);
}

/** Fetch the read-only stream diagnostics (0.1.4.2). Returns the probe +
 *  chosen profile + would-be ffmpeg args without spawning ffmpeg. */
export async function apiStreamDiagnostics(relPath: string): Promise<StreamDiagnostics> {
  return api<StreamDiagnostics>(`/api/stream-diagnostics/${encodeURIComponent(relPath)}`);
}

/** 0.1.5.2 — Search TMDB for manual-identify candidates. The optional
 *  `signal` lets the modal abort an in-flight request when the user retypes
 *  or closes the dialog. */
export async function apiManualIdentifySearch(
  q: string,
  opts: { type?: 'movie' | 'series'; signal?: AbortSignal } = {},
): Promise<ManualIdentifyCandidate[]> {
  const params = new URLSearchParams();
  params.set('q', q);
  if (opts.type) params.set('type', opts.type);
  const url = `/api/manual-identify/search?${params.toString()}`;
  const init: RequestInit = {};
  if (opts.signal) init.signal = opts.signal;
  const r = await fetch(url, init);
  if (r.status === 503) {
    const body = await r.json().catch(() => ({}));
    if ((body as { error?: string }).error === 'share_offline') {
      throw new ShareOfflineError();
    }
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const body = (await r.json()) as { candidates: ManualIdentifyCandidate[] };
  return body.candidates;
}

/** 0.1.5.2 — Apply a manual-identify pick to a movie or series row. */
export const apiManualIdentifyItem = (
  id: number,
  body: ManualIdentifyItemBody,
): Promise<{ item: LibraryItem | null }> =>
  api<{ item: LibraryItem | null }>(`/api/manual-identify/item/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 0.1.5.2 — Apply a manual-identify pick to an episode. The body may carry
 *  optional `season`/`episode` (or a parsable `seInput` string like
 *  "S04E01") to correct mis-numbered episodes alongside or independent of
 *  the parent series id. */
export const apiManualIdentifyEpisode = (
  id: number,
  body: ManualIdentifyEpisodeBody,
): Promise<{ episode: Episode | null; item: LibraryItem | null }> =>
  api<{ episode: Episode | null; item: LibraryItem | null }>(
    `/api/manual-identify/episode/${id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

/** POST a diagnostic report to the server log. Used by the player's Report
 *  button — the body is logged verbatim to the server console. */
export async function apiClientLog(payload: unknown): Promise<void> {
  const r = await fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
}

export async function apiSubsList(relPath: string): Promise<SubInfo[]> {
  const r = await fetch(`/api/subs-list/${encodeURIComponent(relPath)}`);
  if (r.status === 503) {
    const body = await r.json().catch(() => ({}));
    if ((body as { error?: string }).error === 'share_offline') {
      throw new ShareOfflineError();
    }
  }
  if (!r.ok) return [];
  const body = (await r.json().catch(() => ({ subs: [] }))) as { subs?: SubInfo[] };
  return body.subs ?? [];
}
