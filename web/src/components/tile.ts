import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { LibraryItem } from '../types.js';
import { formatImdbRating } from './poster-strip.js';

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
    /* IMDb rating pill — gold star + bare /10 number, top-left. (0.1.8) */
    .rating-pill {
      position: absolute;
      top: 6px;
      left: 6px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 11px;
      font-weight: 600;
      color: #111;
      background: linear-gradient(180deg, #ffe27a 0%, #f5c518 100%);
      padding: 2px 6px 2px 5px;
      border-radius: var(--radius-xs);
      line-height: 1;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }
    .rating-pill .star {
      width: 10px;
      height: 10px;
      fill: #111;
      flex-shrink: 0;
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
    const ratingLabel = formatImdbRating(i.imdbRating);
    return html`
      <div class="frame">
        ${i.posterUrl
          ? html`<img src=${i.posterUrl} alt=${title} loading="lazy" />`
          : html`<div class="placeholder">${title}</div>`}
        ${ratingLabel
          ? html`<span class="rating-pill" aria-label=${`IMDb rating ${ratingLabel} of 10`}>
              <svg class="star" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2 L14.85 8.63 L22 9.27 L16.5 14.14 L18.18 21.02 L12 17.27 L5.82 21.02 L7.5 14.14 L2 9.27 L9.15 8.63 Z"></path>
              </svg>
              ${ratingLabel}
            </span>`
          : null}
        <span class="badge">${i.type}</span>
      </div>
      <div class="meta">
        <div class="title" title=${title}>${title}</div>
        ${i.year ? html`<div class="year">${i.year}</div>` : null}
      </div>
    `;
  }
}
