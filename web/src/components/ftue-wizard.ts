import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  apiSettingsTest,
  apiSettingsSave,
  apiRefresh,
  apiSetupState,
  type SettingsField,
  type SetupState,
} from '../api.js';
import type { ScanProgressEvent } from '../types.js';
import { iconCheck } from './icons.js';

/**
 * 0.1.13 — First-Time User Experience.
 *
 * A full-screen takeover shown when `GET /api/setup-state` reports the install
 * isn't ready (`!configured`, or `configured && !libraryBuilt`). It walks a
 * non-programmer from zero to a populated library without a terminal:
 *
 *   welcome → keys (TMDB required, OMDb/TVDB optional) → folder → build → hold
 *
 * It is NOT a router route — `<app-shell>` mounts it ahead of normal routing
 * and removes it only when setup completes (emitting `ftue-complete`). Each
 * step re-reads `setup-state` on mount so a refresh resumes at the right place,
 * and a mid-build reload reconnects to the running scan via `activeJobId`
 * rather than starting a second one.
 *
 * Backend reuse: keys/folder persist via `POST /api/settings` (0.1.12), each
 * field verifies via `POST /api/settings/test`, the build runs the existing
 * `POST /api/refresh` + `GET /api/refresh-progress` SSE — no new machinery.
 */

/** Dispatched on `document` when onboarding finishes, so `<app-shell>` reveals
 *  the normal app and refetches the library. */
export const FTUE_COMPLETE_EVENT = 'ftue-complete';

type Step = 'welcome' | 'keys' | 'folder' | 'build' | 'hold';

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'fail'; error: string };

interface OptionalKeyDef {
  field: SettingsField;
  label: string;
  signupUrl: string;
}

const OPTIONAL_KEYS: OptionalKeyDef[] = [
  { field: 'OMDB_API_KEY', label: 'OMDb API key', signupUrl: 'https://www.omdbapi.com/apikey.aspx' },
  { field: 'TVDB_API_KEY', label: 'TVDB API key', signupUrl: 'https://thetvdb.com/dashboard/account/apikey' },
];

const TMDB_SIGNUP = 'https://www.themoviedb.org/settings/api';

