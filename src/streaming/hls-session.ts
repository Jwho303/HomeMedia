/**
 * HLS session manager (0.1.6).
 *
 * Per the spec, HLS inverts the per-request lifecycle of the
 * fragmented-MP4 pipeline: ffmpeg has to outlive any single HTTP request
 * because each segment fetch is a separate round trip. We model that with
 * an explicit `HlsSession` keyed by `(relPath, startSeconds, audioIdx,
 * burnSubIdx)`. Two clients asking for the exact same stream share one
 * ffmpeg + one on-disk cache.
 *
 * Lifecycle:
 *   - `getOrCreate()`     spawn ffmpeg (+ mkdir cacheDir) on first ask
 *   - segment reads       update `lastTouchedAt`
 *   - `delete()`          explicit teardown (player beacon on tab close)
 *   - GC tick (30s)       kill anything not touched in 60s
 *   - `shutdownAll()`     wired to Fastify onClose
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { buildHlsArgs } from './hls-args.js';
import type { PipelineInput, PipelineProfile } from './profiles.js';

export type HlsSpawn = (cmd: string, args: ReadonlyArray<string>) => ChildProcess;

const defaultSpawn: HlsSpawn = (cmd, args) =>
  spawn(cmd, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });

export interface HlsSessionInput extends PipelineInput {
  relPath: string;
}

export type HlsSessionState =
  | 'starting'
  | 'running'
  | 'finished'
  | 'errored'
  | 'killed';

export interface HlsSession {
  id: string;
  relPath: string;
  startSeconds: number;
  audioStreamIndex?: number;
  burnSubStreamIndex?: number;
  cacheDir: string;
  ffmpeg: ChildProcess;
  profile: PipelineProfile;
  ffmpegArgs: ReadonlyArray<string>;
  createdAt: number;
  lastTouchedAt: number;
  state: HlsSessionState;
  /** Last few stderr lines from ffmpeg, kept for diagnostics. */
  recentStderr: string[];
  /** 0.1.9 — first and last absolute source-second this ffmpeg has emitted
   *  segments for. `from` is `startSeconds`; `to` advances as segments land
   *  on disk. The manager keeps this in sync via `updateEncodedWindow()`. */
  encodedWindow: { from: number; to: number };
  /** 0.1.9 — maps segment number → absolute start/end time. Built from the
   *  playlist file as ffmpeg writes it. Used by /seek for the in-window
   *  decision and by the playlist rewriter when retained segments are
   *  prepended on respawn. */
  segmentTimings: Array<{ sn: number; from: number; to: number }>;
  /** 0.1.9 — set by the pace controller when ffmpeg is SIGSTOPed (POSIX) or
   *  killed (Windows). Surfaced on /state responses for the runway-tick UI. */
  encodePaused: boolean;
  /** 0.1.9 — when true, `disposeSession()` skips the cacheDir rm. Segments
   *  outlive the session; player-layer retention rules clean them up. */
  keepCacheOnDispose?: boolean;
}

interface ManagerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const noopLogger: ManagerLogger = {
  info() {},
  warn() {},
  error() {},
};

interface ManagerOptions {
  spawn?: HlsSpawn;
  cacheRoot?: string;
  /** Override `Date.now()` for tests. */
  now?: () => number;
  logger?: ManagerLogger;
  /** Idle timeout in ms (default 5 * 60_000 = 5 minutes).
   *  Note: with the client-side `/touch` heartbeat (every 20s while
   *  playing), 5 minutes is a backstop — it's how long an unattended
   *  session lingers when the player exited without firing the cleanup
   *  beacon (network drop, hard browser crash, etc.). The previous 60s
   *  was set when segment-read was the only liveness signal; it caused
   *  spurious GCs when hls.js had buffered enough to skip segment fetches
   *  for a minute or more. */
  idleMs?: number;
  /** GC tick interval in ms (default 30_000). 0 disables the timer. */
  gcIntervalMs?: number;
}

