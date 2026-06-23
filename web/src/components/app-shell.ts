import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { currentRoute, onRouteChange, type Route } from '../router.js';
import { FocusNavController } from '../nav/focus-nav-controller.js';
import {
  apiRefresh,
  apiReprobeEpisode,
  apiReprobeItem,
  apiReprobeLibrary,
  apiSetupState,
} from '../api.js';
import {
  applyScanEvent,
  clearScanProgress,
  startJob,
} from '../scan-progress-store.js';
import type { ScanProgressEvent } from '../types.js';
import './share-banner.js';
import './reconnect-overlay.js';
import './home-view.js';
import './series-detail.js';
import './media-player.js';
import './search-view.js';
import './settings-view.js';
import './uncategorized-view.js';
import './ftue-wizard.js';
import { FTUE_COMPLETE_EVENT } from './ftue-wizard.js';
import './manual-identify-modal.js';
import './glyph-hint-bar.js';
import type { ManualIdentifyTarget } from './manual-identify-modal.js';
import type { GlyphHint } from './glyph-hint-bar.js';
import type { GlyphPlatform } from '../nav/gamepad-detect.js';

/** Custom events bubbled up by views to ask `<app-shell>` to start a job. */
export interface RefreshTrigger {
  full: boolean;
}
export interface ReprobeItemTrigger {
  id: number;
}
export interface ReprobeEpisodeTrigger {
  id: number;
}

/** Request payload bubbled up by a kebab item to open the manual-identify modal. */
export type ManualIdentifyRequest = ManualIdentifyTarget;

/** Document-level event dispatched after a successful manual-identify Apply.
 *  Views with cached library data listen on `document` and refetch. (0.1.5.2) */
export const LIBRARY_INVALIDATED_EVENT = 'library-invalidated';

