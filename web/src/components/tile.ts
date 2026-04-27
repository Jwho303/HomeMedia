import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { LibraryItem } from '../types.js';

@customElement('media-tile')
export class MediaTile extends LitElement {
  static override styles = css`
    :host {
      display: block;
      cursor: pointer;
      transition: transform 0.1s ease;
    }
    :host(:hover) { transform: scale(1.03); }

    .frame {
      position: relative;
      aspect-ratio: 2 / 3;
      background: var(--surface-elevated);
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid var(--border-strong);
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .badge {
      position: absolute;
      top: 6px;
      right: 6px;
      background: var(--scrim-strong);
      color: var(--on-scrim);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-tertiary);
      font-size: 11px;
      padding: 8px;
      text-align: center;
    }
    .meta {
      padding: 6px 4px 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .title {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .year {
      font-size: 11px;
      color: var(--text-secondary);
    }
  `;

  @property({ attribute: false }) item!: LibraryItem;

  override render(): unknown {
    const i = this.item;
    const title = i.title ?? i.path;
    return html`
      <div class="frame">
        ${i.posterUrl
          ? html`<img src=${i.posterUrl} alt=${title} loading="lazy" />`
          : html`<div class="placeholder">${title}</div>`}
        <span class="badge">${i.type}</span>
      </div>
      <div class="meta">
        <div class="title" title=${title}>${title}</div>
        ${i.year ? html`<div class="year">${i.year}</div>` : null}
      </div>
    `;
  }
}
