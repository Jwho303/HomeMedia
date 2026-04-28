import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PaceController } from '../../src/player/pace-controller.js';
import type { HlsSession } from '../../src/streaming/hls-session.js';

interface FakeFFmpeg extends EventEmitter {
  killed: boolean;
  kill: (sig?: string) => boolean;
  stderr: EventEmitter;
}

function fakeProc(): FakeFFmpeg & { signals: string[] } {
  const ee = new EventEmitter() as FakeFFmpeg & { signals: string[] };
  ee.killed = false;
  ee.stderr = new EventEmitter();
  ee.signals = [];
  ee.kill = (sig?: string) => {
    ee.signals.push(sig ?? 'SIGTERM');
    if (sig === 'SIGKILL') ee.killed = true;
    return true;
  };
  return ee;
}

function fakeSession(opts?: { from?: number; to?: number }): {
  session: HlsSession;
  proc: ReturnType<typeof fakeProc>;
} {
  const proc = fakeProc();
  const session = {
    id: 's1',
    relPath: 'm.mkv',
    startSeconds: opts?.from ?? 0,
    cacheDir: '/tmp/x',
    ffmpeg: proc as unknown as HlsSession['ffmpeg'],
    profile: { name: 'fake' } as HlsSession['profile'],
    ffmpegArgs: [],
    createdAt: 0,
    lastTouchedAt: 0,
    state: 'running' as const,
    recentStderr: [],
    encodedWindow: { from: opts?.from ?? 0, to: opts?.to ?? 0 },
    segmentTimings: [],
    encodePaused: false,
  };
  return { session, proc };
}

describe('PaceController (POSIX path)', () => {
  it('SIGSTOPs when ahead-budget exceeds the target', () => {
    const { session, proc } = fakeSession({ from: 0, to: 100 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: true,
    });
    // ahead = 100 - 0 = 100 > 30 → SIGSTOP
    const r = ctl.tick(0);
    expect(r).toBe('suspend');
    expect(proc.signals).toContain('SIGSTOP');
    expect(ctl.isSuspended()).toBe(true);
    expect(session.encodePaused).toBe(true);
  });

  it('does nothing when ahead-budget is between resume and stop thresholds', () => {
    const { session, proc } = fakeSession({ from: 0, to: 20 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: true,
    });
    // ahead = 20 → between resume(10) and stop(30); not suspended yet → noop
    const r = ctl.tick(0);
    expect(r).toBe('noop');
    expect(proc.signals).toHaveLength(0);
  });

  it('SIGCONTs when ahead-budget falls under the resume threshold', () => {
    const { session, proc } = fakeSession({ from: 0, to: 100 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: true,
    });
    ctl.tick(0); // suspend
    // Now playhead advances; ahead = 100 - 95 = 5 < 10 → SIGCONT
    const r = ctl.tick(95);
    expect(r).toBe('resume');
    expect(proc.signals).toContain('SIGCONT');
    expect(ctl.isSuspended()).toBe(false);
    expect(session.encodePaused).toBe(false);
  });

  it('hysteresis: does not flap between stop and resume', () => {
    const { session, proc } = fakeSession({ from: 0, to: 100 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: true,
    });
    ctl.tick(0); // SIGSTOP at ahead=100
    // Within hysteresis band: ahead=20, still > resume(10), stays suspended.
    const r = ctl.tick(80);
    expect(r).toBe('noop');
    expect(proc.signals.filter((s) => s === 'SIGCONT')).toHaveLength(0);
  });

  it('dispose() resumes a suspended encoder so the process can be reaped', () => {
    const { session, proc } = fakeSession({ from: 0, to: 100 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: true,
    });
    ctl.tick(0);
    ctl.dispose();
    expect(proc.signals).toContain('SIGCONT');
  });
});

describe('PaceController (Windows path)', () => {
  it('is a noop on Windows — ffmpeg runs free (D6, paused in 0.1.9.1)', () => {
    const { session, proc } = fakeSession({ from: 0, to: 100 });
    const ctl = new PaceController({
      session,
      initialPosition: 0,
      ahead: 30,
      resume: 10,
      isPosix: false,
    });
    expect(ctl.tick(0)).toBe('noop');
    expect(proc.signals).toEqual([]);
    expect(ctl.isSuspended()).toBe(false);
    expect(session.encodePaused).toBe(false);
  });
});
