import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { goBack, homeHref } from '../router.js';
import {
  apiSettingsGet,
  apiSettingsTest,
  apiSettingsSave,
  apiSettingsAccess,
  apiSettingsPort,
  apiSettingsRestart,
  apiSettingsWipeDb,
  apiLibraryHidden,
  apiLibraryRestore,
  type SettingsField,
  type SettingsState,
  type SettingsFieldState,
  type SettingsAccess,
  type HiddenItem,
} from '../api.js';
import { iconBackChevron } from './icons.js';
import { forceBasicPlayer } from '../nav/basic-player.js';

/** The File System Access directory picker requires a secure context
 *  (https or http://localhost), and only Chromium exposes it. On a LAN IP
 *  (e.g. http://192.168.x.x) it's absent, so the picker is hidden there. */
function folderPickerAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === 'function'
  );
}

/**
 * 0.1.12 — `#/settings` view. Lets a non-programmer supply their own API keys
 * and media path: Get-a-key link → paste → Test → Save. Changes take effect
 * live (the server reloads its config), no restart.
 *
 * Saved state is always visible: each field shows a badge ("✓ Saved" /
 * "Required — not set" / "Optional — not set") derived from the server's
 * GET /api/settings, so a reload reflects exactly what's stored. Secrets are
 * never returned raw — a saved key shows a masked hint and the input stays
 * blank until the user types a replacement. Testing an untouched secret
 * verifies the *saved* key server-side; testing after typing verifies the
 * typed candidate before it's saved.
 *
 * The media folder offers a native "Choose folder…" picker, but only when the
 * page is a secure context with the File System Access API (i.e. opened on the
 * server machine at http://localhost in Chromium). Over a LAN IP the API is
 * absent, so the picker is hidden and the user types the server-side path.
 *
 * The Access & server section shows the URLs remote devices can use, lets the
 * user change the listen port (saved to settings.json; effective on restart),
 * and offers a Restart button that exits the process for a supervisor to
 * relaunch.
 */

interface FieldDef {
  field: SettingsField;
  label: string;
  secret: boolean;
}

const FIELD_DEFS: FieldDef[] = [
  { field: 'TMDB_API_KEY', label: 'TMDB API key', secret: true },
  { field: 'OMDB_API_KEY', label: 'OMDb API key', secret: true },
  { field: 'TVDB_API_KEY', label: 'TVDB API key', secret: true },
  { field: 'MEDIA_ROOT', label: 'Media folder', secret: false },
];

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'fail'; error: string };

/** Minimal shape of the File System Access directory picker — not in the
 *  default TS DOM lib. We only read `.name`; absolute paths aren't exposed by
 *  the API, so we capture what we can (see file-header note). */
interface DirHandleLike {
  name: string;
}
type DirPicker = (opts?: unknown) => Promise<DirHandleLike>;

