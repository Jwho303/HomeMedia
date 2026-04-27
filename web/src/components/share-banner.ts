import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiShareStatus, apiReconnect } from '../api.js';
import type { ShareStatus } from '../types.js';

export const SHARE_STATUS_EVENT = 'share-status-changed';

/** 0.1.7 D1 — adaptive polling cadence.
 *  - Online + stable share: 30s. The home screen on a healthy LAN sits here.
 *  - Offline: 5s. Tighter so the banner clears quickly when the share is back.
 *  Hard-coded; not exposed as settings (D1 — there's nothing to tune). */
const POLL_INTERVAL_ONLINE_MS = 30_000;
const POLL_INTERVAL_OFFLINE_MS = 5_000;

let lastKnown: ShareStatus | null = null;
export function getLastKnownShareStatus(): ShareStatus | null {
  return lastKnown;
}

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

  @state() private status: ShareStatus | null = null;
  @state() private reconnecting = false;
  private timer: number | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onNetOnline);
    window.addEventListener('offline', this.onNetOffline);
    window.addEventListener('focus', this.onFocus);
    void this.poll(); // first poll immediate
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onNetOnline);
    window.removeEventListener('offline', this.onNetOffline);
    window.removeEventListener('focus', this.onFocus);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Schedule the next poll based on the current status. Bails when the tab
   *  is hidden — `visibilitychange→visible` re-arms it. */
  private scheduleNext(): void {
    this.clearTimer();
    if (document.hidden) return;
    const ms = this.status?.online ? POLL_INTERVAL_ONLINE_MS : POLL_INTERVAL_OFFLINE_MS;
    this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    try {
      const next = await apiShareStatus();
      this.applyStatus(next);
    } catch {
      this.applyStatus({ online: false, mountPath: '?', lastSeen: null });
    } finally {
      this.scheduleNext();
    }
  }

  private applyStatus(next: ShareStatus): void {
    const prev = this.status;
    this.status = next;
    if (!prev || prev.online !== next.online) {
      lastKnown = next;
      document.dispatchEvent(
        new CustomEvent<ShareStatus>(SHARE_STATUS_EVENT, { detail: next }),
      );
    } else {
      lastKnown = next;
    }
  }

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

  private async onReconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      const next = await apiReconnect();
      this.applyStatus(next);
    } catch {
      // Leave the banner up; the next poll will refresh.
    } finally {
      this.reconnecting = false;
      this.scheduleNext();
    }
  }

  override render(): unknown {
    if (!this.status || this.status.online) return html``;
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
