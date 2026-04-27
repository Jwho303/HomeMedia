/**
 * Prober — first-class tool that owns "what's inside this file" (0.1.4.3).
 *
 * Sits alongside the Scanner ("what files exist") rather than under it. The
 * scanner asks the prober to (re-)probe a single file when ingesting it; the
 * explicit re-probe library action force-probes every row; the stream route's
 * lazy-fallback covers anything that slipped through both.
 *
 * The single entry point is `probeFile()`. It is mtime-gated by default,
 * idempotent, and never throws — failures are logged and surfaced via the
 * returned `ProbeStatus` so callers can tally counts.
 */

import { probe as runFfprobe, type ProbeDeps } from './probe.js';
import type { DbHandle, ProbeResult } from './db.js';

export type ProbeStatus =
  | 'fresh'      // existing probe is current; no work performed
  | 'reprobed'   // ffprobe ran and the blob was updated
  | 'failed'     // ffprobe failed; row left as-is, error logged
  | 'skipped';   // file unreadable / disappeared between trigger and probe

export interface ProbeFileOptions {
  /** When true, ignore the mtime + v2-fields gate and re-probe regardless. */
  force?: boolean;
}

export interface ProbeFileLogger {
  warn(payload: { relPosix: string; err: unknown }, msg: string): void;
}

export interface ProbeFileDeps {
  /** Optional ffprobe deps override (used by tests to fake the spawn). */
  probeDeps?: ProbeDeps;
  /** Optional logger; defaults to silent. */
  logger?: ProbeFileLogger;
  /** Override the underlying ffprobe call (used by tests). */
  probe?: (absPath: string) => Promise<ProbeResult>;
}

/** v2 (0.1.4.3) probe blobs carry the `audioStreams` array. v1 blobs (from
 *  0.1.4) lack it and are treated as stale. */
export function hasV2Fields(blob: ProbeResult): boolean {
  return Array.isArray(blob.audioStreams);
}

/**
 * Probe a single file and persist the result. Idempotent: returns `'fresh'`
 * when the cached blob already matches the file's mtime AND has the v2 shape.
 * Returns `'reprobed'` when ffprobe ran and the blob was updated. Returns
 * `'failed'` when ffprobe threw — the existing row is left as-is and the
 * error is logged.
 */
export async function probeFile(
  absPath: string,
  relPosix: string,
  fileMtime: number,
  db: DbHandle,
  opts: ProbeFileOptions = {},
  deps: ProbeFileDeps = {},
): Promise<ProbeStatus> {
  const log = deps.logger;

  if (!opts.force) {
    const existing = db.getProbe(relPosix);
    if (existing && existing.probedAtMtime === fileMtime && hasV2Fields(existing)) {
      return 'fresh';
    }
  }

  let probeResult: ProbeResult;
  try {
    probeResult = deps.probe
      ? await deps.probe(absPath)
      : await runFfprobe(absPath, deps.probeDeps);
  } catch (err) {
    log?.warn({ relPosix, err }, 'ffprobe failed');
    return 'failed';
  }

  db.setProbe(relPosix, { ...probeResult, probedAtMtime: fileMtime });
  return 'reprobed';
}
