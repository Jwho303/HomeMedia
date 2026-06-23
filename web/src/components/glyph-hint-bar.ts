/**
 * 0.2.0 (Layer 2) — controller-glyph hint bar.
 *
 * A thin, cosmetic prompt strip that themes button hints by detected platform:
 * Xbox renders Ⓐ/Ⓑ, PlayStation ✕/○, and an unknown/`generic` platform renders
 * neutral text labels ("OK" / "Back") — wrong glyphs are worse than generic
 * ones (D7). It is rendered only in dpad mode (the app-shell gates it) and
 * carries zero behaviour: it does not capture input, it just tells the user
 * what the confirm/back buttons do.
 *
 * The `platform` property seeds from the boot router's classification; the bar
 * then refines it live off the Gamepad API on `gamepadconnected`, since a
 * controller's id ("DualSense") is more specific than a UA guess (D7).
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  iconXboxA,
  iconXboxB,
  iconXboxY,
  iconPsCross,
  iconPsCircle,
  iconPsTriangle,
} from './icons.js';
import { detectGlyphPlatform, type GlyphPlatform } from '../nav/gamepad-detect.js';

/** One prompt: a button + what it does. `kind` selects which glyph to show
 *  (confirm = Ⓐ/✕, back = Ⓑ/○, menu = ☰/Options); the label is the action text. */
export interface GlyphHint {
  kind: 'confirm' | 'back' | 'menu';
  label: string;
}

const DEFAULT_HINTS: GlyphHint[] = [
  { kind: 'confirm', label: 'Select' },
  { kind: 'back', label: 'Back' },
];

@customElement('glyph-hint-bar')
export class GlyphHintBar extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-size: 13px;
      color: var(--on-scrim, #fff);
      background: var(--scrim-soft, rgba(0, 0, 0, 0.6));
      /* Flat + cheap to render — weak TV CPUs. No blur/gradient. */
    }
    .bar {
      display: flex;
      gap: 18px;
      align-items: center;
      padding: 8px 16px;
    }
    .hint {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .glyph {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }
    /* Neutral fallback: a bordered text chip standing in for the button. */
    .neutral {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border: 1px solid currentColor;
      border-radius: var(--radius-sm, 4px);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
    }
  `;

  /** Seed platform — the boot router's classification ('xbox'|'playstation'|
   *  'generic'). Refined live by gamepad detection unless `forced`. */
  @property({ type: String }) platform: GlyphPlatform = 'generic';

  /** When set (via `?glyph=` / __hm.spoof()), `platform` is authoritative and a
   *  live gamepad will NOT override it — the point is previewing on a desktop. */
  @property({ type: Boolean }) forced = false;

  /** The prompts to show. Views set this per screen (browse vs player). */
  @property({ attribute: false }) hints: GlyphHint[] = DEFAULT_HINTS;

  /** The resolved platform actually used for rendering (gamepad-refined). */
  @state() private resolved: GlyphPlatform = 'generic';

  /** Pick the platform to render: the forced seed wins; otherwise refine the
   *  seed with any connected controller's id. */
  private resolve(): GlyphPlatform {
    return this.forced ? this.platform : detectGlyphPlatform(this.platform);
  }

  private onGamepad = (): void => {
    this.resolved = this.resolve();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.resolved = this.resolve();
    window.addEventListener('gamepadconnected', this.onGamepad);
    window.addEventListener('gamepaddisconnected', this.onGamepad);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('gamepadconnected', this.onGamepad);
    window.removeEventListener('gamepaddisconnected', this.onGamepad);
  }

  override willUpdate(changed: Map<string, unknown>): void {
    // If the seed platform or forced flag changes, re-resolve.
    if (changed.has('platform') || changed.has('forced')) {
      this.resolved = this.resolve();
    }
  }

  private renderGlyph(kind: 'confirm' | 'back' | 'menu'): unknown {
    const p = this.resolved;
    // `data-glyph` names the rendered set+button so consumers/tests can assert
    // which theme rendered without depending on SVG-internal serialization.
    // 'menu' = the "more options" face button: Ⓨ (Xbox) / △ (PlayStation).
    if (p === 'xbox') {
      const g =
        kind === 'confirm' ? iconXboxA() : kind === 'back' ? iconXboxB() : iconXboxY();
      return html`<span class="glyph" data-glyph="xbox-${kind}">${g}</span>`;
    }
    if (p === 'playstation') {
      const g =
        kind === 'confirm' ? iconPsCross() : kind === 'back' ? iconPsCircle() : iconPsTriangle();
      return html`<span class="glyph" data-glyph="ps-${kind}">${g}</span>`;
    }
    // Neutral fallback — text chip, never a wrong glyph (D7).
    const label = kind === 'confirm' ? 'OK' : kind === 'back' ? 'Back' : 'Menu';
    return html`<span class="neutral" data-glyph="neutral-${kind}">${label}</span>`;
  }

  override render(): unknown {
    return html`<div class="bar">
      ${this.hints.map(
        (h) => html`<span class="hint">${this.renderGlyph(h.kind)}<span>${h.label}</span></span>`,
      )}
    </div>`;
  }
}