export interface CreateOptions {
  startSeconds?: number;
  audioStreamIndex?: number;
  burnSubStreamIndex?: number;
  /** Hint passed through to `PipelineInput.burnSubTextBased`. Required when
   *  `burnSubStreamIndex` is set; the route layer derives it from the probe's
   *  `subStreams[i].textBased`. */
  burnSubTextBased?: boolean;
  /** 0.1.9 — override the on-disk cache directory. Used by the player
   *  manager to land segments under `<playerId>/<relPathHash>/<paramsHash>/`
   *  so retention rules can outlive any single ffmpeg lifetime. */
  cacheDir?: string;
  /** 0.1.9 — when true, `disposeSession()` only kills ffmpeg and drops the
   *  in-memory entry; segment files are left on disk. The player manager
   *  uses this so a respawn on the same params can pick up where ffmpeg
   *  left off. The retention rules (close, relPath swap, idle GC) remove
   *  segments directly. */
  keepCacheOnDispose?: boolean;
}

const STDERR_RING = 50;

export class HlsSessionManager {
  private readonly sessions = new Map<string, HlsSession>();
  private readonly byKey = new Map<string, string>();
  private readonly spawnFn: HlsSpawn;
  private readonly cacheRoot: string;
  private readonly now: () => number;
  private readonly logger: ManagerLogger;
  private readonly idleMs: number;
  private readonly gcIntervalMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ManagerOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.cacheRoot = opts.cacheRoot ?? config.hlsCacheDir;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? noopLogger;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.gcIntervalMs = opts.gcIntervalMs ?? 30_000;
    if (this.gcIntervalMs > 0) {
      this.gcTimer = setInterval(() => this.gcIdle(), this.gcIntervalMs);
      // Don't keep the event loop alive just for the GC tick.
      this.gcTimer.unref?.();
    }
  }

  /** Composite key for session reuse across requests. The textBased flag
   *  doesn't change identity — it's a derived property of the chosen
   *  burnSubStreamIndex — so it's omitted from the key. */
  private sessionKey(relPath: string, opts: CreateOptions): string {
    return [
      relPath,
      opts.startSeconds ?? 0,
      opts.audioStreamIndex ?? '',
      opts.burnSubStreamIndex ?? '',
    ].join('|');
  }

  /** Get the existing session for these params, or spawn a new one. */
  async getOrCreate(input: HlsSessionInput, opts: CreateOptions = {}): Promise<HlsSession> {
    const key = this.sessionKey(input.relPath, opts);
    const existingId = this.byKey.get(key);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.state !== 'errored' && existing.state !== 'killed') {
        existing.lastTouchedAt = this.now();
        return existing;
      }
      // Stale entry — clean up before respawning.
      if (existing) await this.disposeSession(existing);
      this.byKey.delete(key);
    }

    const id = crypto.randomUUID();
    const cacheDir = opts.cacheDir ?? path.join(this.cacheRoot, id);
    await fs.mkdir(cacheDir, { recursive: true });

    const pipelineInput: PipelineInput = {
      absPath: input.absPath,
      videoCodec: input.videoCodec,
      audioCodec: input.audioCodec,
      container: input.container,
    };
    if (opts.startSeconds !== undefined) pipelineInput.startSeconds = opts.startSeconds;
    if (opts.audioStreamIndex !== undefined) pipelineInput.audioStreamIndex = opts.audioStreamIndex;
    if (opts.burnSubStreamIndex !== undefined) pipelineInput.burnSubStreamIndex = opts.burnSubStreamIndex;
    if (opts.burnSubTextBased !== undefined) pipelineInput.burnSubTextBased = opts.burnSubTextBased;
    // Thread duration through so `pickPlaylistMode()` can choose vod vs event.
    const inDur = (input as PipelineInput & { durationSeconds?: number }).durationSeconds;
    if (inDur !== undefined) {
      (pipelineInput as PipelineInput & { durationSeconds?: number }).durationSeconds = inDur;
    }

    const { profile, args } = buildHlsArgs(pipelineInput, cacheDir);

    const ffmpeg = this.spawnFn('ffmpeg', args);
    const startSecondsApplied = opts.startSeconds ?? 0;
    const session: HlsSession = {
      id,
      relPath: input.relPath,
      startSeconds: startSecondsApplied,
      cacheDir,
      ffmpeg,
      profile,
      ffmpegArgs: args,
      createdAt: this.now(),
      lastTouchedAt: this.now(),
      state: 'starting',
      recentStderr: [],
      // 0.1.9 — encodedWindow starts as a zero-width range at the spawn
      // position. The player manager calls `updateEncodedWindow()` after
      // each segment timings refresh to advance `to`.
      encodedWindow: { from: startSecondsApplied, to: startSecondsApplied },
      segmentTimings: [],
      encodePaused: false,
      ...(opts.keepCacheOnDispose === true ? { keepCacheOnDispose: true } : {}),
    };
    if (opts.audioStreamIndex !== undefined) session.audioStreamIndex = opts.audioStreamIndex;
    if (opts.burnSubStreamIndex !== undefined) session.burnSubStreamIndex = opts.burnSubStreamIndex;

    ffmpeg.stderr?.on('data', (b: Buffer) => {
      const text = b.toString('utf8').trim();
      if (!text) return;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        session.recentStderr.push(line);
        if (session.recentStderr.length > STDERR_RING) session.recentStderr.shift();
      }
    });
    ffmpeg.on('exit', (code, signal) => {
      if (session.state === 'killed') return;
      if (code === 0) session.state = 'finished';
      else session.state = 'errored';
      // 0.1.7 note: ffmpeg's HLS muxer writes `#EXT-X-ENDLIST` itself when it
      // finishes naturally (yes, even in `event` mode — the muxer flushes a
      // proper closure on graceful exit). Earlier in this spec we appended
      // ENDLIST here on top of ffmpeg's; that produced a duplicate tag and
      // hls.js bailed with `levelParsingError: '#EXT-X-ENDLIST must not
      // appear more than once'` once the encode finished mid-playback (most
      // visible on short legacy-avi sources where the encode catches up to
      // playback before the user is done watching). Don't touch the
      // playlist here.
      this.logger.warn(
        {
          evt: 'hls.exit',
          sessionId: id,
          code,
          signal,
          state: session.state,
          stderrTail: session.recentStderr.slice(-3),
        },
        'hls ffmpeg exited',
      );
    });
    ffmpeg.on('error', (err) => {
      session.state = 'errored';
      this.logger.error({ evt: 'hls.spawnError', sessionId: id, err }, 'hls ffmpeg spawn error');
    });

    this.sessions.set(id, session);
    this.byKey.set(key, id);

    this.logger.info(
      {
        evt: 'hls.spawn',
        sessionId: id,
        relPath: input.relPath,
        profile: profile.name,
        startSeconds: opts.startSeconds ?? 0,
        audioStreamIndex: opts.audioStreamIndex,
        burnSubStreamIndex: opts.burnSubStreamIndex,
        cacheDir,
      },
      'hls session spawned',
    );

    return session;
  }

  get(id: string): HlsSession | undefined {
    return this.sessions.get(id);
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      const idleMs = this.now() - s.lastTouchedAt;
      s.lastTouchedAt = this.now();
      this.logger.info(
        { evt: 'hls.touch', sessionId: id, idleMs, state: s.state },
        'hls session touched',
      );
    } else {
      this.logger.warn(
        { evt: 'hls.touchMissing', sessionId: id },
        'hls touch on unknown session',
      );
    }
  }

  /** Explicit teardown — used by `DELETE /api/hls/:sessionId` and by the
   *  reverse-key cleanup on stale entries. */
  async delete(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn(
        { evt: 'hls.deleteMissing', sessionId: id },
        'delete called on unknown session',
      );
      return false;
    }
    this.logger.info(
      {
        evt: 'hls.delete',
        sessionId: id,
        relPath: session.relPath,
        idleMs: this.now() - session.lastTouchedAt,
        state: session.state,
      },
      'hls session explicit delete',
    );
    await this.disposeSession(session);
    return true;
  }

  /** Wait for `index.m3u8` to appear in the cache dir. Returns true on
   *  success, false on timeout. */
  async waitForPlaylist(id: string, timeoutMs = 10_000): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    const deadline = this.now() + timeoutMs;
    const playlistPath = path.join(session.cacheDir, 'index.m3u8');
    while (this.now() < deadline) {
      try {
        const st = await fs.stat(playlistPath);
        if (st.size > 0) return true;
      } catch {
        /* not yet */
      }
      if (session.state === 'errored' || session.state === 'killed') return false;
      await sleep(100);
    }
    return false;
  }

  /** Wait for a specific segment file to appear. Returns true on success,
   *  false on timeout / session-gone. */
  async waitForSegment(id: string, segName: string, timeoutMs = 5_000): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    const segPath = path.join(session.cacheDir, segName);
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      try {
        const st = await fs.stat(segPath);
        if (st.size > 0) return true;
      } catch {
        /* not yet */
      }
      if (session.state === 'errored' || session.state === 'killed') return false;
      await sleep(100);
    }
    return false;
  }

  gcIdle(): void {
    const cutoff = this.now() - this.idleMs;
    const toKill: HlsSession[] = [];
    const survivors: { id: string; idleMs: number; state: string }[] = [];
    for (const session of this.sessions.values()) {
      const idleMs = this.now() - session.lastTouchedAt;
      if (session.lastTouchedAt < cutoff) toKill.push(session);
      else survivors.push({ id: session.id, idleMs, state: session.state });
    }
    this.logger.info(
      { evt: 'hls.gcTick', live: this.sessions.size, toKill: toKill.length, survivors },
      'hls gc tick',
    );
    for (const s of toKill) {
      this.logger.warn(
        {
          evt: 'hls.gc',
          sessionId: s.id,
          relPath: s.relPath,
          startSeconds: s.startSeconds,
          idleMs: this.now() - s.lastTouchedAt,
          idleThresholdMs: this.idleMs,
          state: s.state,
        },
        `hls session GCed after ${Math.round((this.now() - s.lastTouchedAt) / 1000)}s idle`,
      );
      void this.disposeSession(s);
    }
  }

  /** Wired to Fastify onClose — kill every live ffmpeg + clean every dir. */
  async shutdownAll(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    const all = Array.from(this.sessions.values());
    await Promise.all(all.map((s) => this.disposeSession(s)));
  }

  /** Inspect the cache root on startup and rm any orphaned session dirs left
   *  over from a previous process (e.g. ungraceful shutdown). */
  async cleanupOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await Promise.all(
      entries.map(async (name) => {
        const full = path.join(this.cacheRoot, name);
        try {
          await fs.rm(full, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(
            { evt: 'hls.orphanRmFailed', path: full, err },
            'failed to remove orphan hls cache dir',
          );
        }
      }),
    );
  }

  /** Test-only: enumerate live sessions. */
  liveCount(): number {
    return this.sessions.size;
  }

  /** 0.1.9 — read the on-disk index.m3u8, parse `#EXTINF` durations and
   *  segment names, and update the session's `encodedWindow` +
   *  `segmentTimings`. Best-effort: if the playlist isn't readable yet
   *  this returns the existing window unchanged.
   *
   *  The playlist looks like
   *      #EXTINF:6.000,
   *      seg-00000.ts
   *      #EXTINF:6.000,
   *      seg-00001.ts
   *      ...
   *  Segment N spans [from + sum(durations[0..N-1]), from + sum(durations[0..N])]
   *  in absolute source-seconds. */
  async refreshEncodedWindow(id: string): Promise<{ from: number; to: number } | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(session.cacheDir, 'index.m3u8'), 'utf8');
    } catch {
      return session.encodedWindow;
    }
    const lines = raw.split(/\r?\n/);
    const timings: Array<{ sn: number; from: number; to: number }> = [];
    let cursor = session.startSeconds;
    let pendingDuration: number | null = null;
    let mediaSequence = 0;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const n = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim());
        if (Number.isFinite(n)) mediaSequence = n;
        continue;
      }
      if (line.startsWith('#EXTINF:')) {
        const tail = line.slice('#EXTINF:'.length);
        const dur = Number(tail.split(',')[0]);
        if (Number.isFinite(dur)) pendingDuration = dur;
        continue;
      }
      if (line.length === 0 || line.startsWith('#')) continue;
      // Segment line.
      const match = /seg-(\d+)\.ts/.exec(line);
      if (!match || pendingDuration === null) continue;
      const sn = Number(match[1]);
      const from = cursor;
      const to = cursor + pendingDuration;
      timings.push({ sn, from, to });
      cursor = to;
      pendingDuration = null;
    }
    void mediaSequence; // tracked for debugging future ABR work
    if (timings.length === 0) return session.encodedWindow;
    session.segmentTimings = timings;
    session.encodedWindow = {
      from: session.startSeconds,
      to: timings[timings.length - 1]!.to,
    };
    return session.encodedWindow;
  }

  /** 0.1.7 — surface recent ffmpeg stderr for sessions matching a relPath.
   *  Used by `/api/client-log` to attach the encoder's last words to a
   *  player-side failure report — when MSE rejects a segment we need
   *  ffmpeg's view, not just the player's.
   *
   *  Returns both live sessions and recently-disposed ones (last few
   *  minutes), since the player's external-fallback path tears down the
   *  HLS session BEFORE it POSTs the diagnostic report. Without the
   *  post-disposal cache the stderr would always be missing exactly when
   *  we need it most. */
  recentStderrFor(relPath: string): { sessionId: string; lines: ReadonlyArray<string>; disposedAt?: number }[] {
    const out: { sessionId: string; lines: ReadonlyArray<string>; disposedAt?: number }[] = [];
    for (const s of this.sessions.values()) {
      if (s.relPath === relPath) {
        out.push({ sessionId: s.id, lines: [...s.recentStderr] });
      }
    }
    const cutoff = this.now() - this.disposedStderrTtlMs;
    for (const [id, entry] of this.disposedStderr) {
      if (entry.disposedAt < cutoff) {
        this.disposedStderr.delete(id);
        continue;
      }
      if (entry.relPath === relPath) {
        out.push({ sessionId: id, lines: entry.lines, disposedAt: entry.disposedAt });
      }
    }
    return out;
  }

  /** Recently-disposed sessions, indexed by sessionId, with their last
   *  STDERR_RING lines preserved. TTL'd via the cutoff in `recentStderrFor`. */
  private readonly disposedStderr: Map<string, { relPath: string; lines: string[]; disposedAt: number }> = new Map();
  private readonly disposedStderrTtlMs = 5 * 60_000;

  private async disposeSession(session: HlsSession): Promise<void> {
    const wasKilled = session.state === 'killed';
    session.state = 'killed';
    if (!session.ffmpeg.killed) {
      try {
        session.ffmpeg.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
    // 0.1.7 — preserve stderr in the post-disposal cache so a player-side
    // diagnostic report (which arrives AFTER the player tears down its HLS
    // session) can still pick it up. Trim the cache to ~32 entries so it
    // can't grow without bound on a long-running server.
    if (session.recentStderr.length > 0) {
      this.disposedStderr.set(session.id, {
        relPath: session.relPath,
        lines: [...session.recentStderr],
        disposedAt: this.now(),
      });
      while (this.disposedStderr.size > 32) {
        const oldest = this.disposedStderr.keys().next().value;
        if (oldest === undefined) break;
        this.disposedStderr.delete(oldest);
      }
    }
    this.sessions.delete(session.id);
    for (const [k, v] of this.byKey.entries()) {
      if (v === session.id) this.byKey.delete(k);
    }
    if (session.keepCacheOnDispose) {
      // 0.1.9 — segments outlive ffmpeg under the player layer. Retention
      // is enforced by the player manager (close, relPath swap, params
      // change, idle GC), not here.
      return;
    }
    try {
      await fs.rm(session.cacheDir, { recursive: true, force: true });
    } catch (err) {
      if (!wasKilled) {
        this.logger.warn(
          { evt: 'hls.cleanup', sessionId: session.id, err },
          'failed to remove hls cache dir',
        );
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Module-level singleton, lazily constructed so tests can inject before first use.
let singleton: HlsSessionManager | null = null;

export function getHlsSessionManager(opts?: ManagerOptions): HlsSessionManager {
  if (!singleton) singleton = new HlsSessionManager(opts);
  return singleton;
}

export function setHlsSessionManagerForTests(mgr: HlsSessionManager | null): void {
  singleton = mgr;
}
