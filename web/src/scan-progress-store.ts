/**
 * 0.1.5.1 — App-level scan progress store.
 *
 * `<app-shell>` owns the EventSource and pushes events through here; views
 * (`<home-header>` for the inline progress display, `<home-view>` for the
 * post-scan reload) subscribe to the slices they care about.
 *
 * Why a module-scoped store: per D8, refresh / per-item refresh / per-item
 * re-probe can be triggered from views below `<app-shell>`. Having the
 * EventSource owned at the app level means navigation away from
 * `<series-detail>` mid-job doesn't drop the connection.
 */

import type { ScanProgressEvent } from './types.js';

export type ScanPhase = 'identify' | 'probe' | null;

export interface ScanProgressState {
  /** True iff a job is currently in flight (not yet `done`/`error`). */
  active: boolean;
  /** Job ID returned by the POST that started this job. */
  jobId: string | null;
  /** Files processed (1-based) and total denominator for this job. */
  i: number;
  n: number;
  /** Most recent file processed — the path to display in the header. */
  currentFile: string | null;
  /** Identify or probe phase the most recent event was for. */
  phase: ScanPhase;
  /** Last error message, if the job failed. */
  errorMessage: string | null;
  /** Final result on `done`; null until then. */
  result: Record<string, unknown> | null;
}

const INITIAL: ScanProgressState = {
  active: false,
  jobId: null,
  i: 0,
  n: 0,
  currentFile: null,
  phase: null,
  errorMessage: null,
  result: null,
};

let state: ScanProgressState = { ...INITIAL };
const listeners = new Set<(state: ScanProgressState) => void>();

export function getScanProgress(): ScanProgressState {
  return state;
}

export function subscribeScanProgress(
  listener: (state: ScanProgressState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l(state);
}

/** Called by `<app-shell>` when a new POST kickoff returns its jobId. */
export function startJob(jobId: string): void {
  state = {
    ...INITIAL,
    active: true,
    jobId,
  };
  notify();
}

/** Apply one SSE event to the store. */
export function applyScanEvent(event: ScanProgressEvent): void {
  switch (event.type) {
    case 'walk':
      // Total file count established later by 'diff'; nothing to display yet.
      break;
    case 'diff':
      // Buffer total for early UI; per-file ticks will overwrite.
      state = { ...state, n: Math.max(state.n, event.total) };
      break;
    case 'file':
      state = {
        ...state,
        i: event.i,
        n: event.n,
        currentFile: event.path,
        phase: 'identify',
      };
      break;
    case 'probe':
      state = {
        ...state,
        i: event.i,
        n: event.n,
        currentFile: event.path,
        phase: 'probe',
      };
      break;
    case 'cohort':
      // No visible effect; future debug UI.
      break;
    case 'done':
      state = {
        ...state,
        active: false,
        result: event.result,
        currentFile: null,
        phase: null,
      };
      break;
    case 'error':
      state = {
        ...state,
        active: false,
        errorMessage: event.message,
        currentFile: null,
        phase: null,
      };
      break;
  }
  notify();
}

/** Reset back to idle. Called when `<app-shell>` closes the EventSource
 *  (job done) so the next job starts from a clean slate. */
export function clearScanProgress(): void {
  state = { ...INITIAL };
  notify();
}

/** Test-only escape hatch. */
export function _resetForTests(): void {
  state = { ...INITIAL };
  listeners.clear();
}