@customElement('app-shell')
export class AppShell extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }
    main { display: block; }
  `;

  @state() private route: Route = currentRoute();
  @state() private manualIdentifyTarget: ManualIdentifyTarget | null = null;
  /** 0.1.13 — first-run gate. `checking` while we poll `/api/setup-state`;
   *  `wizard` when the install isn't set up (or has no library yet) so we show
   *  the FTUE takeover; `ready` for the normal app. Until `ready`, normal
   *  routing is never rendered, so the user can't stumble into a guarded view. */
  @state() private gate: 'checking' | 'wizard' | 'ready' = 'checking';
  private unsub: (() => void) | null = null;
  private eventSource: EventSource | null = null;
  /** 0.2.0 (Layer 1) — D-pad focus navigation. Attached only when the boot
   *  router diagnosed `inputMode==='dpad'`; a no-op on pointer/touch. */
  private focusNav: FocusNavController | null = null;
  /** Resolves to the final ScanResult for the in-flight job, when callers care. */
  private currentJobResolve: ((value: Record<string, unknown>) => void) | null = null;
  private currentJobReject: ((err: Error) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsub = onRouteChange((r) => { this.route = r; });
    // 0.1.13 — decide whether to show the FTUE wizard before rendering routes.
    document.addEventListener(FTUE_COMPLETE_EVENT, this.onFtueComplete);
    void this.checkSetup();
    this.addEventListener('refresh-trigger', this.onRefreshTrigger as EventListener);
    this.addEventListener('reprobe-library-trigger', this.onReprobeLibraryTrigger as EventListener);
    this.addEventListener('reprobe-item-trigger', this.onReprobeItemTrigger as EventListener);
    this.addEventListener('reprobe-episode-trigger', this.onReprobeEpisodeTrigger as EventListener);
    this.addEventListener('manual-identify-request', this.onManualIdentifyRequest as EventListener);
    // 0.2.0 (Layer 1) — attach D-pad navigation. The controller reads
    // window.__hm.diag.inputMode itself and is a no-op unless it is 'dpad', so
    // pointer/touch builds carry zero behavioural change (D2). Attached on the
    // document so it sees focusable elements across every view's shadow DOM.
    this.focusNav = new FocusNavController();
    this.focusNav.attach();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    document.removeEventListener(FTUE_COMPLETE_EVENT, this.onFtueComplete);
    this.removeEventListener('refresh-trigger', this.onRefreshTrigger as EventListener);
    this.removeEventListener('reprobe-library-trigger', this.onReprobeLibraryTrigger as EventListener);
    this.removeEventListener('reprobe-item-trigger', this.onReprobeItemTrigger as EventListener);
    this.removeEventListener('reprobe-episode-trigger', this.onReprobeEpisodeTrigger as EventListener);
    this.removeEventListener('manual-identify-request', this.onManualIdentifyRequest as EventListener);
    this.closeEventSource();
    this.focusNav?.detach();
    this.focusNav = null;
  }

  /** 0.1.13 — gate normal routing on setup completeness. A fresh / unbuilt
   *  install shows the wizard; a healthy install boots straight to the app.
   *  On any error reaching `/api/setup-state` we fail open to the wizard — a
   *  reachable-but-unconfigured server is exactly the FTUE case, and the
   *  wizard re-polls on mount so a transient blip self-corrects. */
  private async checkSetup(): Promise<void> {
    try {
      const s = await apiSetupState();
      this.gate = s.configured && s.libraryBuilt ? 'ready' : 'wizard';
    } catch {
      this.gate = 'wizard';
    }
  }

  private onFtueComplete = (): void => {
    this.gate = 'ready';
  };

  private onRefreshTrigger = (e: CustomEvent<RefreshTrigger>): void => {
    void this.runJob(() => apiRefresh(e.detail.full));
  };

  private onReprobeLibraryTrigger = (): void => {
    void this.runJob(() => apiReprobeLibrary());
  };

  private onReprobeItemTrigger = (e: CustomEvent<ReprobeItemTrigger>): void => {
    void this.runJob(() => apiReprobeItem(e.detail.id));
  };

  private onReprobeEpisodeTrigger = (e: CustomEvent<ReprobeEpisodeTrigger>): void => {
    void this.runJob(() => apiReprobeEpisode(e.detail.id));
  };

  private onManualIdentifyRequest = (e: CustomEvent<ManualIdentifyRequest>): void => {
    this.manualIdentifyTarget = e.detail;
  };

  private onManualIdentifyApplied = (): void => {
    this.manualIdentifyTarget = null;
    // Notify views so they refetch their data with the new identity in place.
    // Document-level so any view listening (regardless of DOM position) picks
    // it up — bubbling from <app-shell> doesn't reach its descendants.
    document.dispatchEvent(new CustomEvent(LIBRARY_INVALIDATED_EVENT));
  };

  private onManualIdentifyCancelled = (): void => {
    this.manualIdentifyTarget = null;
  };

  private async runJob(
    kickoff: () => Promise<{ jobId: string }>,
  ): Promise<void> {
    try {
      const k = await kickoff();
      startJob(k.jobId);
      this.openEventSource();
    } catch (err) {
      // Surface the kickoff error via the store; views that care can render it.
      applyScanEvent({ type: 'error', message: (err as Error).message ?? 'kickoff_failed' });
    }
  }

  private openEventSource(): void {
    this.closeEventSource();
    if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      return;
    }
    const es = new window.EventSource('/api/refresh-progress');
    this.eventSource = es;
    es.addEventListener('message', (ev) => {
      let event: ScanProgressEvent;
      try {
        event = JSON.parse((ev as MessageEvent).data) as ScanProgressEvent;
      } catch {
        return;
      }
      applyScanEvent(event);
      if (event.type === 'done') {
        this.currentJobResolve?.(event.result);
        this.currentJobResolve = null;
        this.currentJobReject = null;
        this.closeEventSource();
        // Notify views that a job completed so they can refetch library / etc.
        this.dispatchEvent(
          new CustomEvent('scan-job-complete', {
            detail: event.result,
            bubbles: true,
            composed: true,
          }),
        );
        // Reset the store after a tick so transient progress UI fades cleanly.
        setTimeout(() => clearScanProgress(), 250);
      } else if (event.type === 'error') {
        this.currentJobReject?.(new Error(event.message));
        this.currentJobResolve = null;
        this.currentJobReject = null;
        this.closeEventSource();
      }
    });
    es.addEventListener('error', () => {
      // EventSource auto-reconnects on transient errors; only escalate if the
      // server explicitly closed the stream (readyState === CLOSED).
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

  /** 0.2.0 — boot-router diagnosis, read off window.__hm. Drives the dpad
   *  focus nav + the glyph hint bar. Safe when boot.js didn't run (tests):
   *  defaults to pointer/generic so nothing couch-specific renders. */
  private bootDiag(): { inputMode: string; platform: GlyphPlatform; forcedGlyph: boolean } {
    const hm = (window as unknown as {
      __hm?: { diag?: { inputMode?: string; platform?: string; forcedGlyph?: boolean } };
    }).__hm;
    const inputMode = hm?.diag?.inputMode ?? 'pointer';
    const platform = hm?.diag?.platform;
    const glyphPlatform: GlyphPlatform =
      platform === 'xbox' || platform === 'playstation' ? platform : 'generic';
    // `?glyph=` / __hm.spoof() pins the glyph platform — don't let a live
    // gamepad override it (the whole point is previewing on a desktop).
    return { inputMode, platform: glyphPlatform, forcedGlyph: hm?.diag?.forcedGlyph === true };
  }

  override render(): unknown {
    // 0.1.13 — first-run gate. Hold rendering until we know the setup state, so
    // the normal app never flashes for a fresh installer; show the wizard until
    // it signals complete.
    if (this.gate === 'checking') return html`<main></main>`;
    if (this.gate === 'wizard') return html`<ftue-wizard></ftue-wizard>`;
    const diag = this.bootDiag();
    return html`
      <share-banner></share-banner>
      <main>${this.renderRoute()}</main>
      <manual-identify-modal
        ?open=${this.manualIdentifyTarget != null}
        .target=${this.manualIdentifyTarget}
        @applied=${(): void => this.onManualIdentifyApplied()}
        @cancelled=${(): void => this.onManualIdentifyCancelled()}
      ></manual-identify-modal>
      <reconnect-overlay></reconnect-overlay>
      ${diag.inputMode === 'dpad'
        ? this.renderGlyphHintBar(diag.platform, diag.forcedGlyph)
        : null}
    `;
  }

  /** 0.2.0 (Layer 2) — the contextual glyph prompts, pinned to the bottom in
   *  dpad mode. The hints adapt to the active view; the player owns its own
   *  on-screen chrome, so we show the browse-level prompts everywhere else. */
  private renderGlyphHintBar(platform: GlyphPlatform, forced: boolean): unknown {
    const playing = this.route.name === 'play';
    const hints: GlyphHint[] = playing
      ? [
          { kind: 'confirm', label: 'Play / Pause' },
          { kind: 'back', label: 'Back' },
        ]
      : [
          { kind: 'confirm', label: 'Select' },
          { kind: 'menu', label: 'Options' },
          { kind: 'back', label: 'Back' },
        ];
    return html`
      <glyph-hint-bar
        style="position:fixed;left:0;right:0;bottom:0;z-index:50;"
        .platform=${platform}
        ?forced=${forced}
        .hints=${hints}
      ></glyph-hint-bar>
    `;
  }

  private renderRoute(): unknown {
    switch (this.route.name) {
      case 'home':
        return html`<home-view></home-view>`;
      case 'series':
        return html`<series-detail .seriesId=${this.route.id}></series-detail>`;
      case 'play':
        return html`<media-player .relPath=${this.route.path}></media-player>`;
      case 'search':
        return html`<search-view></search-view>`;
      case 'settings':
        return html`<settings-view></settings-view>`;
      case 'uncategorized':
        return html`<uncategorized-view></uncategorized-view>`;
      case 'unknown':
      default:
        return html`<div style="padding:24px">Unknown route: ${this.route.name === 'unknown' ? this.route.hash : ''}</div>`;
    }
  }
}
