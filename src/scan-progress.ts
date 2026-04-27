/**
 * Scan progress channel (0.1.5.1).
 *
 * Per-job ring buffer + emitter plumbing. Each scan-flavored job (smart
 * refresh, hard refresh, per-item re-probe, library-wide re-probe) registers
 * a job here and emits `ProgressEvent`s; the SSE route attaches to the
 * current job, replays buffered events, and streams live ones.
 *
 * Why a ring buffer: there's a real ~50ms gap between the POST returning
 * `202 { jobId }` and the EventSource attaching. A small library can finish
 * `walk` and `diff` in that window. Buffering bridges the gap. After the
 * `done` event the entry sticks around for `JOB_RETENTION_MS` so a slow
 * client reconnect can still receive the result.
 */

import type { ScanResult } from './scan.js';

export type ProgressEvent =
  | { type: 'walk'; scanned: number }
  | { type: 'diff'; dirty: number; disappeared: number; total: number }
  | { type: 'cohort'; key: string; size: number }
  | {
      type: 'file';
      i: number;
      n: number;
      path: string;
      phase: 'identify' | 'persist';
    }
  | {
      type: 'probe';
      i: number;
      n: number;
      path: string;
      status: 'fresh' | 'reprobed' | 'failed' | 'skipped';
    }
  | { type: 'done'; result: ScanResult | Record<string, unknown> }
  | { type: 'error'; message: string };

export type JobKind =
  | 'refresh-smart'
  | 'refresh-hard'
  | 'reprobe-library'
  | 'reprobe-item'
  | 'reprobe-episode';

export interface JobMeta {
  jobId: string;
  kind: JobKind;
  startedAt: number;
}

export interface ProgressEmitter {
  emit(event: ProgressEvent): void;
}

const RING_CAPACITY = 100;
const JOB_RETENTION_MS = 5_000;

interface JobState {
  meta: JobMeta;
  buffer: ProgressEvent[];
  done: boolean;
  subscribers: Set<(event: ProgressEvent) => void>;
  reapTimer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, JobState>();
let currentJobId: string | null = null;

function newJobId(): string {
  // Short unique id; collision-resistant enough for in-process jobs.
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Register a new job. Sets it as the current job. The returned emitter is
 *  what the scan-side code calls; the SSE route reads from `attach()`. */
export function registerJob(kind: JobKind): { meta: JobMeta; emitter: ProgressEmitter } {
  const jobId = newJobId();
  const meta: JobMeta = { jobId, kind, startedAt: Date.now() };
  const state: JobState = {
    meta,
    buffer: [],
    done: false,
    subscribers: new Set(),
    reapTimer: null,
  };
  jobs.set(jobId, state);
  currentJobId = jobId;
  const emitter: ProgressEmitter = {
    emit(event: ProgressEvent): void {
      pushEvent(state, event);
    },
  };
  return { meta, emitter };
}

function pushEvent(state: JobState, event: ProgressEvent): void {
  state.buffer.push(event);
  if (state.buffer.length > RING_CAPACITY) {
    // Keep the most-recent N events.
    state.buffer.splice(0, state.buffer.length - RING_CAPACITY);
  }
  for (const sub of state.subscribers) {
    try {
      sub(event);
    } catch {
      /* a misbehaving subscriber must not crash the scan */
    }
  }
  if (event.type === 'done' || event.type === 'error') {
    finalize(state);
  }
}

function finalize(state: JobState): void {
  if (state.done) return;
  state.done = true;
  // Hold the buffer for a short retention window so a late SSE attach still
  // sees the `done` event. The job stays reachable as the "current" job
  // during retention — the SSE handler will replay history and close
  // immediately once it sees the done event in the buffer.
  if (state.reapTimer) clearTimeout(state.reapTimer);
  state.reapTimer = setTimeout(() => {
    jobs.delete(state.meta.jobId);
    if (currentJobId === state.meta.jobId) currentJobId = null;
    state.subscribers.clear();
  }, JOB_RETENTION_MS);
}

/** What the SSE route reads. Returns the buffered history and a subscribe
 *  helper for live events. Returns `null` when the job no longer exists. */
export interface JobAttachment {
  meta: JobMeta;
  history: ProgressEvent[];
  done: boolean;
  subscribe(handler: (event: ProgressEvent) => void): () => void;
}

export function attach(jobId: string): JobAttachment | null {
  const state = jobs.get(jobId);
  if (!state) return null;
  return {
    meta: state.meta,
    history: [...state.buffer],
    done: state.done,
    subscribe(handler) {
      if (state.done) {
        // Job already finished — nothing live left to deliver.
        return () => {};
      }
      state.subscribers.add(handler);
      return () => state.subscribers.delete(handler);
    },
  };
}

/** The current in-flight job, or null when nothing is running. */
export function currentJob(): JobMeta | null {
  if (!currentJobId) return null;
  const state = jobs.get(currentJobId);
  return state ? state.meta : null;
}

/** Mark a job done explicitly (e.g. error path). Idempotent. */
export function markDone(jobId: string, result: ScanResult | Record<string, unknown>): void {
  const state = jobs.get(jobId);
  if (!state || state.done) return;
  pushEvent(state, { type: 'done', result });
}

export function markError(jobId: string, message: string): void {
  const state = jobs.get(jobId);
  if (!state || state.done) return;
  pushEvent(state, { type: 'error', message });
}

/** Test-only: clear all jobs. */
export function _resetJobsForTests(): void {
  for (const s of jobs.values()) {
    if (s.reapTimer) clearTimeout(s.reapTimer);
  }
  jobs.clear();
  currentJobId = null;
}
