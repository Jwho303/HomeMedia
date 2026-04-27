import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import {
  StatusBlock,
  renderLines,
  formatAge,
  type StatusSnapshot,
} from '../../src/log/status-block.js';
import {
  ConsolePrettyStream,
  type PinoEvent,
} from '../../src/log/console-pretty.js';

class BufferStream extends Writable {
  chunks: string[] = [];
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    cb();
  }
  text(): string { return this.chunks.join(''); }
}

const T = 1_700_000_000_000;

describe('formatAge()', () => {
  it('renders sub-minute as seconds', () => {
    expect(formatAge(45_000)).toBe('45s');
  });
  it('renders minutes', () => {
    expect(formatAge(5 * 60_000)).toBe('5m');
  });
  it('renders hours + minutes', () => {
    expect(formatAge(3 * 3_600_000 + 12 * 60_000)).toBe('3h12m');
  });
  it('renders days + hours', () => {
    expect(formatAge(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d4h');
  });
});

describe('renderLines()', () => {
  function snap(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
    return {
      appName: 'homemedia',
      version: '0.1.7',
      host: '192.168.1.5',
      port: 3000,
      startedAt: T,
      encoders: { nvenc: true, qsv: false, videotoolbox: false },
      liveHls: 0,
      clients: 0,
      shareOnline: true,
      scanning: false,
      ...over,
    };
  }
  it('renders 3 lines', () => {
    const lines = renderLines(snap(), T + 5_000);
    expect(lines).toHaveLength(3);
  });
  it('encoders line marks unavailable encoders with a dash', () => {
    const lines = renderLines(snap(), T + 5_000);
    expect(lines[1]).toContain('nvenc');
    expect(lines[1]).toContain('-qsv');
    expect(lines[1]).toContain('-videotoolbox');
  });
  it('singular vs plural for sessions and clients', () => {
    const a = renderLines(snap({ liveHls: 1, clients: 1 }), T);
    expect(a[2]).toContain('1 client');
    expect(a[2]).toContain('1 HLS session');
    const b = renderLines(snap({ liveHls: 2, clients: 0 }), T);
    expect(b[2]).toContain('0 clients');
    expect(b[2]).toContain('2 HLS sessions');
  });
  it('appends · scanning when scanning is true', () => {
    const lines = renderLines(snap({ scanning: true }), T);
    expect(lines[2]).toContain('scanning');
  });
});

describe('StatusBlock — attached to a transport', () => {
  function evt(extra: Partial<PinoEvent> = {}): PinoEvent {
    return { level: 30, time: T, ...extra };
  }

  it('reflects HLS spawn/exit on the live counter (D6)', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    const block = new StatusBlock({ tty: false, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);

    tx.handleEvent(evt({ evt: 'hls.spawn', sessionId: 'a', profile: 'p' }));
    expect(block.snapshot().liveHls).toBe(1);
    tx.handleEvent(evt({ evt: 'hls.spawn', sessionId: 'b', profile: 'p' }));
    expect(block.snapshot().liveHls).toBe(2);
    tx.handleEvent(evt({ evt: 'hls.exit', sessionId: 'a', code: 0, state: 'finished' }));
    expect(block.snapshot().liveHls).toBe(1);
  });

  it('counts distinct clients seen in the last 5 minutes', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    const block = new StatusBlock({ tty: false, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);

    tx.handleEvent(evt({
      evt: 'response', method: 'GET', url: '/api/library', statusCode: 200,
      remoteAddress: '192.168.101.50',
    }));
    tx.handleEvent(evt({
      evt: 'response', method: 'GET', url: '/api/library', statusCode: 200,
      remoteAddress: '192.168.101.185',
    }));
    tx.handleEvent(evt({
      evt: 'response', method: 'GET', url: '/api/library', statusCode: 200,
      remoteAddress: '192.168.101.50',
    }));
    expect(block.snapshot().clients).toBe(2);
  });

  it('flips share online flag based on /api/share/status responses', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    const block = new StatusBlock({ tty: false, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);

    tx.handleEvent(evt({
      evt: 'response', url: '/api/share/status', statusCode: 200,
      remoteAddress: '127.0.0.1', method: 'GET',
    }));
    expect(block.snapshot().shareOnline).toBe(true);
    tx.handleEvent(evt({
      evt: 'response', url: '/api/share/status', statusCode: 503,
      remoteAddress: '127.0.0.1', method: 'GET',
    }));
    expect(block.snapshot().shareOnline).toBe(false);
  });

  it('non-TTY mode does not emit ANSI escapes on render()', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: false, out, now: () => T });
    const block = new StatusBlock({ tty: false, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);
    block.render();
    expect(out.text()).not.toMatch(/\x1b\[/);
  });

  it('TTY mode emits cursor save/home/restore sequences', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: true, out, now: () => T });
    const block = new StatusBlock({ tty: true, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);
    block.render();
    const text = out.text();
    expect(text).toContain('\x1b[s');
    expect(text).toContain('\x1b[H');
    expect(text).toContain('\x1b[u');
  });

  it('render() short-circuits when nothing has changed', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: true, out, now: () => T });
    const block = new StatusBlock({ tty: true, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);
    block.render();
    const first = out.text().length;
    block.render();
    expect(out.text().length).toBe(first);
  });

  it('setEncoders triggers a re-render with new caps', () => {
    const out = new BufferStream();
    const tx = new ConsolePrettyStream({ tty: true, out, now: () => T });
    const block = new StatusBlock({ tty: true, out, now: () => T, nonTtyIntervalMs: 0 });
    block.attach(tx);
    block.render();
    out.chunks.length = 0;
    block.setEncoders({ nvenc: true, qsv: true, videotoolbox: false });
    expect(out.text()).toContain('nvenc');
    expect(out.text()).toContain('qsv');
  });
});
