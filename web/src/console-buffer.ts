/**
 * Captures the last N console messages + uncaught errors into a ring buffer.
 *
 * The player's "Report" button drains this buffer into a payload for
 * `/api/client-log`. The user runs the app on a remote machine where
 * copy/pasting the devtools console isn't practical; this lets them ship the
 * recent log tail back to the server with one click.
 *
 * Only side-effects: importing this module once at startup wraps the global
 * console + window error listeners. `getConsoleBuffer()` returns a snapshot.
 *
 * Original console methods are preserved so devtools still shows messages
 * normally — the wrapper records *and* forwards.
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  /** Wall-clock ISO string. */
  at: string;
  level: ConsoleLevel | 'error.uncaught' | 'error.unhandledrejection';
  /** Args formatted to strings. Objects are JSON-stringified (truncated). */
  args: string[];
}

const MAX_ENTRIES = 200;
const MAX_ARG_LENGTH = 4_000; // each formatted arg is capped to this many chars
const buffer: ConsoleEntry[] = [];

function formatArg(a: unknown): string {
  if (a instanceof Error) {
    return `${a.name}: ${a.message}\n${a.stack ?? '(no stack)'}`;
  }
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean' || a == null) {
    return String(a);
  }
  try {
    const s = JSON.stringify(a);
    return s ?? String(a);
  } catch {
    return String(a);
  }
}

function pushEntry(level: ConsoleEntry['level'], args: unknown[]): void {
  const formatted = args.map((a) => {
    const s = formatArg(a);
    return s.length > MAX_ARG_LENGTH ? `${s.slice(0, MAX_ARG_LENGTH)}…[truncated]` : s;
  });
  buffer.push({ at: new Date().toISOString(), level, args: formatted });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

let installed = false;

export function installConsoleBuffer(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const c = window.console;
  const wrap = (level: ConsoleLevel): void => {
    const original = c[level]?.bind(c);
    if (!original) return;
    c[level] = (...args: unknown[]): void => {
      pushEntry(level, args);
      original(...args);
    };
  };
  wrap('log');
  wrap('info');
  wrap('warn');
  wrap('error');
  wrap('debug');

  window.addEventListener('error', (ev) => {
    pushEntry('error.uncaught', [
      ev.message,
      `at ${ev.filename}:${ev.lineno}:${ev.colno}`,
      ev.error instanceof Error ? ev.error : null,
    ]);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    // Filter the well-known `play()` AbortError that fires whenever a
    // <video>'s source is swapped while a play() promise is in flight. It's
    // documented browser behavior (https://goo.gl/LdLk22) — happens on every
    // episode change in HLS mode and adds nothing to a diagnostic report.
    if (isPlayAbortError(ev.reason)) return;
    pushEntry('error.unhandledrejection', [ev.reason]);
  });
}

/** Whitelist for the harmless AbortError fired when `<video>.play()` races
 *  with a source change. Detects DOMException name `AbortError` whose
 *  message references the play() / pause() interrupt. */
function isPlayAbortError(reason: unknown): boolean {
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return /play\(\)|media was removed/i.test(reason.message);
  }
  if (reason && typeof reason === 'object' && 'name' in reason && (reason as { name?: string }).name === 'AbortError') {
    const msg = String((reason as { message?: string }).message ?? '');
    return /play\(\)|media was removed/i.test(msg);
  }
  return false;
}

/** Snapshot the current buffer. Returns a copy so callers can stringify
 *  without worrying about concurrent appends. */
export function getConsoleBuffer(): ConsoleEntry[] {
  return buffer.slice();
}
