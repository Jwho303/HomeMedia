/**
 * Pace controller (0.1.9, D4 + D6).
 *
 * Holds ffmpeg suspended when its emitted segments cover ENCODE_AHEAD_SECONDS
 * past the client's reported position; resumes when the playhead approaches
 * the encoded head.
 *
 *   - POSIX: SIGSTOP / SIGCONT, free.
 *   - Windows: noop (0.1.9.1). The originally-spec'd kill-and-respawn loop
 *     on Windows interacted badly with cross-spawn segment retention and
 *     is paused. ffmpeg runs free; the encoder finishes encoding the
 *     stream early but produces a correct on-disk playlist that the client
 *     will fetch lazily. Disk + CPU cost is the trade.
 *
 * Driven by /state pings (every 5s while playing) — no internal timer.
 * The route handler calls `tick()` after recording the client's position.
 */

import type { ChildProcess } from 'node:child_process';
import type { HlsSession } from '../streaming/hls-session.js';
import { config } from '../config.js';

export interface PaceControllerOptions {
  session: HlsSession;
  /** Absolute source-second the client most recently reported. */
  initialPosition: number;
  ahead?: number;
  resume?: number;
  /** Override platform detection for tests. */
  isPosix?: boolean;
  /** Hook fired when a Windows-side respawn is needed. The route layer
   *  supplies a callback that performs the respawn against the manager. */
  onRespawnNeeded?: () => void;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

export class PaceController {
  private readonly session: HlsSession;
  private readonly ahead: number;
  private readonly resume: number;
  private readonly isPosix: boolean;
  private readonly onRespawnNeeded?: () => void;
  private readonly logger: PaceControllerOptions['logger'];
  private suspended = false;
  private disposed = false;
  private clientPosition: number;

  constructor(opts: PaceControllerOptions) {
    this.session = opts.session;
    this.ahead = opts.ahead ?? config.encodeAheadSeconds;
    this.resume = opts.resume ?? config.encodeResumeSeconds;
    this.isPosix = opts.isPosix ?? process.platform !== 'win32';
    if (opts.onRespawnNeeded) this.onRespawnNeeded = opts.onRespawnNeeded;
    if (opts.logger) this.logger = opts.logger;
    this.clientPosition = opts.initialPosition;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /** Called from /state and /seek with the client's most recent reported
   *  absolute source-second. Returns the action actually taken. On Windows
   *  this is always 'noop' (D6, paused in 0.1.9.1). */
  tick(absoluteSeconds: number): 'suspend' | 'resume' | 'noop' {
    if (this.disposed) return 'noop';
    if (!this.isPosix) return 'noop';
    this.clientPosition = absoluteSeconds;
    const headAbs = this.session.encodedWindow?.to ?? 0;
    const aheadBudget = headAbs - absoluteSeconds;

    if (!this.suspended && aheadBudget > this.ahead) {
      this.suspend();
      this.logger?.info?.(
        {
          evt: 'pace.suspend',
          sessionId: this.session.id,
          aheadBudget,
          target: this.ahead,
        },
        'encoder suspended (ahead budget exceeded)',
      );
      return 'suspend';
    }
    if (this.suspended && aheadBudget < this.resume) {
      this.resumeEncoder();
      this.logger?.info?.(
        {
          evt: 'pace.resume',
          sessionId: this.session.id,
          aheadBudget,
          threshold: this.resume,
        },
        'encoder resumed (ahead budget below threshold)',
      );
      return 'resume';
    }
    return 'noop';
  }

  /** Mirror of `session.encodePaused` for the route layer. */
  encodePaused(): boolean {
    return this.suspended;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.suspended) {
      // Best-effort wake before letting GC reap the process — a SIGSTOP'd
      // child holds resources oddly across kill on some kernels.
      this.resumeEncoder();
    }
  }

  private suspend(): void {
    if (this.suspended) return;
    if (!this.isPosix) {
      // Windows: noop until kill-and-respawn is reworked alongside
      // cross-spawn retention. Leave ffmpeg running.
      return;
    }
    this.suspended = true;
    this.session.encodePaused = true;
    try {
      // 'SIGSTOP' is portable across Linux + macOS; node-types accepts
      // the string form on POSIX kills.
      (this.session.ffmpeg as ChildProcess).kill('SIGSTOP');
    } catch (err) {
      this.logger?.warn?.(
        { evt: 'pace.sigstopFailed', err, sessionId: this.session.id },
        'SIGSTOP failed',
      );
    }
  }

  private resumeEncoder(): void {
    if (!this.suspended) return;
    if (!this.isPosix) return;
    this.suspended = false;
    this.session.encodePaused = false;
    try {
      (this.session.ffmpeg as ChildProcess).kill('SIGCONT');
    } catch (err) {
      this.logger?.warn?.(
        { evt: 'pace.sigcontFailed', err, sessionId: this.session.id },
        'SIGCONT failed',
      );
    }
  }
}
