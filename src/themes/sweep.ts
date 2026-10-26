/**
 * Theme sweep (0.2.1): the background job that keeps skip markers current.
 *
 *   1. Fingerprint every alive episode that has no fingerprint yet, or whose
 *      file changed since (mtime). This is the only part that runs ffmpeg.
 *   2. Run the theme pass for every show with stale markers.
 *
 * Kicked off after each scan and at server startup. Single-flight: a request
 * while a sweep is running queues exactly one follow-up sweep. It reads and
 * writes only theme tables/columns, so it doesn't take the scan lock.
 */

import type { DbHandle, ProbeResult } from '../db.js';
import { toNativeAbsolute } from '../paths.js';
import { fingerprintWindow, hasChromaprint, type SpawnFn } from './fingerprint.js';
import { KIND_PARAMS } from './match.js';
import { MARKERS_VERSION, runThemePass } from './pass.js';
import { listEpisodesNeedingFingerprint, listSeriesNeedingMarkers, saveEpisodeFingerprint } from './store.js';

/** Bump to re-capture every fingerprint (e.g. window sizes changed). */
export const FINGERPRINT_VERSION = 1;
const CONCURRENCY = 2;
/** How often the console gets a progress line during a long fingerprint run. */
const PROGRESS_LOG_MS = 15_000;

export interface SweepLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface SweepDeps {
  db: DbHandle;
  mediaRoot: string;
  logger?: SweepLogger;
  spawn?: SpawnFn;
}

export interface SweepResult {
  fingerprinted: number;
  failed: number;
  series: number;
  themesLearned: number;
  episodesMarked: number;
}

/** Pick the audio stream playback uses by default: the first one (`-map 0:a:0`). */
export function pickAudioIndex(probe: ProbeResult | null): number | null {
  const streams = probe?.audioStreams;
  if (!streams) return 0; // not probed yet / old probe shape — try the first stream
  if (streams.length === 0) return null; // no audio at all
  return streams[0]!.audioIndex;
}

function parseProbe(json: string | null): ProbeResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ProbeResult;
  } catch {
    return null;
  }
}

