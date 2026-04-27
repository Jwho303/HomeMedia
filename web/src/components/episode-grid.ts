import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Episode, SeriesDetail } from '../types.js';
import { iconCheck, iconPlay } from './icons.js';

export type TileState = 'watched' | 'current' | 'unwatched';

const RESUME_THRESHOLD = 0.9;

export function tileState(ep: Episode, currentPath: string): TileState {
  if (ep.path === currentPath) return 'current';
  if (ep.watched) return 'watched';
  return 'unwatched';
}

export function progressRatio(ep: Episode): number {
  if (ep.duration <= 0) return 0;
  const r = ep.position / ep.duration;
  if (!Number.isFinite(r) || r < 0) return 0;
  if (r > RESUME_THRESHOLD) return RESUME_THRESHOLD;
  return r;
}

@customElement('episode-grid')
export class EpisodeGrid extends LitElement {
  static override styles = css`
    :host {
      display: block;
      --hm-accent: var(--accent);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 8px 8px 10px;
      gap: 12px;
    }
    .header .show {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header .count {
      color: var(--text-secondary);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .scroll {
      max-height: 360px;
      overflow-y: auto;
      padding: 4px 4px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--accent) transparent;
    }
    .scroll::-webkit-scrollbar { width: 6px; }
    .scroll::-webkit-scrollbar-thumb {
      background: var(--accent);
      border-radius: var(--radius-pill);
      box-shadow: var(--shadow-accent);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 4px;
      cursor: pointer;
      background: transparent;
      border: 0;
      padding: 0;
      color: inherit;
      font: inherit;
      text-align: left;
    }
    .thumb {
      position: relative;
      aspect-ratio: 16 / 9;
      background: var(--surface-elevated);
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid var(--border);
      transition: border-color 120ms ease-out, transform 120ms ease-out;
    }
    .thumb img,
    .thumb .placeholder {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .thumb .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-disabled);
      font-size: 18px;
      font-weight: 700;
    }
    .tile:hover .thumb { border-color: var(--accent); }
    .tile.watched .thumb img,
    .tile.watched .thumb .placeholder { opacity: 0.5; }
    .tile.current .thumb {
      border: 2px solid var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .check {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--watched);
      color: var(--on-watched);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3px;
    }
    .tile.watched .check { display: flex; }
    .tile:not(.watched) .check { display: none; }
    .play-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--on-scrim);
      background: var(--scrim-faint);
    }
    .play-overlay .pi {
      width: 28px;
      height: 28px;
      background: var(--scrim-soft);
      border-radius: 50%;
      padding: 6px;
      box-sizing: border-box;
    }
    .progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: var(--scrub-track);
    }
    .progress .bar {
      height: 100%;
      background: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .label {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.3;
      padding: 0 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tile.watched .label { color: var(--text-tertiary); }
    .tile.current .label {
      color: var(--accent);
      font-weight: 600;
    }
    .footer {
      padding: 10px 8px 6px;
      border-top: 1px solid var(--border);
      margin-top: 6px;
    }
    .footer button {
      background: transparent;
      border: 0;
      color: var(--accent);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      padding: 4px;
    }
    .footer button:hover { color: var(--accent-hover); text-decoration: underline; }
  `;

  @property({ attribute: false }) detail: SeriesDetail | null = null;
  @property({ type: String }) currentPath = '';

  /** Centre the current-episode tile in the scroll container. The genie animation
   *  runs from the bottom-right; setting scroll position before opening avoids
   *  the panel jumping mid-animation. */
  scrollToCurrent(opts: { instant?: boolean } = {}): void {
    const root = this.renderRoot as ShadowRoot;
    const tile = root.querySelector<HTMLElement>('.tile.current');
    const scroller = root.querySelector<HTMLElement>('.scroll');
    if (!tile || !scroller) return;
    const tileMid = tile.offsetTop + tile.offsetHeight / 2;
    const target = tileMid - scroller.clientHeight / 2;
    scroller.scrollTo({
      top: Math.max(0, target),
      behavior: opts.instant ? 'auto' : 'smooth',
    });
  }

  private onTileClick(ep: Episode): void {
    this.dispatchEvent(
      new CustomEvent('episode-selected', {
        detail: { path: ep.path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onViewAllClick(): void {
    if (!this.detail) return;
    this.dispatchEvent(
      new CustomEvent('view-all-episodes', {
        detail: { seriesId: this.detail.series.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): unknown {
    if (!this.detail) {
      return html`<div style="padding:14px;color:#888;font-size:12px;">No episodes</div>`;
    }
    const { series, episodes } = this.detail;
    const currentEp = episodes.find((e) => e.path === this.currentPath);
    const showName = series.title ?? '—';
    const seasonNumber = currentEp?.season ?? episodes[0]?.season ?? 1;
    const seasonEps = episodes.filter((e) => e.season === seasonNumber);
    return html`
      <div class="header">
        <div class="show">${showName} · S${seasonNumber}</div>
        <div class="count">${seasonEps.length} episodes</div>
      </div>
      <div class="scroll">
        <div class="grid">
          ${seasonEps.map((ep, idx) => {
            const state = tileState(ep, this.currentPath);
            const ratio = state === 'current' ? progressRatio(ep) : 0;
            const label =
              state === 'current'
                ? html`<span>Now · E${ep.episode}</span>`
                : html`<span>E${ep.episode}</span>`;
            return html`
              <button
                class=${`tile ${state}`}
                style="--stagger-index:${idx}"
                @click=${(): void => this.onTileClick(ep)}
                title=${ep.title ?? `Episode ${ep.episode}`}
              >
                <div class="thumb">
                  ${ep.stillUrl
                    ? html`<img src=${ep.stillUrl} alt="" loading="lazy"/>`
                    : html`<div class="placeholder">E${ep.episode}</div>`}
                  <div class="check">${iconCheck()}</div>
                  ${state === 'current'
                    ? html`
                        <div class="play-overlay">
                          <div class="pi">${iconPlay()}</div>
                        </div>
                        <div class="progress">
                          <div class="bar" style="width:${(ratio * 100).toFixed(2)}%"></div>
                        </div>
                      `
                    : null}
                </div>
                <div class="label">${label}</div>
              </button>
            `;
          })}
        </div>
      </div>
      <div class="footer">
        <button @click=${(): void => this.onViewAllClick()}>View all episodes →</button>
      </div>
    `;
  }
}
