/**
 * 0.2.1 — slim progress line for the background skip intro/credits job.
 *
 * Polls `/api/themes/status` (every 3 s while the job runs, every 30 s
 * otherwise, so a job kicked off by a scan shows up on its own). Renders
 * nothing when idle.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface ThemesStatus {
  running: boolean;
  phase: 'fingerprint' | 'match' | null;
  done: number;
  total: number;
  current: string | null;
  showsDone: number;
}

const FAST_MS = 3_000;
const SLOW_MS = 30_000;

@customElement('themes-status')
export class ThemesStatusLine extends LitElement {
  static override styles = css`
    :host { display: block; }
    .line {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--text-secondary);
      padding: 4px 2px 0;
      min-width: 0;
    }
    .label { white-space: nowrap; }
    .current {
      color: var(--text-tertiary, var(--text-secondary));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .bar {
      flex: 0 0 120px;
      height: 3px;
      border-radius: 2px;
      background: var(--border-strong);
      overflow: hidden;
    }
    .bar > div { height: 100%; background: var(--accent); transition: width 400ms ease-out; }
  `;

  @state() private status: ThemesStatus | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.stopped = false;
    void this.poll();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const r = await fetch('/api/themes/status');
      this.status = r.ok ? ((await r.json()) as ThemesStatus) : null;
    } catch {
      this.status = null;
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.status?.running ? FAST_MS : SLOW_MS);
  }

  override render(): unknown {
    const s = this.status;
    if (!s?.running) return null;
    const pct = s.total > 0 ? Math.min(100, (s.done / s.total) * 100) : 0;
    const label =
      s.phase === 'match' && s.done >= s.total
        ? 'Finding intros & credits…'
        : `Finding intros & credits · ${s.done}/${s.total} episodes`;
    return html`
      <div class="line" title="Skip Intro / Skip Credits buttons appear for each show as soon as it's done">
        <span class="label">${label}</span>
        ${s.total > 0 ? html`<div class="bar"><div style=${`width:${pct}%`}></div></div>` : null}
        ${s.current ? html`<span class="current">${s.current}</span>` : null}
      </div>
    `;
  }
}