@customElement('settings-view')
export class SettingsView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text-primary);
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header h1 {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }
    .icon-btn {
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-secondary);
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }
    .icon-btn:hover { border-color: var(--accent); color: var(--text-primary); }
    .icon-btn svg { width: 16px; height: 16px; }

    .body {
      max-width: 640px;
      margin: 0 auto;
      padding: 24px 16px 64px;
    }
    .intro {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.5;
      margin: 0 0 24px;
    }

    .field {
      margin-bottom: 24px;
    }
    .field-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }
    .field-label {
      font-size: 14px;
      font-weight: 600;
    }
    .req {
      color: var(--text-secondary);
      font-weight: 400;
      font-size: 12px;
      margin-left: 6px;
    }
    .signup {
      font-size: 12px;
      color: var(--accent);
      text-decoration: none;
      white-space: nowrap;
    }
    .signup:hover { text-decoration: underline; }

    /* Always-visible saved-state line above the input. */
    .saved-line {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .saved-line.set { color: var(--success, #3fb950); }
    .saved-line.unset-req { color: var(--warning, #d29922); }
    .saved-line.unset-opt { color: var(--text-secondary); }
    .saved-hint {
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .input-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    input {
      flex: 1;
      min-width: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font: inherit;
      font-size: 13px;
      padding: 8px 10px;
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
      padding: 8px 14px;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
    }
    button.action:hover:not(:disabled) { border-color: var(--accent); }
    button.action:disabled { opacity: 0.5; cursor: default; }

    .status {
      font-size: 12px;
      margin-top: 6px;
      min-height: 16px;
    }
    .status.ok { color: var(--success, #3fb950); }
    .status.fail { color: var(--danger, #f85149); }
    .status.testing { color: var(--text-secondary); }

    .picker-note {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 6px;
      line-height: 1.4;
    }

    .footer {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }
    button.save {
      background: var(--accent);
      border: 1px solid var(--accent);
      color: var(--accent-contrast, #fff);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 20px;
      cursor: pointer;
    }
    button.save:disabled { opacity: 0.5; cursor: default; }
    .save-msg { font-size: 13px; }
    .save-msg.ok { color: var(--success, #3fb950); }
    .save-msg.fail { color: var(--danger, #f85149); }

    .loading, .error {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-secondary);
    }

    /* Access & server section. */
    .section {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }
    .section h2 {
      font-size: 15px;
      font-weight: 600;
      margin: 0 0 16px;
    }
    .sub-label {
      font-size: 13px;
      font-weight: 600;
      margin: 18px 0 4px;
    }
    .hint {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.4;
      margin: 0 0 8px;
    }
    .url-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }
    .url-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    code, .url {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .url {
      flex: 1;
      min-width: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      padding: 6px 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url.current { border-color: var(--accent); color: var(--text-primary); }
    .badge {
      font-size: 11px;
      color: var(--accent);
      flex-shrink: 0;
    }
    .port-row input { max-width: 140px; }
    button.danger {
      background: transparent;
      border: 1px solid var(--danger, #f85149);
      color: var(--danger, #f85149);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 16px;
      cursor: pointer;
    }
    button.danger:hover:not(:disabled) { background: rgba(248, 81, 73, 0.1); }
    button.danger:disabled { opacity: 0.5; cursor: default; }

    /* Library-health hidden-items list. */
    .hidden-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .hidden-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      padding: 10px 12px;
    }
    .hidden-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .hidden-title {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hidden-sub {
      font-size: 11px;
      color: var(--text-secondary);
    }
  `;

  @state() private settings: SettingsState | null = null;
  @state() private loadError: string | null = null;
  /** Per-field typed value (empty = untouched for secrets). */
  @state() private values: Partial<Record<SettingsField, string>> = {};
  /** Fields the user has edited this session — drives "save the typed value"
   *  vs "leave the saved value" for the non-secret media path. */
  @state() private dirty: Partial<Record<SettingsField, boolean>> = {};
  @state() private testStatus: Partial<Record<SettingsField, TestStatus>> = {};
  @state() private saving = false;
  @state() private saveMsg: { kind: 'ok' | 'fail'; text: string } | null = null;

  // Access & server-control section.
  @state() private access: SettingsAccess | null = null;
  @state() private portValue = '';
  @state() private portDirty = false;
  @state() private portMsg: { kind: 'ok' | 'fail'; text: string } | null = null;
  @state() private savingPort = false;
  @state() private copiedUrl: string | null = null;
  @state() private restarting = false;
  // Reset-data section.
  @state() private wiping: 'library' | 'all' | null = null;
  @state() private wipeMsg: { kind: 'ok' | 'fail'; text: string } | null = null;
  // Library-health (hidden items) section.
  @state() private hiddenItems: HiddenItem[] | null = null;
  @state() private hiddenLoading = false;
  @state() private restoringId: number | null = null;
  @state() private hiddenMsg: { kind: 'ok' | 'fail'; text: string } | null = null;
  private readonly pickerAvailable = folderPickerAvailable();

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void this.loadAccess();
    void this.loadHidden();
  }

  private async loadHidden(): Promise<void> {
    this.hiddenLoading = true;
    try {
      this.hiddenItems = await apiLibraryHidden();
    } catch {
      // Non-critical: leave the section showing "couldn't load".
      this.hiddenItems = null;
    } finally {
      this.hiddenLoading = false;
    }
  }

  private async onRestore(item: HiddenItem): Promise<void> {
    this.restoringId = item.id;
    this.hiddenMsg = null;
    try {
      const res = await apiLibraryRestore(item.id);
      if (res.restored) {
        this.hiddenMsg = {
          kind: 'ok',
          text: `Restored "${item.title ?? item.path}". It's back on the home screen.`,
        };
      } else {
        this.hiddenMsg = {
          kind: 'fail',
          text: `"${item.title ?? item.path}" couldn't be restored — its file may no longer be on disk.`,
        };
      }
      // Refresh the list and tell other views to refetch.
      await this.loadHidden();
      document.dispatchEvent(new CustomEvent('library-invalidated'));
    } catch (err) {
      this.hiddenMsg = { kind: 'fail', text: (err as Error).message ?? 'Restore failed' };
    } finally {
      this.restoringId = null;
    }
  }

  private async load(): Promise<void> {
    try {
      const s = await apiSettingsGet();
      this.settings = s;
      // Seed editable (non-secret) fields with their saved value so a reload
      // shows what's stored; leave secrets blank (we only have a masked hint).
      const seeded: Partial<Record<SettingsField, string>> = {};
      for (const def of FIELD_DEFS) {
        if (!def.secret) seeded[def.field] = s[def.field].value ?? '';
      }
      this.values = seeded;
      this.dirty = {};
      this.testStatus = {};
    } catch (err) {
      this.loadError = (err as Error).message ?? 'Failed to load settings';
    }
  }

  private async loadAccess(): Promise<void> {
    try {
      const a = await apiSettingsAccess();
      this.access = a;
      this.portValue = String(a.port);
      this.portDirty = false;
    } catch {
      // Access info is non-critical; leave the section hidden on failure.
    }
  }

  private onInput(field: SettingsField, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.setValue(field, v);
  }

  private setValue(field: SettingsField, v: string): void {
    this.values = { ...this.values, [field]: v };
    this.dirty = { ...this.dirty, [field]: true };
    // Typing invalidates any prior test result for this field.
    if (this.testStatus[field] && this.testStatus[field]!.kind !== 'idle') {
      this.testStatus = { ...this.testStatus, [field]: { kind: 'idle' } };
    }
    this.saveMsg = null;
  }

  /** What the user typed for a field, trimmed. Empty for an untouched secret. */
  private typed(field: SettingsField): string {
    return (this.values[field] ?? '').trim();
  }

  /** True once the user has edited this field this session. */
  private isDirty(field: SettingsField): boolean {
    return this.dirty[field] === true;
  }

  private async onTest(field: SettingsField): Promise<void> {
    const value = this.typed(field);
    const isSet = this.settings?.[field].set === true;
    // Nothing typed and nothing saved → can't test.
    if (!value && !isSet) {
      this.testStatus = {
        ...this.testStatus,
        [field]: { kind: 'fail', error: 'Enter a value to test' },
      };
      return;
    }
    this.testStatus = { ...this.testStatus, [field]: { kind: 'testing' } };
    try {
      // Empty value → server tests the saved key.
      const res = await apiSettingsTest(field, value || undefined);
      this.testStatus = {
        ...this.testStatus,
        [field]: res.ok
          ? { kind: 'ok' }
          : { kind: 'fail', error: res.error ?? 'Test failed' },
      };
    } catch (err) {
      this.testStatus = {
        ...this.testStatus,
        [field]: { kind: 'fail', error: (err as Error).message ?? 'Test failed' },
      };
    }
  }

  /** Open the native directory picker (server-machine only; gated by
   *  `pickerAvailable`). The API exposes only the folder name, not an absolute
   *  path, so we drop the name into the field for the user to complete/confirm,
   *  then Test (stat) verifies it. */
  private async onChooseFolder(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker })
      .showDirectoryPicker;
    if (typeof picker !== 'function') return;
    try {
      const handle = await picker();
      // The browser only gives us the leaf folder name. Pre-fill it so the
      // user can prepend the parent path (or confirm if they navigated to the
      // real folder on the server box).
      this.setValue('MEDIA_ROOT', handle.name);
    } catch {
      // User cancelled the picker — no-op.
    }
  }

  private onPortInput(e: Event): void {
    this.portValue = (e.target as HTMLInputElement).value;
    this.portDirty = true;
    this.portMsg = null;
  }

  private async onSavePort(): Promise<void> {
    const port = Number(this.portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.portMsg = { kind: 'fail', text: 'Enter a port between 1 and 65535.' };
      return;
    }
    this.savingPort = true;
    this.portMsg = null;
    try {
      await apiSettingsPort(port);
      this.portDirty = false;
      // Refresh the URL list to reflect the new port (still the old listener
      // until restart, but the saved value is what we show).
      if (this.access) this.access = { ...this.access, port };
      this.portMsg = {
        kind: 'ok',
        text: 'Saved. Restart the server for the new port to take effect.',
      };
    } catch (err) {
      this.portMsg = { kind: 'fail', text: (err as Error).message ?? 'Save failed' };
    } finally {
      this.savingPort = false;
    }
  }

  private async onRestart(): Promise<void> {
    const ok = window.confirm(
      'Restart the server now? It will only come back if a supervisor ' +
        '(Task Scheduler, NSSM, pm2, etc.) is configured to relaunch it on exit. ' +
        'This tab will lose its connection.',
    );
    if (!ok) return;
    this.restarting = true;
    await apiSettingsRestart();
    // The process is exiting; the reconnect overlay (0.1.11) takes over when
    // the server stops responding. Leave the button in its "restarting" state.
  }

  private async onWipeDb(scope: 'library' | 'all'): Promise<void> {
    const prompt =
      scope === 'all'
        ? 'Delete EVERYTHING? This clears your whole library AND your manual ' +
          'title fixes and watch history. This cannot be undone.'
        : 'Rebuild the library? This clears the scanned library so the next ' +
          'refresh re-identifies and re-probes every file. Your manual title ' +
          'fixes and watch history are kept.';
    if (!window.confirm(prompt)) return;
    this.wiping = scope;
    this.wipeMsg = null;
    try {
      const res = await apiSettingsWipeDb(scope);
      this.wipeMsg = {
        kind: 'ok',
        text:
          scope === 'all'
            ? `Done — ${res.cleared} record(s) cleared. Run a refresh to rebuild your library.`
            : `Done — library cleared (${res.cleared} record(s)). Run a refresh to rebuild it.`,
      };
    } catch (err) {
      this.wipeMsg = { kind: 'fail', text: (err as Error).message ?? 'Reset failed' };
    } finally {
      this.wiping = null;
    }
  }

  private async onCopyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.copiedUrl = url;
      setTimeout(() => {
        if (this.copiedUrl === url) this.copiedUrl = null;
      }, 1500);
    } catch {
      // Clipboard may be blocked on insecure origins; ignore.
    }
  }

  /** Required fields are satisfied when already saved OR the user typed something. */
  private requiredSatisfied(): boolean {
    if (!this.settings) return false;
    for (const def of FIELD_DEFS) {
      const st = this.settings[def.field];
      if (st.required && !st.set && !this.typed(def.field)) return false;
    }
    return true;
  }

  private async onSave(): Promise<void> {
    if (!this.settings) return;
    // Warn (don't block) if a required key was typed but never passed Test.
    for (const def of FIELD_DEFS) {
      if (!this.settings[def.field].required) continue;
      const v = this.typed(def.field);
      const status = this.testStatus[def.field]?.kind;
      if (v && status !== 'ok') {
        const ok = window.confirm(
          `You haven't confirmed "${def.label}" with Test. Save anyway?`,
        );
        if (!ok) return;
        break;
      }
    }

    // Build the payload: only send fields the user actually changed. Secrets:
    // a non-empty typed value replaces the key; untouched → omit (keep saved).
    // Non-secret media path: send only if edited this session.
    const payload: Partial<Record<SettingsField, string>> = {};
    for (const def of FIELD_DEFS) {
      const v = this.typed(def.field);
      if (def.secret) {
        if (v) payload[def.field] = v;
      } else if (this.isDirty(def.field)) {
        payload[def.field] = v;
      }
    }

    if (Object.keys(payload).length === 0) {
      this.saveMsg = { kind: 'ok', text: 'No changes to save.' };
      return;
    }

    this.saving = true;
    this.saveMsg = null;
    try {
      const next = await apiSettingsSave(payload);
      this.settings = next;
      // Reseed editable fields from the saved state; clear typed secrets so
      // they show their fresh masked hint.
      const reseed: Partial<Record<SettingsField, string>> = {};
      for (const def of FIELD_DEFS) {
        if (!def.secret) reseed[def.field] = next[def.field].value ?? '';
      }
      this.values = reseed;
      this.dirty = {};
      this.testStatus = {};
      const mediaChanged = payload.MEDIA_ROOT !== undefined;
      this.saveMsg = {
        kind: 'ok',
        text: mediaChanged
          ? 'Saved. Run a refresh to re-scan the new media folder.'
          : 'Saved.',
      };
    } catch (err) {
      this.saveMsg = { kind: 'fail', text: (err as Error).message ?? 'Save failed' };
    } finally {
      this.saving = false;
    }
  }

  /** The persistent "what's stored" line shown above every field's input. */
  private renderSavedLine(def: FieldDef, st: SettingsFieldState): unknown {
    if (st.set) {
      const hint = def.secret
        ? st.masked
          ? html` <span class="saved-hint">${st.masked}</span>`
          : null
        : st.value
          ? html` <span class="saved-hint">${st.value}</span>`
          : null;
      return html`<div class="saved-line set">✓ Saved${hint}</div>`;
    }
    return st.required
      ? html`<div class="saved-line unset-req">● Required — not set</div>`
      : html`<div class="saved-line unset-opt">○ Optional — not set</div>`;
  }

  private renderField(def: FieldDef): unknown {
    if (!this.settings) return null;
    const st: SettingsFieldState = this.settings[def.field];
    const status = this.testStatus[def.field] ?? { kind: 'idle' as const };
    // For a saved secret, prompt to replace; otherwise prompt to add.
    const placeholder = def.secret
      ? st.set
        ? 'Enter a new key to replace'
        : st.required
          ? 'Paste your key'
          : 'Optional — paste a key'
      : 'D:\\Media';
    // Test is possible when something is typed OR a value is already saved.
    const canTest = this.typed(def.field).length > 0 || st.set;
    return html`
      <div class="field">
        <div class="field-head">
          <span class="field-label">
            ${def.label}
            <span class="req">${st.required ? '(required)' : '(optional)'}</span>
          </span>
          ${st.signupUrl
            ? html`<a class="signup" href=${st.signupUrl} target="_blank" rel="noopener">
                Get a key ↗
              </a>`
            : null}
        </div>
        ${this.renderSavedLine(def, st)}
        <div class="input-row">
          <input
            type=${def.secret ? 'password' : 'text'}
            autocomplete="off"
            spellcheck="false"
            placeholder=${placeholder}
            .value=${this.values[def.field] ?? ''}
            @input=${(e: Event): void => this.onInput(def.field, e)}
          />
          ${def.field === 'MEDIA_ROOT' && this.pickerAvailable
            ? html`<button
                class="action"
                @click=${(): void => { void this.onChooseFolder(); }}
              >Choose folder…</button>`
            : null}
          <button
            class="action"
            ?disabled=${status.kind === 'testing' || !canTest}
            @click=${(): void => { void this.onTest(def.field); }}
          >Test</button>
        </div>
        ${this.renderStatus(status, def)}
        ${def.field === 'MEDIA_ROOT'
          ? this.pickerAvailable
            ? html`<div class="picker-note">
                <strong>Choose folder…</strong> browses this machine — use it only
                when you're on the server itself. Otherwise type the folder's path
                as it exists on the server (e.g. <code>D:\\Media</code>).
              </div>`
            : html`<div class="picker-note">
                Type the folder's path as it exists on the server (e.g.
                <code>D:\\Media</code>). The visual folder picker only works when
                you open Settings <strong>on the server machine</strong> at
                <code>http://localhost</code> — it's unavailable over the network.
              </div>`
          : null}
      </div>
    `;
  }

  private renderStatus(status: TestStatus, def: FieldDef): unknown {
    const verb = def.secret ? 'key' : 'folder';
    switch (status.kind) {
      case 'testing':
        return html`<div class="status testing">Testing…</div>`;
      case 'ok':
        return html`<div class="status ok">✓ ${def.secret ? 'Key works' : 'Folder exists'}</div>`;
      case 'fail':
        return html`<div class="status fail">✗ ${status.error}</div>`;
      case 'idle':
      default:
        return html`<div class="status" aria-hidden="true" data-verb=${verb}></div>`;
    }
  }

  override render(): unknown {
    return html`
      <div class="header">
        <button
          class="icon-btn"
          title="Back"
          @click=${(): void => goBack(homeHref())}
        >${iconBackChevron()}</button>
        <h1>Settings</h1>
      </div>
      ${this.loadError
        ? html`<div class="error">${this.loadError}</div>`
        : !this.settings
          ? html`<div class="loading">Loading…</div>`
          : html`
              <div class="body">
                <p class="intro">
                  Supply your own API keys and media folder. Use
                  <strong>Get a key</strong> to sign up, paste the key, click
                  <strong>Test</strong>, then <strong>Save</strong>. Each field
                  shows whether a value is already stored. Changes take effect
                  immediately — no restart needed.
                </p>
                ${FIELD_DEFS.map((def) => this.renderField(def))}
                <div class="footer">
                  <button
                    class="save"
                    ?disabled=${this.saving || !this.requiredSatisfied()}
                    @click=${(): void => { void this.onSave(); }}
                  >${this.saving ? 'Saving…' : 'Save'}</button>
                  ${this.saveMsg
                    ? html`<span class="save-msg ${this.saveMsg.kind}">${this.saveMsg.text}</span>`
                    : null}
                </div>
                ${this.renderAccess()}
                ${this.renderPlayback()}
                ${this.renderLibraryHealth()}
                ${this.renderResetData()}
              </div>
            `}
    `;
  }

  /** 0.2.0 (D9) — Playback section. The persistent "Basic Player" escape hatch,
   *  also reachable from a stalled player's error panel. Switches this device to
   *  the native-HLS legacy client (?platform=legacy) — for old TVs/consoles or
   *  when modern playback won't start. */
  private renderPlayback(): unknown {
    return html`
      <div class="section">
        <h2>Playback</h2>
        <p>
          If video won't play on this device (older TV, console, or a stalled
          player), switch to the Basic Player — a lightweight player that works
          on more devices, with fewer features.
        </p>
        <button @click=${(): void => forceBasicPlayer()}>Switch to Basic Player</button>
      </div>
    `;
  }

  /** Library health: items that vanished from the home screen but whose file is
   *  still on disk (e.g. an identify mix-up cross-wired them). One-click Restore
   *  brings each back with its existing metadata — no full library reset. */
  private renderLibraryHealth(): unknown {
    const items = this.hiddenItems;
    // Hide the whole section when there's nothing to fix — the common case.
    if (!this.hiddenLoading && (!items || items.length === 0) && !this.hiddenMsg) {
      return null;
    }
    return html`
      <div class="section">
        <h2>Library health</h2>
        <p class="hint">
          These titles are on disk but stopped showing on the home screen —
          usually after an identify mix-up. <strong>Restore</strong> brings one
          back with its current details. If it comes back as the wrong title,
          use <strong>Identify</strong> on its tile to fix it.
        </p>
        ${this.hiddenMsg
          ? html`<div class="status ${this.hiddenMsg.kind}" style="margin-bottom:12px">
              ${this.hiddenMsg.text}
            </div>`
          : null}
        ${this.hiddenLoading
          ? html`<div class="hint">Checking…</div>`
          : !items || items.length === 0
            ? html`<div class="hint">Nothing hidden — your library looks healthy.</div>`
            : html`
                <div class="hidden-list">
                  ${items.map(
                    (it) => html`
                      <div class="hidden-row">
                        <div class="hidden-meta">
                          <span class="hidden-title">${it.title ?? it.path}</span>
                          <span class="hidden-sub">
                            ${it.type === 'series' ? 'Show' : 'Movie'}${it.year
                              ? html` · ${it.year}`
                              : null}
                          </span>
                        </div>
                        <button
                          class="action"
                          ?disabled=${this.restoringId !== null}
                          @click=${(): void => { void this.onRestore(it); }}
                        >${this.restoringId === it.id ? 'Restoring…' : 'Restore'}</button>
                      </div>
                    `,
                  )}
                </div>
              `}
      </div>
    `;
  }

  /** Reset-data controls: rebuild the library (keeps fixes + history) or delete
   *  everything. Both confirm first and disable while a wipe is in flight. */
  private renderResetData(): unknown {
    return html`
      <div class="section">
        <h2>Reset data</h2>

        <div class="sub-label">Rebuild library</div>
        <p class="hint">
          Clears the scanned library so the next refresh re-identifies and
          re-probes every file from scratch. Your manual title fixes and watch
          history are kept. Use this if identification or probe data looks wrong.
        </p>
        <button
          class="danger"
          ?disabled=${this.wiping !== null}
          @click=${(): void => { void this.onWipeDb('library'); }}
        >${this.wiping === 'library' ? 'Rebuilding…' : 'Rebuild library'}</button>

        <div class="sub-label" style="margin-top:24px">Delete everything</div>
        <p class="hint">
          Wipes the entire database — the library <strong>and</strong> your
          manual title fixes and watch history. Starts completely fresh. This
          cannot be undone.
        </p>
        <button
          class="danger"
          ?disabled=${this.wiping !== null}
          @click=${(): void => { void this.onWipeDb('all'); }}
        >${this.wiping === 'all' ? 'Deleting…' : 'Delete everything'}</button>

        ${this.wipeMsg
          ? html`<div class="status ${this.wipeMsg.kind}" style="margin-top:12px">
              ${this.wipeMsg.text}
            </div>`
          : null}
      </div>
    `;
  }

  /** Access & server controls: reachable URLs, port, restart. Hidden until the
   *  /access fetch resolves (non-critical). */
  private renderAccess(): unknown {
    const a = this.access;
    if (!a) return null;
    return html`
      <div class="section">
        <h2>Access &amp; server</h2>

        <div class="sub-label">Open from another device</div>
        <p class="hint">
          On a phone, TV, or laptop on the same network, browse to one of these:
        </p>
        <div class="url-list">
          ${a.urls.map((url) => {
            const current = a.host != null && url.includes(`//${a.host}:`);
            return html`<div class="url-row">
              <code class="url ${current ? 'current' : ''}">${url}</code>
              ${current ? html`<span class="badge">this device</span>` : null}
              <button class="action" @click=${(): void => { void this.onCopyUrl(url); }}>
                ${this.copiedUrl === url ? 'Copied' : 'Copy'}
              </button>
            </div>`;
          })}
        </div>

        <div class="sub-label">Port</div>
        <div class="input-row port-row">
          <input
            type="text"
            inputmode="numeric"
            .value=${this.portValue}
            @input=${(e: Event): void => this.onPortInput(e)}
          />
          <button
            class="action"
            ?disabled=${this.savingPort || !this.portDirty}
            @click=${(): void => { void this.onSavePort(); }}
          >${this.savingPort ? 'Saving…' : 'Save port'}</button>
        </div>
        ${this.portMsg
          ? html`<div class="status ${this.portMsg.kind}">${this.portMsg.text}</div>`
          : html`<div class="hint">
              Changing the port requires a server restart to take effect.
            </div>`}

        <div class="sub-label">Restart</div>
        <p class="hint">
          Restarts the server process. It only comes back if a supervisor
          (Task Scheduler, NSSM, pm2, …) is set to relaunch it on exit. The page
          will reconnect automatically once it's back.
        </p>
        <button
          class="danger"
          ?disabled=${this.restarting}
          @click=${(): void => { void this.onRestart(); }}
        >${this.restarting ? 'Restarting…' : 'Restart server'}</button>
      </div>
    `;
  }
}
