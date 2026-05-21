/**
 * 0.1.11 — single source of truth for the browser's view of server reachability.
 *
 * Two failure modes need distinguishing:
 *  - `reachable + share-offline`: the server answered the poll with
 *    `{ online: false }`. The SMB-style "share missing" branch from 0.1.7;
 *    the existing <share-banner> strip handles it.
 *  - `unreachable`: the poll threw before any HTTP response was decoded.
 *    Network error, TCP refused, DNS failure, timeout. The new
 *    <reconnect-overlay> handles this.
 *
 * `unreachable` carries a `phase`:
 *  - `active`: the share-banner's poll loop is firing on schedule (3s for the
 *    first 30s, 10s for the next 120s).
 *  - `idle`: we've stopped polling — the elapsed unreachable streak exceeded
 *    150s. User activity (mouse / key / focus / "Retry now") wakes the loop
 *    back to `active` with `since = Date.now()`.
 *
 * The `<share-banner>` is the sole *producer* — its poll loop calls
 * setConnectionState() in both success and failure branches. Consumers
 * (<share-banner>'s own render, <reconnect-overlay>, view-level load guards)
 * subscribe.
 *
 * Recovery dispatch: on every `unreachable → reachable` transition, the setter
 * fires a document-level `LIBRARY_INVALIDATED_EVENT` so views that already
 * listen (home, series-detail, search per 0.1.5.2) refetch the data they
 * couldn't load while we were offline.
 */
import type { ShareStatus } from './types.js';

export type ConnectionState =
  | { kind: 'reachable'; status: ShareStatus }
  | { kind: 'unreachable'; phase: 'active' | 'idle'; since: number };

/** Mirror of the 0.1.5.2 constant from <app-shell>. Declaring it here avoids a
 *  circular import (<app-shell> imports things that eventually re-import this
 *  module). The string must stay in lockstep with app-shell.ts. */
const LIBRARY_INVALIDATED_EVENT = 'library-invalidated';

let currentState: ConnectionState | null = null;
const subscribers = new Set<(state: ConnectionState) => void>();

export function getConnectionState(): ConnectionState | null {
  return currentState;
}

export function setConnectionState(next: ConnectionState): void {
  const prev = currentState;
  currentState = next;
  // Recovery: unreachable (any phase) → reachable triggers a library refetch
  // across views that listen for the existing manual-identify invalidation
  // event. Saves us inventing a parallel `connection-recovered` event for the
  // same semantic.
  if (prev?.kind === 'unreachable' && next.kind === 'reachable') {
    document.dispatchEvent(new CustomEvent(LIBRARY_INVALIDATED_EVENT));
  }
  for (const fn of subscribers) {
    try {
      fn(next);
    } catch {
      // A throwing subscriber must not break delivery to the rest.
    }
  }
}

export function subscribeConnectionState(
  fn: (state: ConnectionState) => void,
): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Backwards-compat shim for the 0.1.7 export consumed by <home-view>.
 *  Returns the last ShareStatus we observed when reachable, or null. */
export function getLastKnownShareStatus(): ShareStatus | null {
  return currentState?.kind === 'reachable' ? currentState.status : null;
}

/** Reset internal state. Test-only escape hatch. */
export function __resetConnectionStoreForTests(): void {
  currentState = null;
  subscribers.clear();
}
