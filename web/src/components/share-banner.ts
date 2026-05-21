import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiShareStatus, apiReconnect } from '../api.js';
import type { ShareStatus } from '../types.js';
import {
  getConnectionState,
  setConnectionState,
  subscribeConnectionState,
  type ConnectionState,
} from '../connection-store.js';

export const SHARE_STATUS_EVENT = 'share-status-changed';

/** 0.1.11 — fired by <reconnect-overlay> "Retry now" button. Banner is the
 *  sole producer of polling, so the request comes in as an event rather than
 *  a direct method call. */
export const CONNECTION_RETRY_EVENT = 'connection-retry-requested';

/** 0.1.7 D1 — adaptive polling cadence for the reachable case.
 *  - Online + stable share: 30s.
 *  - Share offline (server up, mount stale): 5s. */
const POLL_INTERVAL_ONLINE_MS = 30_000;
const POLL_INTERVAL_OFFLINE_MS = 5_000;

/** 0.1.11 — unreachable cadence.
 *  - First 30s of failure: 3s polling (server is usually almost-up).
 *  - Next 120s: 10s polling (slow boot).
 *  - After 150s total: flip to `idle`, stop polling, wait for user activity. */
const UNREACHABLE_FAST_MS = 3_000;
const UNREACHABLE_SLOW_MS = 10_000;
const UNREACHABLE_FAST_WINDOW_MS = 30_000;
const UNREACHABLE_IDLE_THRESHOLD_MS = 150_000;

/** Debounce window for `mousemove` activity wakes — many events fire on any
 *  cursor motion, we only need the first. Keyboard / pointerdown / focus /
 *  visibility are naturally rate-limited so they bypass the debounce. */
const MOUSEMOVE_WAKE_DEBOUNCE_MS = 1_000;

/** Re-export for the 0.1.7 callers that still consume the share-banner module
 *  directly. The implementation now lives in connection-store. */
export { getLastKnownShareStatus } from '../connection-store.js';