/** Base name of a path for display (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

@customElement('ftue-wizard')
export class FtueWizard extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: block;
      background: var(--bg);
      color: var(--text-primary);
      overflow-y: auto;
    }
    .panel {
      max-width: 560px;
      margin: 0 auto;
      padding: 56px 20px 80px;
    }
    .steps {
      display: flex;
      gap: 6px;
      margin-bottom: 32px;
    }
    .dot {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--border-strong);
    }
    .dot.done { background: var(--accent); }
    .dot.current { background: var(--accent); opacity: 0.6; }

    h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 12px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    p.lead {
      color: var(--text-secondary);
      line-height: 1.6;
      font-size: 14px;
      margin: 0 0 24px;
    }

    .field { margin-bottom: 20px; }
    .field-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }
    .field-label { font-size: 14px; font-weight: 600; }
    .req { color: var(--text-secondary); font-weight: 400; font-size: 12px; margin-left: 6px; }
    .signup {
      font-size: 12px;
      color: var(--accent);
      text-decoration: none;
      white-space: nowrap;
    }
    .signup:hover { text-decoration: underline; }

    .input-row { display: flex; align-items: center; gap: 8px; }
    input {
      flex: 1;
      min-width: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font: inherit;
      font-size: 13px;
      padding: 9px 11px;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    button.action {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: 13px;
      padding: 9px 14px;
      cursor: pointer;
      flex-shrink: 0;
    }
    button.action:hover:not(:disabled) { border-color: var(--accent); }
    button.action:disabled { opacity: 0.5; cursor: default; }

    .status { font-size: 12px; margin-top: 6px; min-height: 16px; }
    .status.ok { color: var(--success, #3fb950); }
    .status.fail { color: var(--danger, #f85149); }
    .status.testing { color: var(--text-secondary); }

    .optional-toggle {
      background: none;
      border: none;
      color: var(--accent);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      padding: 4px 0;
      margin-bottom: 12px;
    }
    .optional-box {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 16px 16px 0;
      margin-bottom: 8px;
    }
    .optional-hint { color: var(--text-secondary); font-size: 12px; margin: 0 0 16px; }

    .nav {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 32px;
    }
    button.primary {
      background: var(--accent);
      border: 1px solid var(--accent);
      color: var(--accent-contrast, #fff);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      padding: 11px 22px;
      cursor: pointer;
    }
    button.primary:disabled { opacity: 0.5; cursor: default; }
    button.ghost {
      background: none;
      border: none;
      color: var(--text-secondary);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      padding: 11px 8px;
    }
    button.ghost:hover { color: var(--text-primary); }

    /* Hold screen */
    .hold-status {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 16px;
      margin-bottom: 8px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hold-detail {
      color: var(--text-secondary);
      font-size: 13px;
      font-family: var(--mono, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 24px;
    }
    .bar {
      height: 6px;
      background: var(--surface-elevated);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 0.2s ease;
    }
    .bar.indeterminate > span {
      width: 30% !important;
      animation: slide 1.4s ease-in-out infinite;
    }
    @keyframes slide {
      0% { margin-left: -30%; }
      100% { margin-left: 100%; }
    }
    details.problems {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      margin-bottom: 24px;
    }
    details.problems summary {
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
    }
    details.problems ul {
      margin: 10px 0 4px;
      padding-left: 18px;
      max-height: 200px;
      overflow-y: auto;
    }
    details.problems li {
      font-size: 12px;
      font-family: var(--mono, monospace);
      color: var(--text-secondary);
      margin-bottom: 4px;
      word-break: break-all;
    }
    .build-error {
      background: color-mix(in srgb, var(--danger, #f85149) 12%, transparent);
      border: 1px solid var(--danger, #f85149);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      margin-bottom: 24px;
    }
    .build-error .msg { font-size: 13px; color: var(--text-primary); margin: 0 0 4px; }
    .summary { font-size: 15px; margin-bottom: 24px; }
    .check { color: var(--success, #3fb950); display: inline-flex; vertical-align: middle; }
  `;

  /** Where the wizard is. Seeded from `setup-state` on mount. */
  @state() private step: Step = 'welcome';
  @state() private loading = true;

  /** Typed values for the key/folder steps. */
  @state() private values: Partial<Record<SettingsField, string>> = {};
  @state() private testStatus: Partial<Record<SettingsField, TestStatus>> = {};
  @state() private showOptional = false;
  @state() private saving = false;
  @state() private saveError: string | null = null;

  /** The configured media folder, once known (for the build screen copy). */
  @state() private mediaFolder = '';

  /** Hold-screen state. */
  @state() private holdLabel = 'Starting…';
  @state() private holdDetail = '';
  @state() private holdIndeterminate = true;
  @state() private progressPct = 0;
  @state() private problems: string[] = [];
  @state() private buildError: string | null = null;
  @state() private buildSummary: { added: number; needsReview: number } | null = null;

  private eventSource: EventSource | null = null;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this.resume();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.closeEventSource();
  }

  /** Re-read setup-state and jump to the first unsatisfied step. A mid-build
   *  reload (activeJobId set) reconnects to the running scan. */
  private async resume(): Promise<void> {
    this.loading = true;
    let s: SetupState;
    try {
      s = await apiSetupState();
    } catch {
      // If even setup-state fails, start at welcome — the keys step will surface
      // any real error when the user tries to save/test.
      this.loading = false;
      this.step = 'welcome';
      return;
    }
    this.mediaFolder = s.mediaFolders[0] ?? '';
    this.loading = false;

    if (s.activeJobId) {
      // A scan is already running (e.g. the user reloaded mid-build). Attach.
      this.step = 'hold';
      this.openEventSource();
      return;
    }
    if (!s.configured) {
      // Enter at welcome; the user steps through keys + folder.
      this.step = 'welcome';
      return;
    }
    if (!s.libraryBuilt) {
      // Set up but never scanned — offer the explicit Build step.
      this.step = 'build';
      return;
    }
    // configured && libraryBuilt → nothing to do (shell shouldn't have mounted us).
    this.complete();
  }

  private typed(field: SettingsField): string {
    return (this.values[field] ?? '').trim();
  }

  private onInput(field: SettingsField, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.values = { ...this.values, [field]: v };
    if (this.testStatus[field] && this.testStatus[field]!.kind !== 'idle') {
      this.testStatus = { ...this.testStatus, [field]: { kind: 'idle' } };
    }
    this.saveError = null;
  }

  private async onTest(field: SettingsField): Promise<void> {
    const value = this.typed(field);
    if (!value) {
      this.testStatus = {
        ...this.testStatus,
        [field]: { kind: 'fail', error: 'Enter a value to test' },
      };
      return;
    }
    this.testStatus = { ...this.testStatus, [field]: { kind: 'testing' } };
    try {
      const res = await apiSettingsTest(field, value);
      this.testStatus = {
        ...this.testStatus,
        [field]: res.ok ? { kind: 'ok' } : { kind: 'fail', error: res.error ?? 'Test failed' },
      };
    } catch (err) {
      this.testStatus = {
        ...this.testStatus,
        [field]: { kind: 'fail', error: (err as Error).message ?? 'Test failed' },
      };
    }
  }

  // --- Step: keys --------------------------------------------------------

  private get tmdbReady(): boolean {
    return this.testStatus.TMDB_API_KEY?.kind === 'ok';
  }

  // --- Step: folder ------------------------------------------------------

  /** Persist TMDB (+ optional keys) AND the folder in one save, then build.
   *  Keys aren't saved at the end of the keys step on purpose: the server
   *  rejects a save that leaves a required field (MEDIA_ROOT) empty, so we
   *  carry the typed keys forward and persist everything together here. */
  private async saveFolderAndAdvance(): Promise<void> {
    const payload: Partial<Record<SettingsField, string>> = {};
    const tmdb = this.typed('TMDB_API_KEY');
    if (tmdb) payload.TMDB_API_KEY = tmdb;
    for (const def of OPTIONAL_KEYS) {
      const v = this.typed(def.field);
      if (v) payload[def.field] = v;
    }
    payload.MEDIA_ROOT = this.typed('MEDIA_ROOT');

    this.saving = true;
    this.saveError = null;
    try {
      await apiSettingsSave(payload);
      this.mediaFolder = this.typed('MEDIA_ROOT');
      this.step = 'build';
    } catch (err) {
      this.saveError = (err as Error).message ?? 'Failed to save settings';
    } finally {
      this.saving = false;
    }
  }

  // --- Step: build / hold ------------------------------------------------

  private async startBuild(): Promise<void> {
    this.step = 'hold';
    this.resetHold();
    try {
      await apiRefresh(false);
      this.openEventSource();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // `POST /api/refresh` returns 409 scan_in_progress if a scan is already
      // running — attach to it instead of failing.
      if (msg.startsWith('409')) {
        this.openEventSource();
        return;
      }
      this.buildError = msg || 'Failed to start the scan';
      this.holdIndeterminate = false;
    }
  }

  private resetHold(): void {
    this.holdLabel = 'Initializing database…';
    this.holdDetail = '';
    this.holdIndeterminate = true;
    this.progressPct = 0;
    this.problems = [];
    this.buildError = null;
    this.buildSummary = null;
  }

  private openEventSource(): void {
    this.closeEventSource();
    if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return;
    const es = new window.EventSource('/api/refresh-progress');
    this.eventSource = es;
    es.addEventListener('message', (ev) => {
      let event: ScanProgressEvent;
      try {
        event = JSON.parse((ev as MessageEvent).data) as ScanProgressEvent;
      } catch {
        return;
      }
      this.applyEvent(event);
    });
    es.addEventListener('error', () => {
      // EventSource auto-reconnects on transient errors; only react to a hard
      // close (server ended the stream). A done/error event already set our
      // terminal UI, so a CLOSED here without one means a dropped connection.
      if (es.readyState === 2 /* CLOSED */) {
        this.closeEventSource();
      }
    });
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /** Translate a raw ProgressEvent into the human-legible hold-screen state. */
  private applyEvent(event: ScanProgressEvent): void {
    switch (event.type) {
      case 'walk':
        this.holdIndeterminate = true;
        this.holdLabel = 'Scanning files…';
        this.holdDetail = `${event.scanned} found`;
        break;
      case 'diff':
        this.holdIndeterminate = true;
        this.holdLabel = 'Comparing with library…';
        this.holdDetail = `${event.dirty} new/changed, ${event.disappeared} removed`;
        break;
      case 'cohort':
        // No visible beat.
        break;
      case 'file': {
        this.holdLabel = 'Identifying titles…';
        this.holdDetail = `${event.i}/${event.n}: ${basename(event.path)}`;
        this.setProgress(event.i, event.n);
        break;
      }
      case 'probe': {
        this.holdLabel = 'Analyzing media…';
        this.holdDetail = `${event.i}/${event.n}: ${basename(event.path)}`;
        this.setProgress(event.i, event.n);
        if (event.status === 'failed') {
          this.problems = [...this.problems, basename(event.path)];
        }
        break;
      }
      case 'done': {
        this.closeEventSource();
        this.holdIndeterminate = false;
        this.progressPct = 100;
        const r = event.result as { added?: number; needsReview?: number };
        this.buildSummary = {
          added: typeof r.added === 'number' ? r.added : 0,
          needsReview: typeof r.needsReview === 'number' ? r.needsReview : 0,
        };
        this.holdLabel = 'Done';
        this.holdDetail = '';
        break;
      }
      case 'error': {
        this.closeEventSource();
        this.holdIndeterminate = false;
        this.buildError = event.message || 'The scan failed';
        break;
      }
    }
  }

  private setProgress(i: number, n: number): void {
    if (n > 0) {
      this.holdIndeterminate = false;
      this.progressPct = Math.min(100, Math.round((i / n) * 100));
    }
  }

  private complete(): void {
    this.closeEventSource();
    document.dispatchEvent(new CustomEvent(FTUE_COMPLETE_EVENT));
  }

  // --- Render ------------------------------------------------------------

  private stepIndex(): number {
    return (['welcome', 'keys', 'folder', 'build', 'hold'] as Step[]).indexOf(
      this.step === 'hold' ? 'build' : this.step,
    );
  }

  private renderSteps(): unknown {
    // Four visible dots (welcome / keys / folder / build+hold).
    const idx = this.stepIndex();
    return html`<div class="steps">
      ${[0, 1, 2, 3].map(
        (i) => html`<div class="dot ${i < idx ? 'done' : i === idx ? 'current' : ''}"></div>`,
      )}
    </div>`;
  }

  private renderKeyField(
    field: SettingsField,
    label: string,
    signupUrl: string,
    required: boolean,
  ): unknown {
    const status = this.testStatus[field] ?? { kind: 'idle' as const };
    return html`
      <div class="field">
        <div class="field-head">
          <span class="field-label">
            ${label}<span class="req">${required ? '(required)' : '(optional)'}</span>
          </span>
          <a class="signup" href=${signupUrl} target="_blank" rel="noopener">Get a key ↗</a>
        </div>
        <div class="input-row">
          <input
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder=${required ? 'Paste your key' : 'Optional — paste a key'}
            .value=${this.values[field] ?? ''}
            @input=${(e: Event): void => this.onInput(field, e)}
          />
          <button
            class="action"
            ?disabled=${status.kind === 'testing'}
            @click=${(): void => { void this.onTest(field); }}
          >Test</button>
        </div>
        ${this.renderStatus(status)}
      </div>
    `;
  }

  private renderStatus(status: TestStatus): unknown {
    switch (status.kind) {
      case 'testing': return html`<div class="status testing">Testing…</div>`;
      case 'ok': return html`<div class="status ok">✓ Working</div>`;
      case 'fail': return html`<div class="status fail">✗ ${status.error}</div>`;
      default: return html`<div class="status"></div>`;
    }
  }

  private renderWelcome(): unknown {
    return html`
      <h1>Welcome</h1>
      <p class="lead">
        This app finds and organizes your movies &amp; shows so you can stream
        them anywhere on your network. To get started you'll need a free
        <strong>TMDB</strong> account (about 2 minutes) and the folder on this
        machine where your media lives.
      </p>
      <div class="nav">
        <button class="primary" @click=${(): void => { this.step = 'keys'; }}>Get started</button>
      </div>
    `;
  }

  private renderKeys(): unknown {
    return html`
      <h2>Connect TMDB</h2>
      <p class="lead">
        TMDB provides the posters, titles, and descriptions. Click
        <strong>Get a key</strong>, sign up, paste your API key below, then
        <strong>Test</strong> it. You can't continue until the key works.
      </p>
      ${this.renderKeyField('TMDB_API_KEY', 'TMDB API key', TMDB_SIGNUP, true)}

      <button class="optional-toggle" @click=${(): void => { this.showOptional = !this.showOptional; }}>
        ${this.showOptional ? '▾' : '▸'} Improve matching (optional)
      </button>
      ${this.showOptional
        ? html`<div class="optional-box">
            <p class="optional-hint">
              OMDb adds IMDb ratings; TVDB improves TV episode data. Both are
              optional — you can add them later in Settings.
            </p>
            ${OPTIONAL_KEYS.map((d) => this.renderKeyField(d.field, d.label, d.signupUrl, false))}
          </div>`
        : null}

      <div class="nav">
        <button
          class="primary"
          ?disabled=${!this.tmdbReady}
          @click=${(): void => { this.step = 'folder'; }}
        >Continue</button>
        <button class="ghost" @click=${(): void => { this.step = 'welcome'; }}>Back</button>
      </div>
    `;
  }

  private renderFolder(): unknown {
    const status = this.testStatus.MEDIA_ROOT ?? { kind: 'idle' as const };
    const validated = status.kind === 'ok';
    return html`
      <h2>Choose your media folder</h2>
      <p class="lead">
        Enter the full path to the folder that holds your movies and shows.
        Click <strong>Test</strong> to confirm the app can read it.
      </p>
      <div class="field">
        <div class="field-head">
          <span class="field-label">Media folder<span class="req">(required)</span></span>
        </div>
        <div class="input-row">
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="e.g. D:\\Media"
            .value=${this.values.MEDIA_ROOT ?? ''}
            @input=${(e: Event): void => this.onInput('MEDIA_ROOT', e)}
          />
          <button
            class="action"
            ?disabled=${status.kind === 'testing'}
            @click=${(): void => { void this.onTest('MEDIA_ROOT'); }}
          >Test</button>
        </div>
        ${this.renderStatus(status)}
      </div>
      ${this.saveError ? html`<div class="status fail">✗ ${this.saveError}</div>` : null}
      <div class="nav">
        <button
          class="primary"
          ?disabled=${!validated || this.saving}
          @click=${(): void => { void this.saveFolderAndAdvance(); }}
        >${this.saving ? 'Saving…' : 'Continue'}</button>
        <button class="ghost" @click=${(): void => { this.step = 'keys'; }}>Back</button>
      </div>
    `;
  }

  private renderBuild(): unknown {
    const folder = this.mediaFolder || 'your media folder';
    return html`
      <h2>Build your library</h2>
      <p class="lead">
        Ready to scan <strong>${folder}</strong>. This can take a while for a
        large collection — you can leave this screen open while it works.
      </p>
      <div class="nav">
        <button class="primary" @click=${(): void => { void this.startBuild(); }}>Build library</button>
      </div>
    `;
  }

  private renderHold(): unknown {
    if (this.buildError) {
      return html`
        <h2>Something went wrong</h2>
        <div class="build-error">
          <p class="msg">${this.buildError}</p>
        </div>
        <div class="nav">
          <button class="primary" @click=${(): void => { void this.startBuild(); }}>Try again</button>
        </div>
      `;
    }
    if (this.buildSummary) {
      const { added, needsReview } = this.buildSummary;
      return html`
        <h2><span class="check">${iconCheck()}</span> Library ready</h2>
        <p class="summary">
          ${added} item${added === 1 ? '' : 's'} added${needsReview > 0
            ? html`, <strong>${needsReview}</strong> need review`
            : ''}.
        </p>
        ${needsReview > 0
          ? html`<p class="lead">
              Items that need review couldn't be auto-matched. You can identify
              them by hand from the home screen anytime.
            </p>`
          : null}
        <div class="nav">
          <button class="primary" @click=${(): void => this.complete()}>Finish</button>
        </div>
      `;
    }
    return html`
      <h2>Building your library</h2>
      <div class="hold-status">
        <span class="spinner"></span>
        <span>${this.holdLabel}</span>
      </div>
      <div class="hold-detail">${this.holdDetail || ' '}</div>
      <div class="bar ${this.holdIndeterminate ? 'indeterminate' : ''}">
        <span style="width:${this.progressPct}%"></span>
      </div>
      ${this.problems.length > 0
        ? html`<details class="problems">
            <summary>Couldn't auto-match (${this.problems.length})</summary>
            <ul>
              ${this.problems.map((p) => html`<li>${p}</li>`)}
            </ul>
          </details>`
        : null}
      <p class="lead">This can take a while — it's safe to leave this open.</p>
    `;
  }

  override render(): unknown {
    if (this.loading) {
      return html`<div class="panel"><p class="lead">Loading…</p></div>`;
    }
    let body: unknown;
    switch (this.step) {
      case 'welcome': body = this.renderWelcome(); break;
      case 'keys': body = this.renderKeys(); break;
      case 'folder': body = this.renderFolder(); break;
      case 'build': body = this.renderBuild(); break;
      case 'hold': body = this.renderHold(); break;
    }
    return html`<div class="panel">${this.renderSteps()}${body}</div>`;
  }
}
