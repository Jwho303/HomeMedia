import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import {
  formatLine,
  shouldSuppress,
  buildQuietLine,
  ConsolePrettyStream,
  DEFAULT_SUPPRESS,
  type PinoEvent,
} from '../../src/log/console-pretty.js';

const T = 1_700_000_000_000; // fixed wall-clock for deterministic time-column

function evt(extra: Partial<PinoEvent> = {}): PinoEvent {
  return { level: 30, time: T, ...extra };
}

class BufferStream extends Writable {
  chunks: string[] = [];
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    cb();
  }
  text(): string { return this.chunks.join(''); }
}

describe('formatLine() — tag inference + columns (0.1.7)', () => {
  it('renders the response tag with a status code', () => {
    const out = formatLine(evt({
      evt: 'response', method: 'GET', url: '/api/series/31', statusCode: 200, ms: 1.4,
    }));
    expect(out).toContain('GET /api/series/31');
    expect(out).toContain('200');
    expect(out).toContain('1.4ms');
  });

  it('renders the hls.spawn tag with profile + short id', () => {
    const out = formatLine(evt({
      evt: 'hls.spawn',
      sessionId: '7e2a43a4-7336-4056-a638-48734539ca7e',
      profile: 'nvenc-modern',
      relPath: 'IT/S01E07.mkv',
    }));
    expect(out).toContain('hls.spawn');
    expect(out).toContain('7e2a43a4');
    expect(out).toContain('nvenc-modern');
    expect(out).toContain('IT/S01E07.mkv');
  });

  it('renders the hls.segment tag with size', () => {
    const out = formatLine(evt({
      evt: 'hls.segment', sessionId: '7e2a43a4-7336-4056-a638-48734539ca7e',
      segName: 'seg-00000.ts', bytes: 1_200_000,
    }));
    expect(out).toContain('hls.segment');
    expect(out).toContain('seg-00000.ts');
    expect(out).toContain('1.1 MB');
  });

  it('renders the hls.gc tag with idle seconds', () => {
    const out = formatLine(evt({
      evt: 'hls.gc', sessionId: '7e2a43a4-7336-4056-a638-48734539ca7e',
      idleMs: 62_000,
    }));
    expect(out).toContain('hls.gc');
    expect(out).toContain('62s');
    expect(out).toContain('cleaned');
  });

  it('renders client-report as a 3-line block', () => {
    const out = formatLine(evt({
      evt: 'client-report', reportTag: 'player-external-fallback',
      relPath: 'IT/S01E07.mkv', reason: 'hevc/aac', playMode: 'external',
      ua: 'Mac/Chrome 128',
    }));
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('client-report');
    expect(lines[0]).toContain('player-external-fallback');
    expect(lines[1]).toContain('reason: hevc/aac');
    expect(lines[2]).toContain('server.log');
  });

  it('falls back to a generic log tag when no evt is set', () => {
    const out = formatLine(evt({ msg: 'hello' }));
    expect(out).toContain('log');
    expect(out).toContain('hello');
  });
});

describe('shouldSuppress()', () => {
  it('suppresses a 200 share/status response by default', () => {
    const e = evt({ evt: 'response', url: '/api/share/status', statusCode: 200 });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).not.toBeNull();
  });

  it('does not suppress non-200 share/status responses', () => {
    const e = evt({ evt: 'response', url: '/api/share/status', statusCode: 503 });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).toBeNull();
  });

  it('does not suppress responses for other URLs', () => {
    const e = evt({ evt: 'response', url: '/api/library', statusCode: 200 });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).toBeNull();
  });

  it('suppresses 200 master.m3u8 polls (hls.js EVENT-mode refresh)', () => {
    const e = evt({
      evt: 'response',
      url: '/api/hls/master.m3u8?path=foo.mkv&start=0',
      statusCode: 200,
    });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)?.label).toBe('hls.master.m3u8');
  });

  it('does not suppress non-200 master.m3u8 responses (errors stay loud)', () => {
    const e = evt({
      evt: 'response',
      url: '/api/hls/master.m3u8?path=foo.mkv',
      statusCode: 415,
      level: 50,
    });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).toBeNull();
  });

  it('verbose mode bypasses suppression entirely (D9)', () => {
    const e = evt({ evt: 'response', url: '/api/share/status', statusCode: 200 });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, true)).toBeNull();
  });

  it('warnings and errors are never suppressed', () => {
    const e = evt({ level: 50, evt: 'response', url: '/api/share/status', statusCode: 200 });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).toBeNull();
  });

  it('client-report is never suppressed (D10)', () => {
    const e = evt({ evt: 'client-report', reportTag: 'p' });
    expect(shouldSuppress(e, DEFAULT_SUPPRESS, false)).toBeNull();
  });
});

