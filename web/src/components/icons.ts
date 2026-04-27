import { html, svg, type TemplateResult } from 'lit';

const wrap = (path: TemplateResult, viewBox = '0 0 24 24'): TemplateResult => svg`
  <svg viewBox="${viewBox}" width="100%" height="100%" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${path}
  </svg>
`;

export const iconBackChevron = (): TemplateResult => html`${wrap(svg`<polyline points="15 6 9 12 15 18"/>`)}`;

export const iconPlay = (): TemplateResult => html`${wrap(svg`<polygon points="6 4 20 12 6 20" fill="currentColor"/>`)}`;
export const iconPause = (): TemplateResult => html`${wrap(svg`
  <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
  <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
`)}`;

export const iconPrev = (): TemplateResult => html`${wrap(svg`
  <polygon points="18 5 8 12 18 19" fill="currentColor"/>
  <line x1="6" y1="5" x2="6" y2="19"/>
`)}`;
export const iconNext = (): TemplateResult => html`${wrap(svg`
  <polygon points="6 5 16 12 6 19" fill="currentColor"/>
  <line x1="18" y1="5" x2="18" y2="19"/>
`)}`;

export const iconVolume = (): TemplateResult => html`${wrap(svg`
  <polygon points="3 10 3 14 7 14 12 18 12 6 7 10 3 10" fill="currentColor"/>
  <path d="M16 8c1.5 1 1.5 7 0 8"/>
  <path d="M19 6c2.5 1.5 2.5 10.5 0 12"/>
`)}`;
export const iconVolumeMute = (): TemplateResult => html`${wrap(svg`
  <polygon points="3 10 3 14 7 14 12 18 12 6 7 10 3 10" fill="currentColor"/>
  <line x1="16" y1="8" x2="22" y2="14"/>
  <line x1="22" y1="8" x2="16" y2="14"/>
`)}`;

export const iconCC = (): TemplateResult => html`${wrap(svg`
  <rect x="2" y="5" width="20" height="14" rx="2"/>
  <path d="M9 11c-.6-.5-1.4-.5-2 0s-.6 1.5 0 2 1.4.5 2 0"/>
  <path d="M16 11c-.6-.5-1.4-.5-2 0s-.6 1.5 0 2 1.4.5 2 0"/>
`)}`;

export const iconAudio = (): TemplateResult => html`${wrap(svg`
  <path d="M9 18V6l11-2v12"/>
  <circle cx="6" cy="18" r="3" fill="currentColor"/>
  <circle cx="17" cy="16" r="3" fill="currentColor"/>
`)}`;

export const iconGrid = (): TemplateResult => html`${wrap(svg`
  <rect x="3" y="3" width="6" height="6" rx="1"/>
  <rect x="15" y="3" width="6" height="6" rx="1"/>
  <rect x="3" y="15" width="6" height="6" rx="1"/>
  <rect x="15" y="15" width="6" height="6" rx="1"/>
  <rect x="9" y="9" width="6" height="6" rx="1"/>
`)}`;

export const iconSettings = (): TemplateResult => html`${wrap(svg`
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
`)}`;

export const iconFullscreen = (): TemplateResult => html`${wrap(svg`
  <polyline points="4 9 4 4 9 4"/>
  <polyline points="20 9 20 4 15 4"/>
  <polyline points="4 15 4 20 9 20"/>
  <polyline points="20 15 20 20 15 20"/>
`)}`;
export const iconFullscreenExit = (): TemplateResult => html`${wrap(svg`
  <polyline points="9 4 9 9 4 9"/>
  <polyline points="15 4 15 9 20 9"/>
  <polyline points="9 20 9 15 4 15"/>
  <polyline points="15 20 15 15 20 15"/>
`)}`;

export const iconPip = (): TemplateResult => html`${wrap(svg`
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/>
`)}`;

export const iconCheck = (): TemplateResult => html`${wrap(svg`<polyline points="5 12 10 17 19 7"/>`)}`;

export const iconInfo = (): TemplateResult => html`${wrap(svg`
  <circle cx="12" cy="12" r="9"/>
  <line x1="12" y1="11" x2="12" y2="17"/>
  <circle cx="12" cy="8" r="0.6" fill="currentColor"/>
`)}`;

export const iconBug = (): TemplateResult => html`${wrap(svg`
  <path d="M9 6V4a3 3 0 0 1 6 0v2"/>
  <rect x="6" y="6" width="12" height="13" rx="6"/>
  <line x1="12" y1="10" x2="12" y2="19"/>
  <line x1="3" y1="11" x2="6" y2="11"/>
  <line x1="18" y1="11" x2="21" y2="11"/>
  <line x1="3" y1="17" x2="6" y2="16"/>
  <line x1="18" y1="16" x2="21" y2="17"/>
`)}`;
