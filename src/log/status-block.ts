/**
 * Status block (0.1.7 Phase 4 / D5).
 *
 * A 3-line "live header" rendered above the scrolling log tail:
 *
 *   homemedia 0.1.7 · 192.168.101.185:3000 · started 14:32 (3h12m)
 *   encoders: nvenc · qsv · -videotoolbox
 *   live: 2 clients · 1 HLS session · share online
 *
 * Implementation strategy (D5): raw ANSI cursor save / move-home / write /
 * cursor restore. No TUI framework. The cost of `blessed` / `ink` would
 * dwarf the benefit of a sticky header. Tradeoff: very narrow terminals
 * (<60 cols) overflow — accepted, the non-TTY fallback path is always there.
 *
 * Non-TTY fallback: when `tty: false` (NSSM-redirected service log), the
 * block doesn't redraw at all. Instead a periodic 60s line goes through the
 * regular log channel tagged `state` so the JSON file stays informative.
 *
 * State sources:
 *   - `liveHls`: read from the transport's `liveHls` set on every render.
 *   - `clients`: a small in-process map keyed by remoteAddress, last-seen
 *     bumped on every `response` event seen by the transport.
 *   - `share`: tracks the current share-status response by reading the
 *     transport's most recent share-status event.
 *
 * The block does NOT poll. It renders in response to state-change events
 * fired by the transport (`onStateChange` callback array).
 */

import type { ConsolePrettyStream, PinoEvent } from './console-pretty.js';

export interface StatusSnapshot {
  appName: string;
  version: string;
  host: string;
  port: number;
  startedAt: number;
  /** Last-known encoder caps. Null when not detected yet. */
  encoders: { nvenc: boolean; qsv: boolean; videotoolbox: boolean } | null;
  liveHls: number;
  /** Distinct remoteAddress values seen in the last 5 minutes. */
  clients: number;
  /** Online iff the most-recent share-status response was 200. */
  shareOnline: boolean | null;
  /** Whether a scan is running. */
  scanning: boolean;
}

const RECENT_MS = 5 * 60_000;

export interface StatusBlockOptions {
  tty: boolean;
  out?: NodeJS.WritableStream;
  appName?: string;
  version?: string;
  host?: string;
  port?: number;
  /** Wall-clock now() — tests inject for deterministic age strings. */
  now?: () => number;
  /** Non-TTY fallback period (default 60s). Set to 0 to disable. */
  nonTtyIntervalMs?: number;
}

/** Pretty-format an "started X ago" string from a wall-clock duration. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d${remH}h`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Build the three text lines for a snapshot. Pure — pulled out of the
 * StatusBlock so tests can snapshot the rendering without driving ANSI.
 */
export function renderLines(s: StatusSnapshot, now: number): string[] {
  const age = formatAge(Math.max(0, now - s.startedAt));
  const head = `${s.appName} ${s.version} · ${s.host}:${s.port} · started ${fmtTime(s.startedAt)} (${age})`;
  const enc = s.encoders;
  const encLine = enc
    ? `encoders: ${enc.nvenc ? 'nvenc' : '-nvenc'} · ${enc.qsv ? 'qsv' : '-qsv'} · ${enc.videotoolbox ? 'videotoolbox' : '-videotoolbox'}`
    : 'encoders: probing…';
  const shareTxt = s.shareOnline === null
    ? 'share unknown'
    : s.shareOnline
      ? 'share online'
      : 'share offline';
  const hls = s.liveHls === 1 ? '1 HLS session' : `${s.liveHls} HLS sessions`;
  const clients = s.clients === 1 ? '1 client' : `${s.clients} clients`;
  const live = `live: ${clients} · ${hls} · ${shareTxt}${s.scanning ? ' · scanning' : ''}`;
  return [head, encLine, live];
}

/**
 * Status block manager. Subscribes to a transport's `onStateChange` and
 * `handleEvent` flow; on every state change, renders the 3-line block.
 *
 * On a TTY, the render uses a save/home/write/restore ANSI dance so the
 * scrolling tail underneath is preserved. On a non-TTY, render is a no-op
 * but a periodic 60s `state`-tagged line goes through the transport.
 */
export class StatusBlock {
  private readonly tty: boolean;
  private readonly out: NodeJS.WritableStream;
  private readonly now: () => number;
  private readonly appName: string;
  private readonly version: string;
  private host: string;
  private port: number;
  private readonly startedAt: number;
  private readonly nonTtyIntervalMs: number;

  private encoders: StatusSnapshot['encoders'] = null;
  private shareOnline: boolean | null = null;
  private scanning = false;
  /** map remoteAddress → last-seen ms */
  private readonly clientsLastSeen: Map<string, number> = new Map();
  /** Reference to the transport so render() can read liveHls. */
  private transport: ConsolePrettyStream | null = null;