describe('buildQuietLine()', () => {
  it('returns null when nothing was suppressed', () => {
    const counts = new Map<string, number>();
    expect(buildQuietLine(counts, 5 * 60_000, T, false)).toBeNull();
  });

  it('summarizes per-label counts and drains the map', () => {
    const counts = new Map<string, number>([
      ['share/status', 28],
      ['/api/foo', 2],
    ]);
    const out = buildQuietLine(counts, 5 * 60_000, T, false);
    expect(out).toContain('quiet');
    expect(out).toContain('suppressed 30');
    expect(out).toContain('share/status × 28');
    expect(out).toContain('/api/foo × 2');
    expect(out).toContain('5min');
    expect(counts.size).toBe(0);
  });
});

describe('ConsolePrettyStream — end-to-end drive', () => {
  it('drops suppressed lines and emits a quiet summary on the next visible event', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    // 30 share-status responses — every one suppressed.
    for (let i = 0; i < 30; i++) {
      tx.handleEvent(evt({
        evt: 'response', url: '/api/share/status', statusCode: 200,
        method: 'GET', ms: 0.5,
      }));
    }
    expect(out.text()).toBe('');
    // One real event arrives — the transport flushes the quiet summary
    // alongside it.
    tx.handleEvent(evt({
      evt: 'response', url: '/api/library', statusCode: 200, method: 'GET', ms: 5,
    }));
    const text = out.text();
    expect(text).toContain('quiet');
    expect(text).toContain('suppressed 30');
    expect(text).toContain('GET /api/library');
  });

  it('renders an error with structured payload follow-up line', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    tx.handleEvent({
      level: 50, time: T, evt: 'hls.spawnError', sessionId: '7e2a43a4',
      msg: 'hls ffmpeg spawn error',
    } as PinoEvent);
    const lines = out.text().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('hls.spawnError');
    expect(lines[1]).toContain('"sessionId":"7e2a43a4"');
  });

  it('verbose mode prints suppressed lines + structured payload', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, verbose: true, now: () => T });
    tx.handleEvent(evt({
      evt: 'response', url: '/api/share/status', statusCode: 200, method: 'GET', ms: 0.5,
    }));
    const lines = out.text().trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('share/status');
    expect(lines[1]).toContain('"url":"/api/share/status"');
  });

  it('reconstructs the live HLS counter from spawn/exit/gc (D6)', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out });
    tx.handleEvent(evt({ evt: 'hls.spawn', sessionId: 'a', profile: 'p' }));
    tx.handleEvent(evt({ evt: 'hls.spawn', sessionId: 'b', profile: 'p' }));
    expect(tx.liveHls.size).toBe(2);
    tx.handleEvent(evt({ evt: 'hls.gc', sessionId: 'a', idleMs: 60000 }));
    expect(tx.liveHls.has('a')).toBe(false);
    tx.handleEvent(evt({ evt: 'hls.exit', sessionId: 'b', code: 0, state: 'finished' }));
    expect(tx.liveHls.size).toBe(0);
  });

  it('fires onStateChange for HLS lifecycle and startup events', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out });
    let fired = 0;
    tx.onStateChange.push(() => { fired++; });
    tx.handleEvent(evt({ evt: 'startup', msg: 'listening' }));
    tx.handleEvent(evt({ evt: 'hls.spawn', sessionId: 'a', profile: 'p' }));
    tx.handleEvent(evt({ evt: 'hls.exit', sessionId: 'a', code: 0 }));
    expect(fired).toBe(3);
  });
});