@customElement('share-banner')
export class ShareBanner extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .bar {
      background: var(--surface);
      color: var(--error);
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--error);
    }
    .msg { flex: 1; }
    button.reconnect {
      background: var(--surface-pressed);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
    }
    button.reconnect:hover:not(:disabled) { border-color: var(--accent); }
    button.reconnect:disabled { opacity: 0.6; cursor: wait; }
  `;

  /** Local mirror of the reachable+share-status case; null in any other state
   *  so render() collapses to empty. The connection store is the source of
   *  truth; this is just a render shortcut. */
  @state() private renderedStatus: ShareStatus | null = null;
  @state() private reconnecting = false;
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastMouseWake = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onNetOnline);
    window.addEventListener('offline', this.onNetOffline);
    window.addEventListener('focus', this.onFocus);

    // 0.1.11 — wake-from-idle activity listeners. Always installed; the
    // handlers early-return unless state is `unreachable + idle`.
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onActivity);
    document.addEventListener('pointerdown', this.onActivity);
    document.addEventListener(CONNECTION_RETRY_EVENT, this.onRetryRequested);

    this.unsubscribe = subscribeConnectionState(this.onConnectionState);
    this.onConnectionState(getConnectionState() ?? { kind: 'unreachable', phase: 'active', since: Date.now() });

    void this.poll(); // first poll immediate
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onNetOnline);
    window.removeEventListener('offline', this.onNetOffline);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('keydown', this.onActivity);
    document.removeEventListener('pointerdown', this.onActivity);
    document.removeEventListener(CONNECTION_RETRY_EVENT, this.onRetryRequested);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Schedule the next poll based on the current connection state.
   *  - reachable+online: 30s. reachable+offline: 5s.
   *  - unreachable+active: 3s for first 30s, then 10s until 150s, then flip to idle.
   *  - unreachable+idle: no timer; wake on activity instead. */
  private scheduleNext(): void {
    this.clearTimer();
    if (document.hidden) return;
    const state = getConnectionState();
    let ms: number;
    if (state?.kind === 'unreachable') {
      if (state.phase === 'idle') return;
      const elapsed = Date.now() - state.since;
      if (elapsed >= UNREACHABLE_IDLE_THRESHOLD_MS) {
        // Flip to idle. The setter notifies subscribers (including ourselves —
        // but the next scheduleNext from onConnectionState will see `idle` and
        // bail). We do not arm a timer.
        setConnectionState({ kind: 'unreachable', phase: 'idle', since: state.since });
        return;
      }
      ms = elapsed < UNREACHABLE_FAST_WINDOW_MS ? UNREACHABLE_FAST_MS : UNREACHABLE_SLOW_MS;
    } else if (state?.kind === 'reachable' && state.status.online) {
      ms = POLL_INTERVAL_ONLINE_MS;
    } else {
      // reachable + share offline, OR no state yet (treat as fast offline poll
      // until we get an answer).
      ms = POLL_INTERVAL_OFFLINE_MS;
    }
    this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    try {
      const next = await apiShareStatus();
      setConnectionState({ kind: 'reachable', status: next });
    } catch {
      // Any failure to receive a `{ online }` payload → unreachable. We do
      // not subdivide error classes (per spec D2): the user-visible response
      // is the same for fetch network errors, AbortError, 5xx without body,
      // etc.
      const prev = getConnectionState();
      const since = prev?.kind === 'unreachable' ? prev.since : Date.now();
      setConnectionState({ kind: 'unreachable', phase: 'active', since });
    } finally {
      this.scheduleNext();
    }
  }

  private onConnectionState = (state: ConnectionState): void => {
    // Update the local render mirror — banner renders only for
    // reachable+share-offline. In every other state we render empty (overlay
    // takes over the unreachable case; reachable+online is the steady state).
    if (state.kind === 'reachable') {
      this.renderedStatus = state.status;
      // 0.1.7 compat: fire the SHARE_STATUS_EVENT so views that listen for it
      // continue to update their `.online` flag.
      document.dispatchEvent(
        new CustomEvent<ShareStatus>(SHARE_STATUS_EVENT, { detail: state.status }),
      );
    } else {
      this.renderedStatus = null;
    }
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      void this.poll(); // refresh now
    } else {
      this.clearTimer();
    }
  };

  private onNetOnline = (): void => { void this.poll(); };
  private onNetOffline = (): void => { void this.poll(); };
  private onFocus = (): void => { void this.poll(); };

  /** 0.1.11 — mouse-move wakes are debounced so a single cursor motion fires
   *  one poll, not sixty. Keyboard / pointerdown / focus do not need this
   *  treatment because they're naturally rate-limited. */
  private onMouseMove = (): void => {
    const now = Date.now();
    if (now - this.lastMouseWake < MOUSEMOVE_WAKE_DEBOUNCE_MS) return;
    this.lastMouseWake = now;
    this.onActivity();
  };

  private onActivity = (): void => {
    const state = getConnectionState();
    if (state?.kind !== 'unreachable' || state.phase !== 'idle') return;
    // Wake: reset since, flip to active, fire one immediate poll. Note that
    // setConnectionState fires the recovery dispatch only on
    // unreachable → reachable; flipping idle → active is unreachable →
    // unreachable so no event leaks out.
    setConnectionState({ kind: 'unreachable', phase: 'active', since: Date.now() });
    void this.poll();
  };

  /** 0.1.11 — overlay's "Retry now" button. Wakes from idle (matching
   *  onActivity behaviour) AND fires an immediate poll regardless of phase. */
  private onRetryRequested = (): void => {
    const state = getConnectionState();
    if (state?.kind === 'unreachable' && state.phase === 'idle') {
      setConnectionState({ kind: 'unreachable', phase: 'active', since: Date.now() });
    }
    void this.poll();
  };

  private async onReconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      const next = await apiReconnect();
      setConnectionState({ kind: 'reachable', status: next });
    } catch {
      // Leave the banner up; the next poll will refresh.
    } finally {
      this.reconnecting = false;
      this.scheduleNext();
    }
  }

  override render(): unknown {
    // Banner only renders when share is offline AND server is reachable. The
    // unreachable case is owned by <reconnect-overlay>.
    if (!this.renderedStatus || this.renderedStatus.online) return html``;
    return html`
      <div class="bar" role="alert">
        <span class="msg">Desktop unreachable — media is currently offline.</span>
        <button
          class="reconnect"
          @click=${(): void => void this.onReconnect()}
          ?disabled=${this.reconnecting}
        >
          ${this.reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
      </div>
    `;
  }
}
