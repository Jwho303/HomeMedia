/**
 * Console-pretty transport (0.1.7).
 *
 * Renders the Pino JSON event stream into one human-readable line per event,
 * with a fixed-width tag column inferred from the `evt:` field. Implemented
 * as a `Writable` stream so it can be passed to Fastify's logger via
 * `{ logger: { stream: ... } }` and run in-process — avoids the
 * cross-thread complexity of a Pino worker transport while keeping the
 * event shape Pino itself produces.
 *
 * Two presentations of the same event stream:
 *   - This transport renders for the terminal (color + tag column + suppression).
 *   - The raw Pino JSON line is what NSSM-redirected stdout would otherwise
 *     get; we render onto stdout directly when wired.
 *
 * The transport is intentionally narrow:
 *   - It reads only the `evt` field (D4) for tag routing; falls back to a
 *     generic `log` tag for events from third-party libs (Fastify internals,
 *     etc.).
 *   - The suppression list is hard-coded inside this file (D2).
 *   - `LOG_VERBOSE=true` (or `--verbose`) bypasses suppression entirely (D9).
 *   - Errors and warnings (level >= 40) are NEVER suppressed.
 *   - `client-report` (D10) is never suppressed.
 *
 * State is per-instance:
 *   - `suppressed`: counts of events that hit a SUPPRESS predicate, keyed by
 *     a short label, drained on the periodic `quiet` line.
 *   - `liveHls`: a Set of session ids reconstructed from `hls.spawn` /
 *     `hls.exit` / `hls.gc` events (D6). Drives the live-state status block
 *     when wired (Phase 4).
 */

import { Writable } from 'node:stream';

// ANSI helpers — small enough not to take a dependency on chalk.
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;

/** Pino event shape we care about. Other fields are ignored — we don't need
 *  them to render. */
export interface PinoEvent {
  level: number;
  time: number;
  msg?: string;
  evt?: string;
  reqId?: string | number;
  // Request-side fields (D3 — we generate the response line ourselves).
  req?: {
    method?: string;
    url?: string;
    remoteAddress?: string;
  };
  res?: {
    statusCode?: number;
  };
  responseTime?: number;
  // Response-line fields populated by our onResponse hook.
  method?: string;
  url?: string;
  statusCode?: number;
  ms?: number;
  // HLS fields.
  sessionId?: string;
  segName?: string;
  bytes?: number;
  relPath?: string;
  profile?: string;
  state?: string;
  code?: number | null;
  signal?: string | null;
  idleMs?: number;
  // client-report fields.
  reportTag?: string;
  ua?: string | null;
  reason?: string;
  playMode?: string;
  // Misc passthrough.
  err?: unknown;
  encoders?: { nvenc?: boolean; qsv?: boolean; videotoolbox?: boolean };
  [key: string]: unknown;
}

/** A predicate that, when it returns true for an event, asks the transport
 *  to suppress that event from the rendered console (D2). Errors / warnings
 *  / `client-report` lines bypass these regardless. */
export type SuppressPredicate = (e: PinoEvent) => boolean;

/** Hard-coded suppression list (D2). Each entry has a short label so the
 *  periodic `quiet` line can summarize "what we hid". */
export interface SuppressionEntry {
  label: string;
  match: SuppressPredicate;
}

export const DEFAULT_SUPPRESS: SuppressionEntry[] = [
  // Idle health-pings the user does not need to see.
  {
    label: 'share/status',
    match: (e) =>
      e.evt === 'response' &&
      e.url === '/api/share/status' &&
      e.statusCode === 200,
  },
  // The pre-suppression onRequest line for the same route. We don't emit
  // a separate request line in 0.1.7 (D3), but if a future spec re-enables
  // it this entry keeps share-status quiet.
  {
    label: 'share/status',
    match: (e) => e.evt === 'request' && e.url === '/api/share/status',
  },
  // hls.js polls the EVENT-mode master playlist on its refresh cycle while
  // ffmpeg is still encoding (the manifest grows as new segments land, so
  // hls.js treats it as a live-style playlist). On a healthy stream the
  // polls are 1-2ms each and identical aside from query params; collapse
  // them in the rendered console so the segment / lifecycle events stay
  // legible. The JSON file still records every poll.
  {
    label: 'hls.master.m3u8',
    match: (e) =>
      e.evt === 'response' &&
      typeof e.url === 'string' &&
      e.url.startsWith('/api/hls/master.m3u8') &&
      e.statusCode === 200,
  },
];

