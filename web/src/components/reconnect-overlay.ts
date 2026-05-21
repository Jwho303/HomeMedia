import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  getConnectionState,
  subscribeConnectionState,
  type ConnectionState,
} from '../connection-store.js';
import { CONNECTION_RETRY_EVENT } from './share-banner.js';

/**
 * 0.1.11 — full-viewport overlay rendered when the server is unreachable.
 *
 * Mounted once by <app-shell> as a sibling of <main>. Subscribes to the
 * connection store and renders nothing when reachable. While unreachable, a
 * blurred scrim covers the existing UI and a centered card surfaces the
 * "Reconnecting…" state. The underlying route stays mounted — no history
 * push, no view teardown — so the app snaps back to interactive when the
 * server returns.
 *
 * The card differs by phase:
 *  - `active`: title "Reconnecting to server", pulsing dots, elapsed counter
 *    advancing once a second.
 *  - `idle`: title "Server still unreachable", paused dots, frozen elapsed
 *    counter, copy nudging the user that mouse/keyboard activity will retry.
 *
 * The "Retry now" button dispatches `connection-retry-requested` on the
 * document. <share-banner> listens for it and triggers an immediate poll.
 */
@customElement('reconnect-overlay')
export class ReconnectOverlay extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 1000;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      background: rgba(0, 0, 0, 0.45);
      display: grid;
      place-items: center;
      animation: fade-in 200ms ease-out both;
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .card {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-popover);
      padding: 24px 28px;
      min-width: 280px;
      max-width: 360px;
      text-align: center;
      color: var(--text-primary);
      font: inherit;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      font-weight: 600;
    }
    .dots {
      font-size: 24px;
      letter-spacing: 6px;
      color: var(--accent);
      margin: 12px 0 16px;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dots.paused {
      animation: none;
      opacity: 0.4;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }
    .elapsed {
      color: var(--text-secondary);
      font-size: 13px;
      margin-bottom: 18px;
    }
    button.retry {
      background: var(--surface-pressed);
      color: var(--text-primary);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      padding: 6px 14px;
      cursor: pointer;
      font: inherit;
    }
    button.retry:hover { border-color: var(--accent); }
    button.retry:focus-visible {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
  `;

  @state() private connState: ConnectionState | null = null;
  @state() private now: number = Date.now();
  private unsubscribe: (() => void) | null = null;
  private tickTimer: number | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.connState = getConnectionState();
    this.unsubscribe = subscribeConnectionState((s) => {
      this.connState = s;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTickTimer();
  }

  override updated(): void {
    // 1Hz tick only while actively polling — that's the only state where the
    // displayed elapsed time advances. In `idle` the counter is frozen, and
    // when reachable the overlay isn't rendered at all.
    if (this.connState?.kind === 'unreachable' && this.connState.phase === 'active') {
      this.startTickTimer();
      this.focusRetryButton();
    } else {
      this.clearTickTimer();
      if (this.connState?.kind === 'unreachable') this.focusRetryButton();
    }
  }

  private startTickTimer(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = window.setInterval(() => {
      this.now = Date.now();
    }, 1_000);
  }

  private clearTickTimer(): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Move focus to the Retry button on first appearance so keyboard users
   *  can recover without hunting. Only fires once per overlay mount —
   *  refocusing on every tick would steal focus from the entire page. */
  private focusedOnce = false;
  private focusRetryButton(): void {
    if (this.focusedOnce) return;
    const btn = this.renderRoot.querySelector<HTMLButtonElement>('button.retry');
    if (btn) {
      btn.focus();
      this.focusedOnce = true;
    }
  }

  private retry(): void {
    document.dispatchEvent(new CustomEvent(CONNECTION_RETRY_EVENT));
  }

  override render(): unknown {
    const s = this.connState;
    if (s?.kind !== 'unreachable') {
      this.focusedOnce = false;
      return html``;
    }
    const elapsedSec = Math.max(0, Math.floor((this.now - s.since) / 1000));
    const isIdle = s.phase === 'idle';
    const intervalSec = elapsedSec < 30 ? 3 : 10;
    return html`
      <div class="scrim" role="alertdialog" aria-modal="true" aria-labelledby="rc-title" aria-live="polite">
        <div class="card">
          <h2 id="rc-title">${isIdle ? 'Server still unreachable' : 'Reconnecting to server'}</h2>
          <div class="dots ${isIdle ? 'paused' : ''}" aria-hidden="true">●●●</div>
          <div class="elapsed">
            ${isIdle
              ? `Stopped trying after ${elapsedSec}s · move your mouse or click to retry`
              : `Trying every ${intervalSec}s · ${elapsedSec}s`}
          </div>
          <button class="retry" @click=${(): void => this.retry()}>Retry now</button>
        </div>
      </div>
    `;
  }
}
