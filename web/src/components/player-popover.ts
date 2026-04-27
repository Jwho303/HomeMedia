import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('player-popover')
export class PlayerPopover extends LitElement {
  static override styles = css`
    :host {
      position: absolute;
      display: block;
      pointer-events: none;
      z-index: 30;
    }
    .panel {
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 14px;
      background: rgba(18, 18, 22, 0.92);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: 8px;
      transform-origin: bottom right;
      transform: scale(0.85);
      opacity: 0;
      transition:
        transform 220ms cubic-bezier(0.34, 1.2, 0.64, 1),
        opacity 220ms ease-out;
      pointer-events: none;
      visibility: hidden;
    }
    .panel[data-open] {
      transform: scale(1);
      opacity: 1;
      pointer-events: auto;
      visibility: visible;
    }
    /* Close transition is faster — spec says 180ms total. */
    .panel.closing {
      transition:
        transform 180ms ease-in,
        opacity 180ms ease-in;
    }
    .notch {
      position: absolute;
      bottom: -6px;
      width: 12px;
      height: 12px;
      transform: rotate(45deg);
      background: rgba(18, 18, 22, 0.92);
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    ::slotted(*) {
      transform-origin: bottom right;
      transform: translate(0, 40px) scale(0.6);
      opacity: 0;
      transition:
        transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 240ms ease-out;
      transition-delay: calc(var(--stagger-index, 0) * 18ms);
    }
    .panel[data-open] ::slotted(*) {
      transform: translate(0, 0) scale(1);
      opacity: 1;
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) width = 220;
  @property({ type: Number }) notchRightPx = 18;

  override render(): unknown {
    const styleMap = `width:${this.width}px;`;
    return html`
      <div class="panel" style=${styleMap} ?data-open=${this.open}>
        <slot></slot>
        <div class="notch" style="right:${this.notchRightPx}px"></div>
      </div>
    `;
  }
}