  /** Remember the last rendered text so identical snapshots don't trigger
   *  a redraw flicker. */
  private lastRendered: string | null = null;

  /** Non-TTY fallback timer. */
  private periodic: NodeJS.Timeout | null = null;

  constructor(opts: StatusBlockOptions) {
    this.tty = opts.tty;
    this.out = opts.out ?? process.stdout;
    this.now = opts.now ?? Date.now;
    this.appName = opts.appName ?? 'homemedia';
    this.version = opts.version ?? '0.1.7';
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 3000;
    this.startedAt = this.now();
    this.nonTtyIntervalMs = opts.nonTtyIntervalMs ?? 60_000;
  }

  /** Wire to a transport: subscribe to state-change events and observe the
   *  raw event stream so the block can track clients, share status, and the
   *  scanning flag without a side channel. */
  attach(tx: ConsolePrettyStream): void {
    this.transport = tx;
    tx.onStateChange.push(() => this.render());
    // Clone the original handleEvent so we get a chance to inspect events
    // before they're rendered (no API on the transport for this today; we
    // wrap).
    const original = tx.handleEvent.bind(tx);
    tx.handleEvent = (e: PinoEvent): void => {
      this.observe(e);
      original(e);
    };
    if (!this.tty && this.nonTtyIntervalMs > 0) {
      // Periodic state line. Sends through the transport so it lands on the
      // same output stream alongside the scrolling tail.
      this.periodic = setInterval(() => {
        const s = this.snapshot();
        tx.handleEvent({
          level: 30,
          time: this.now(),
          evt: 'state',
          msg: renderLines(s, this.now()).join(' · '),
          ...s,
        } as PinoEvent);
      }, this.nonTtyIntervalMs);
      // Don't keep the process alive on its own.
      this.periodic.unref?.();
    }
  }

  /** Stop any background timers. Safe to call multiple times. */
  detach(): void {
    if (this.periodic) {
      clearInterval(this.periodic);
      this.periodic = null;
    }
  }

  /** Public: take a snapshot. Tests use this to assert state. */
  snapshot(): StatusSnapshot {
    const cutoff = this.now() - RECENT_MS;
    let active = 0;
    for (const ts of this.clientsLastSeen.values()) {
      if (ts >= cutoff) active++;
    }
    return {
      appName: this.appName,
      version: this.version,
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      encoders: this.encoders,
      liveHls: this.transport?.liveHls.size ?? 0,
      clients: active,
      shareOnline: this.shareOnline,
      scanning: this.scanning,
    };
  }

  /** Update startup info once the server is actually listening. */
  configureListening(host: string, port: number): void {
    this.host = host;
    this.port = port;
    this.render();
  }

  /** Update encoder caps once `detectEncoders()` resolves. */
  setEncoders(caps: { nvenc: boolean; qsv: boolean; videotoolbox: boolean }): void {
    this.encoders = caps;
    this.render();
  }

  setScanning(scanning: boolean): void {
    if (this.scanning === scanning) return;
    this.scanning = scanning;
    this.render();
  }

  private observe(e: PinoEvent): void {
    if (e.evt === 'response') {
      // Track the client we just served.
      const ip = typeof e.remoteAddress === 'string' ? e.remoteAddress : null;
      if (ip) this.clientsLastSeen.set(ip, this.now());
      // Track share status.
      if (e.url === '/api/share/status' && typeof e.statusCode === 'number') {
        const newOnline = e.statusCode === 200;
        if (this.shareOnline !== newOnline) {
          this.shareOnline = newOnline;
          this.render();
        }
      }
    }
    if (e.evt === 'scan.start') this.setScanning(true);
    else if (e.evt === 'scan.done' || e.evt === 'scan.error') this.setScanning(false);
  }

  /** Render the block. On TTY, write the ANSI dance. On non-TTY, this is a
   *  no-op (the periodic timer takes care of state lines). */
  render(): void {
    if (!this.tty) return;
    const lines = renderLines(this.snapshot(), this.now());
    const text = lines.join('|');
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    // ANSI: save cursor → home → clear-each-line + write → restore cursor.
    // We clear-line per line so partial overwrites of a longer previous
    // value don't leave trailing chars.
    const ESC = '\x1b[';
    const SAVE = `${ESC}s`;
    const RESTORE = `${ESC}u`;
    const HOME = `${ESC}H`;
    const CLEAR_LINE = `${ESC}2K`;
    const buf: string[] = [SAVE, HOME];
    for (const line of lines) {
      buf.push(`${CLEAR_LINE}${line}\n`);
    }
    buf.push(RESTORE);
    this.out.write(buf.join(''));
  }
}
