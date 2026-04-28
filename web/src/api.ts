import type {
  Library,
  LibraryItem,
  Episode,
  SeriesDetail,
  ShareStatus,
  Playback,
  PlaybackPostBody,
  SubInfo,
  ContinueResponse,
  ContinueRow,
  ManualIdentifyCandidate,
  ManualIdentifyItemBody,
  ManualIdentifyEpisodeBody,
  PlayerOpenResponse,
  PlayerSeekResponse,
  PlayerStateResponse,
  CapacityExceeded,
} from './types.js';

/** 0.1.9 — thrown when /open hits a concurrency cap. The player UI shows
 *  a polite "Encoder busy" panel; the body is preserved for diagnostics. */
export class PlayerCapacityError extends Error {
  constructor(public readonly body: CapacityExceeded) {
    super(`capacity_exceeded:${body.kind}`);
    this.name = 'PlayerCapacityError';
  }
}

export class ShareOfflineError extends Error {
  constructor() {
    super('share_offline');
    this.name = 'ShareOfflineError';
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

/** Phase 4 (post-0.1.6): HLS is the only player path. The legacy probe-and-
 *  decide flow that this flag used to gate is gone. The function is kept
 *  as a stable async API for callers that already await it on mount. */
export async function resolveHlsPlayerFlag(): Promise<boolean> {
  return true;
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

/** 0.1.6 — sendBeacon-friendly POST endpoint that aliases DELETE on the
 *  per-session HLS resource. Still exported because the Beacon API
 *  doesn't let callers set the HTTP method, and the segment-cleanup path
 *  on tab close uses it. */
export function hlsBeaconUrl(sessionId: string): string {
  return `/api/hls/${sessionId}/delete`;
}

/** 0.1.9 — server-driven player API. The client carries `playerId` (UUID)
 *  on every request; the server owns ffmpeg lifecycle + seek decisions. */

export interface PlayerOpenInput {
  relPath: string;
  audioStreamIndex?: number;
  burnSubStreamIndex?: number | null;
  startSeconds?: number;
}

async function playerPost<T>(playerId: string, suffix: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/player/${encodeURIComponent(playerId)}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 503) {
    const cap = (await r.json().catch(() => null)) as CapacityExceeded | null;
    if (cap && cap.error === 'capacity_exceeded') throw new PlayerCapacityError(cap);
    throw new Error('503 Service Unavailable');
  }
  if (r.status === 410) {
    // /state returns 410 when the player is gone; let the caller branch.
    return (await r.json().catch(() => ({}))) as T;
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export const apiPlayerOpen = (
  playerId: string,
  input: PlayerOpenInput,
): Promise<PlayerOpenResponse> => playerPost<PlayerOpenResponse>(playerId, '/open', input);

export const apiPlayerSeek = (
  playerId: string,
  absoluteSeconds: number,
): Promise<PlayerSeekResponse> =>
  playerPost<PlayerSeekResponse>(playerId, '/seek', { absoluteSeconds });

export const apiPlayerState = (
  playerId: string,
  currentLocalSeconds: number,
  paused: boolean,
): Promise<PlayerStateResponse> =>
  playerPost<PlayerStateResponse>(playerId, '/state', { currentLocalSeconds, paused });

export const apiPlayerTracks = (
  playerId: string,
  body: {
    audioStreamIndex?: number;
    burnSubStreamIndex?: number | null;
    startSeconds?: number;
  },
): Promise<PlayerOpenResponse> => playerPost<PlayerOpenResponse>(playerId, '/tracks', body);

export async function apiPlayerClose(playerId: string): Promise<void> {
  try {
    await fetch(`/api/player/${encodeURIComponent(playerId)}`, { method: 'DELETE' });
  } catch {
    /* tab is closing — best effort */
  }
}

/** sendBeacon-friendly close URL — DELETE has no body, so the POST alias
 *  is used by the player's pagehide handler. */
export function playerBeaconUrl(playerId: string): string {
  return `/api/player/${encodeURIComponent(playerId)}/delete`;
}

/** 0.1.9 — /api/config now carries `playerSession` alongside `hlsPlayer`. */
export interface ApiConfig {
  hlsPlayer: boolean;
  playerSession: boolean;
}

let cachedApiConfig: ApiConfig | null = null;

export async function apiConfig(): Promise<ApiConfig> {
  if (cachedApiConfig) return cachedApiConfig;
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`${r.status}`);
    const body = (await r.json()) as Partial<ApiConfig>;
    cachedApiConfig = {
      hlsPlayer: body.hlsPlayer === true,
      playerSession: body.playerSession === true,
    };
  } catch {
    cachedApiConfig = { hlsPlayer: true, playerSession: false };
  }
  return cachedApiConfig;
}

export const subsUrl = (relPath: string): string =>
  `/api/subs/${encodeURIComponent(relPath)}`;

/** 0.1.4.3 — URL for an embedded text-based subtitle track, extracted on the
 *  server and converted to WebVTT. */
export const embeddedSubsUrl = (relPath: string, streamIndex: number): string =>
  `/api/embedded-subs/${encodeURIComponent(relPath)}?stream=${streamIndex}`;

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