export interface PrettyOptions {
  /** True when stdout is a terminal. Drives ANSI emission + status-block
   *  redraws. When false (NSSM-redirected service log), we emit no escapes
   *  and fall back to a periodic state-line in the transport's caller. */
  tty?: boolean;
  /** Disables suppression entirely. Mirrors `LOG_VERBOSE=true` (D9). */
  verbose?: boolean;
  /** Output stream — defaults to `process.stdout`. Tests pass a buffer. */
  out?: NodeJS.WritableStream;
  /** Suppression list. Defaults to `DEFAULT_SUPPRESS`. Tests pass `[]` to
   *  see every line. */
  suppress?: SuppressionEntry[];
  /** Wall-clock now() — tests inject for deterministic quiet-line timing. */
  now?: () => number;
  /** How often to flush the per-window quiet summary line. Default 5min. */
  quietWindowMs?: number;
}

/** Rendering result for one event. The transport writes `text + '\n'` when
 *  not null. `null` means the event was suppressed. */
export interface FormatResult {
  text: string | null;
  /** Tag label that was matched against the suppression list, when any.
   *  Useful for the quiet-summary counter. */
  suppressedLabel?: string;
}

/** Pad a tag column on the right so messages line up. */
function padTag(tag: string, width = 14): string {
  if (tag.length >= width) return tag;
  return tag + ' '.repeat(width - tag.length);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtBytes(b: number | undefined): string {
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(id: string | undefined): string {
  if (!id) return '';
  // First 8 hex chars of a UUID — enough to disambiguate at a glance.
  return id.slice(0, 8);
}

/** Color helper that's a no-op when colors are off. */
function colored(useColor: boolean, color: string, s: string): string {
  if (!useColor) return s;
  return `${color}${s}${RESET}`;
}

function colorForStatus(useColor: boolean, status: number): string {
  if (!useColor) return String(status);
  if (status >= 500) return colored(true, RED, String(status));
  if (status >= 400) return colored(true, YELLOW, String(status));
  if (status >= 300) return colored(true, CYAN, String(status));
  return colored(true, GREEN, String(status));
}

/**
 * Format one event. Pure — does not consult any transport-instance state
 * (suppression counts, live HLS, etc.). The transport calls this and decides
 * what to do with the result.
 *
 * Verbose mode: we still render the same shape, but we append a JSON tail
 * with the structured payload so operators can see everything.
 */
export function formatLine(
  e: PinoEvent,
  opts: { tty?: boolean; verbose?: boolean } = {},
): string {
  const tty = opts.tty === true;
  const time = colored(tty, DIM, fmtTime(e.time ?? Date.now()));

  // Pick a tag + body. Tag inference is intentionally narrow — D4 says we
  // route on `evt`, with a `log` fallback for anything else.
  let tag = 'log';
  let body = e.msg ?? '';

  switch (e.evt) {
    case 'response': {
      const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
      tag = '←';
      const arrow = status >= 500 ? colored(tty, RED, '←')
        : status >= 400 ? colored(tty, YELLOW, '←')
        : colored(tty, DIM, '←');
      const method = e.method ?? '?';
      const url = e.url ?? '';
      const ms = typeof e.ms === 'number' ? `${e.ms.toFixed(1)}ms` : '';
      tag = `${arrow}${' '.repeat(Math.max(0, 13))}`;
      // Use a fixed-width "← " + status as the tag column.
      const tagCol = `${arrow} ${colorForStatus(tty, status)}`.padEnd(tty ? 24 : 14);
      body = `${method} ${url}${ms ? '  ' + colored(tty, DIM, ms) : ''}`;
      return `${time}  ${tagCol}  ${body}`;
    }
    case 'request': {
      const method = e.method ?? e.req?.method ?? '?';
      const url = e.url ?? e.req?.url ?? '';
      const tagCol = colored(tty, DIM, padTag('→ ' + method));
      return `${time}  ${tagCol}  ${url}`;
    }
    case 'hls.spawn': {
      const id = shortId(e.sessionId);
      const profile = typeof e.profile === 'string' ? e.profile : '';
      tag = padTag(colored(tty, MAGENTA, 'hls.spawn'));
      body = `${id}${profile ? ` · profile=${profile}` : ''}${e.relPath ? ` · ${e.relPath}` : ''}`;
      return `${time}  ${tag}  ${body}`;
    }
    case 'hls.exit': {
      const id = shortId(e.sessionId);
      tag = padTag(colored(tty, MAGENTA, 'hls.exit'));
      const code = e.code ?? null;
      const state = typeof e.state === 'string' ? e.state : '';
      body = `${id}${state ? ` · state=${state}` : ''}${code !== null ? ` · code=${code}` : ''}`;
      return `${time}  ${tag}  ${body}`;
    }
    case 'hls.gc': {
      const id = shortId(e.sessionId);
      const idle = typeof e.idleMs === 'number' ? `${Math.floor(e.idleMs / 1000)}s` : '';
      tag = padTag(colored(tty, DIM, 'hls.gc'));
      body = `${id}${idle ? ` · idle ${idle}` : ''} · cleaned`;
      return `${time}  ${tag}  ${body}`;
    }
    case 'hls.segment': {
      const id = shortId(e.sessionId);
      const seg = typeof e.segName === 'string' ? e.segName : '';
      const size = fmtBytes(typeof e.bytes === 'number' ? e.bytes : undefined);
      tag = padTag(colored(tty, DIM, 'hls.segment'));
      body = `${id} · ${seg}${size ? ` · ${size}` : ''}`;
      return `${time}  ${tag}  ${body}`;
    }
    case 'hls.spawnError':
    case 'hls.cleanup':
    case 'hls.orphanRmFailed': {
      tag = padTag(colored(tty, RED, e.evt));
      body = e.msg ?? '';
      return `${time}  ${tag}  ${body}`;
    }
    case 'startup': {
      tag = padTag(colored(tty, BLUE, 'startup'));
      body = e.msg ?? '';
      return `${time}  ${tag}  ${body}`;
    }
    case 'client-report': {
      // Three-line summary (D10). The follow-up lines are indented by the
      // tag-column width so they line up under the body.
      const indent = ' '.repeat(2 + 14 + 2);
      const reportTag = typeof e.reportTag === 'string' ? e.reportTag : 'report';
      const relPath = typeof e.relPath === 'string' ? e.relPath : '';
      const reason = typeof e.reason === 'string' ? e.reason : '';
      const playMode = typeof e.playMode === 'string' ? e.playMode : '';
      const ua = typeof e.ua === 'string' ? e.ua : '';
      tag = padTag(colored(tty, MAGENTA, 'client-report'));
      const head = `${reportTag}${relPath ? ' · ' + relPath : ''}${ua ? ' · UA="' + ua + '"' : ''}`;
      const detail = [
        reason ? `reason: ${reason}` : '',
        playMode ? `playMode=${playMode}` : '',
      ].filter(Boolean).join(' · ');
      const lines = [`${time}  ${tag}  ${head}`];
      if (detail) lines.push(`${indent}${colored(tty, DIM, detail)}`);
      lines.push(`${indent}${colored(tty, DIM, '→ see %PROGRAMDATA%\\HomeMedia\\logs\\server.log for full dump')}`);
      return lines.join('\n');
    }
    default: {
      // Unknown evt or no evt — render generically. Errors / warnings get a
      // colored tag; everything else stays dim.
      const isErr = (e.level ?? 30) >= 50;
      const isWarn = (e.level ?? 30) >= 40 && !isErr;
      const color = isErr ? RED : isWarn ? YELLOW : DIM;
      tag = padTag(colored(tty, color, e.evt ?? 'log'));
      body = e.msg ?? '';
      return `${time}  ${tag}  ${body}`;
    }
  }
}

/** Apply suppression. Errors / warnings / client-report bypass suppression
 *  (D2 / D10). */
export function shouldSuppress(
  e: PinoEvent,
  suppress: SuppressionEntry[],
  verbose: boolean,
): SuppressionEntry | null {
  if (verbose) return null;
  const level = e.level ?? 30;
  if (level >= 40) return null;
  if (e.evt === 'client-report') return null;
  for (const entry of suppress) {
    if (entry.match(e)) return entry;
  }
  return null;
}

/**
 * Build the periodic `quiet` summary line. Returns null when no suppressed
 * events have accumulated. Drains the input map.
 */
export function buildQuietLine(
  counts: Map<string, number>,
  windowMs: number,
  now: number,
  tty: boolean,
): string | null {
  let total = 0;
  for (const v of counts.values()) total += v;
  if (total === 0) return null;
  const parts: string[] = [];
  for (const [label, n] of counts.entries()) {
    parts.push(`${label} × ${n}`);
  }
  counts.clear();
  const time = colored(tty, DIM, fmtTime(now));
  const tag = padTag(colored(tty, DIM, 'quiet'));
  const body = colored(
    tty,
    DIM,
    `suppressed ${total} lines (${parts.join(', ')}) · last ${Math.round(windowMs / 60_000)}min`,
  );
  return `${time}  ${tag}  ${body}`;
}

/**
 * The Writable that Fastify pipes its JSON pino events into. One JSON line
 * per event; we parse, route, possibly suppress, and write the rendered line
 * to `out`.
 */
export class ConsolePrettyStream extends Writable {
  private readonly tty: boolean;
  private readonly verbose: boolean;
  private readonly out: NodeJS.WritableStream;
  private readonly suppress: SuppressionEntry[];
  private readonly now: () => number;
  private readonly quietWindowMs: number;

  /** Per-window suppression counts, keyed by suppression entry label. */
  private readonly suppressedCounts: Map<string, number> = new Map();
  private lastQuietFlush: number;

  /** Live HLS session ids (D6). The transport reconstructs by listening to
   *  its own input stream — no separate IPC into HlsSessionManager. */
  readonly liveHls: Set<string> = new Set();

  /** Listeners notified when state-relevant events arrive (HLS spawn/exit,
   *  share status change, scan progress, listening). Phase 4 wires the
   *  status block to these. */
  readonly onStateChange: Array<() => void> = [];

  constructor(opts: PrettyOptions = {}) {
    super();
    this.tty = opts.tty ?? false;
    this.verbose = opts.verbose ?? false;
    this.out = opts.out ?? process.stdout;
    this.suppress = opts.suppress ?? DEFAULT_SUPPRESS;
    this.now = opts.now ?? Date.now;
    this.quietWindowMs = opts.quietWindowMs ?? 5 * 60_000;
    this.lastQuietFlush = this.now();
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Pino emits one JSON line per event but the Writable contract may give
    // us a buffer with multiple lines or a partial line. Split on newlines
    // and parse each — best-effort; non-JSON lines are passed through raw
    // so we don't drop them silently.
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      this.handleLine(line);
    }
    cb();
  }

  /** Public so tests can drive events directly without going through stdin. */
  handleLine(line: string): void {
    let e: PinoEvent | null = null;
    try {
      e = JSON.parse(line) as PinoEvent;
    } catch {
      // Not JSON — render raw. Useful when a third-party lib writes plain
      // strings into the pipe.
      this.write_(line);
      return;
    }
    this.handleEvent(e);
  }

  /** Drive a single event into the transport. The status-block code path
   *  (Phase 4) calls this from outside the stream when injecting state-only
   *  events that don't go through Pino. */
  handleEvent(e: PinoEvent): void {
    // Track live HLS sessions regardless of suppression (D6).
    if (e.evt === 'hls.spawn' && typeof e.sessionId === 'string') {
      this.liveHls.add(e.sessionId);
      this.fireStateChange();
    } else if ((e.evt === 'hls.exit' || e.evt === 'hls.gc') && typeof e.sessionId === 'string') {
      this.liveHls.delete(e.sessionId);
      this.fireStateChange();
    } else if (e.evt === 'startup' || e.evt === 'scan.start' || e.evt === 'scan.done') {
      this.fireStateChange();
    }

    const drop = shouldSuppress(e, this.suppress, this.verbose);
    if (drop) {
      const cur = this.suppressedCounts.get(drop.label) ?? 0;
      this.suppressedCounts.set(drop.label, cur + 1);
      this.maybeFlushQuiet();
      return;
    }
    // A real event arrived — flush any pending quiet line so the user sees
    // the floor count alongside the next visible event (the spec asks for
    // "every 5 min OR on first non-suppressed event after a long quiet").
    this.maybeFlushQuiet({ force: true });
    const rendered = formatLine(e, { tty: this.tty, verbose: this.verbose });
    this.write_(rendered);
    if (this.verbose) {
      // Append the structured payload on a follow-up indented line. Errors /
      // warnings always do this even in default mode (per the spec).
      this.write_(this.indentedPayload(e));
      return;
    }
    if ((e.level ?? 30) >= 40) {
      this.write_(this.indentedPayload(e));
    }
  }

  /** Time-driven flush. Called from inside the stream as events arrive; the
   *  spec says "every 5 minutes (or on first non-suppressed event after
   *  long quiet)". `force: true` skips the elapsed-time check. */
  private maybeFlushQuiet(opts: { force?: boolean } = {}): void {
    const now = this.now();
    const elapsed = now - this.lastQuietFlush;
    if (!opts.force && elapsed < this.quietWindowMs) return;
    if (this.suppressedCounts.size === 0) {
      this.lastQuietFlush = now;
      return;
    }
    const line = buildQuietLine(
      this.suppressedCounts,
      this.quietWindowMs,
      now,
      this.tty,
    );
    if (line) this.write_(line);
    this.lastQuietFlush = now;
  }

  /** Test helper / Phase-4 hook: force a quiet flush regardless of timing. */
  flushQuiet(): void {
    this.maybeFlushQuiet({ force: true });
  }

  private indentedPayload(e: PinoEvent): string {
    const indent = ' '.repeat(2 + 14 + 2);
    // Drop noisy fields that would dominate the line.
    const { time, level, msg, evt, hostname, pid, ...rest } = e as Record<string, unknown>;
    void time; void level; void msg; void evt; void hostname; void pid;
    return `${indent}${this.tty ? DIM : ''}${JSON.stringify(rest)}${this.tty ? RESET : ''}`;
  }

  private write_(line: string): void {
    this.out.write(line + '\n');
  }

  private fireStateChange(): void {
    for (const fn of this.onStateChange) {
      try { fn(); } catch { /* ignore listener errors */ }
    }
  }
}

/** Convenience factory. Reads `LOG_VERBOSE`, picks `process.stdout.isTTY`. */
export function makeConsolePrettyStream(): ConsolePrettyStream {
  const verbose = String(process.env.LOG_VERBOSE ?? '').toLowerCase() === 'true'
    || process.argv.includes('--verbose');
  if (verbose) {
    // Banner so the operator knows the suppression list isn't running.
    process.stderr.write('[homemedia] LOG_VERBOSE=true — console suppression disabled\n');
  }
  return new ConsolePrettyStream({
    tty: process.stdout.isTTY === true,
    verbose,
  });
}
