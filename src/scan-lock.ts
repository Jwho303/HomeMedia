/**
 * Single shared lock for "long-running library work": scanner refresh, prober
 * re-probe, anything else that walks the library serially. Only one such job
 * may run at a time. Concurrent attempts are reported via `tryAcquire()` so
 * the route can return 409.
 *
 * Lives in its own module so both the refresh route and the re-probe route
 * import the same instance — sharing module state across importers is the
 * lock.
 */

import { currentJob } from './scan-progress.js';

let active = false;

export function isLocked(): boolean {
  return active;
}

/** Try to acquire the lock. Returns a release fn on success, or null when
 *  another job is already running. */
export function tryAcquire(): (() => void) | null {
  if (active) return null;
  active = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = false;
  };
}

/** Return the jobId currently registered with the progress channel, if any.
 *  Used by the SSE route so a client can attach without naming a jobId. */
export function currentJobId(): string | null {
  return currentJob()?.jobId ?? null;
}