export async function fingerprintEpisode(
  absPath: string,
  probe: ProbeResult | null,
  spawnFn?: SpawnFn,
): Promise<{ head: Uint32Array | null; tail: Uint32Array | null; tailOffsetS: number | null }> {
  const audioIndex = pickAudioIndex(probe);
  if (audioIndex === null) return { head: null, tail: null, tailOffsetS: null };
  const duration = probe?.durationSeconds ?? 0;
  const head = await fingerprintWindow(absPath, { audioIndex, startS: 0, durationS: KIND_PARAMS.opening.windowS }, spawnFn);
  if (!(duration > 0)) return { head, tail: null, tailOffsetS: null };
  const tailOffsetS = Math.max(0, duration - KIND_PARAMS.ending.windowS);
  const tail = await fingerprintWindow(absPath, { audioIndex, startS: tailOffsetS, durationS: KIND_PARAMS.ending.windowS }, spawnFn);
  return { head, tail, tailOffsetS };
}

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, mediaRoot, logger } = deps;
  const result: SweepResult = { fingerprinted: 0, failed: 0, series: 0, themesLearned: 0, episodesMarked: 0 };

  if (!(await hasChromaprint(deps.spawn))) {
    logger?.warn({ evt: 'themes' }, 'ffmpeg has no chromaprint muxer; skip intro/credits disabled');
    return result;
  }

  const todo = listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION);
  setStatus({ running: true, phase: 'fingerprint', done: 0, total: todo.length, current: null, startedAt: Date.now(), showsDone: 0, episodesMarked: 0 });
  if (todo.length > 0) logger?.info({ evt: 'themes', episodes: todo.length }, `skip intro/credits: fingerprinting ${todo.length} episodes`);

  // Group by show (the backlog is ordered by show) so each show gets its
  // markers as soon as its own episodes are done, not after the whole library.
  const byShow = new Map<number, typeof todo>();
  for (const ep of todo) {
    const list = byShow.get(ep.seriesId) ?? [];
    list.push(ep);
    byShow.set(ep.seriesId, list);
  }

  const markShow = async (seriesId: number): Promise<void> => {
    try {
      const r = runThemePass(db, seriesId);
      result.series++;
      result.themesLearned += r.themesLearned;
      result.episodesMarked += r.episodesMarked;
      setStatus({ showsDone: status.showsDone + 1, episodesMarked: status.episodesMarked + r.episodesMarked });
    } catch (err) {
      logger?.warn({ evt: 'themes', seriesId, err }, 'theme pass failed');
    }
    // Let other work (HTTP requests) in between shows.
    await new Promise((res) => setImmediate(res));
  };

  let done = 0;
  let lastLog = Date.now();
  for (const [seriesId, eps] of byShow) {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < eps.length) {
        const ep = eps[next++]!;
        setStatus({ current: `${ep.seriesTitle ?? 'Unknown'} S${pad(ep.season)}E${pad(ep.episode)}` });
        const probe = parseProbe(ep.probeJson);
        try {
          const fp = await fingerprintEpisode(toNativeAbsolute(ep.path, mediaRoot), probe, deps.spawn);
          saveEpisodeFingerprint(db, { episodeId: ep.id, mtime: ep.mtime, version: FINGERPRINT_VERSION, ...fp });
          if (fp.head || fp.tail) result.fingerprinted++;
          else result.failed++;
        } catch (err) {
          result.failed++;
          logger?.warn({ evt: 'themes', path: ep.path, err }, 'fingerprint failed');
        }
        done++;
        setStatus({ done });
        if (Date.now() - lastLog > PROGRESS_LOG_MS) {
          lastLog = Date.now();
          logger?.info({ evt: 'themes', done, total: todo.length }, `skip intro/credits: fingerprinted ${done}/${todo.length} (${status.current})`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setStatus({ phase: 'match', current: eps[0]?.seriesTitle ?? null });
    await markShow(seriesId);
    setStatus({ phase: 'fingerprint' });
  }

  // Shows with no new fingerprints but stale markers (matcher version bump, relearn).
  setStatus({ phase: 'match' });
  for (const seriesId of listSeriesNeedingMarkers(db, MARKERS_VERSION)) {
    setStatus({ current: showTitle(db, seriesId) });
    await markShow(seriesId);
  }

  setStatus({ running: false, phase: null, current: null, finishedAt: Date.now() });
  if (result.fingerprinted || result.series) {
    logger?.info(
      { evt: 'themes', ...result },
      `skip intro/credits: done, ${result.fingerprinted} episodes fingerprinted, ${result.episodesMarked} marked across ${result.series} shows`,
    );
  }
  return result;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function showTitle(db: DbHandle, seriesId: number): string | null {
  const r = db.raw.prepare('SELECT title FROM media_items WHERE id = ?').get(seriesId) as { title: string | null } | undefined;
  return r?.title ?? null;
}

// ---- live status (status block, /api/themes/status) -------------------

export interface SweepStatus {
  running: boolean;
  /** 'fingerprint' = reading audio; 'match' = finding themes for a show. */
  phase: 'fingerprint' | 'match' | null;
  /** Episodes fingerprinted so far / in this run. */
  done: number;
  total: number;
  /** What's being worked on, e.g. "Archer S02E02". */
  current: string | null;
  showsDone: number;
  episodesMarked: number;
  startedAt: number | null;
  finishedAt: number | null;
}

let status: SweepStatus = {
  running: false, phase: null, done: 0, total: 0, current: null, showsDone: 0, episodesMarked: 0, startedAt: null, finishedAt: null,
};
const statusListeners = new Set<(s: SweepStatus) => void>();

function setStatus(patch: Partial<SweepStatus>): void {
  status = { ...status, ...patch };
  for (const l of statusListeners) l(status);
}

export function getSweepStatus(): SweepStatus {
  return status;
}

export function onSweepStatus(listener: (s: SweepStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

let running: Promise<SweepResult> | null = null;
let queued = false;

/** Start a sweep in the background, or queue one if a sweep is already running. Never throws. */
export function requestSweep(deps: SweepDeps): void {
  if (running) {
    queued = true;
    return;
  }
  running = runSweep(deps)
    .catch((err) => {
      deps.logger?.warn({ evt: 'themes', err }, 'theme sweep crashed');
      return null as unknown as SweepResult;
    })
    .finally(() => {
      running = null;
      if (queued) {
        queued = false;
        requestSweep(deps);
      }
    });
}

export function isSweepRunning(): boolean {
  return running !== null;
}
