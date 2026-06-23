import { describe, it, expect, afterEach } from 'vitest';
import '../src/components/poster-strip.js';
import '../src/components/season-strip.js';
import type { PosterStrip } from '../src/components/poster-strip.js';
import type { SeasonStrip } from '../src/components/season-strip.js';
import type { Episode } from '../src/types.js';
import type { HomeCardItem } from '../src/components/home-chunks.js';

function card(overrides: Partial<HomeCardItem> = {}): HomeCardItem {
  return {
    id: 1,
    type: 'movie',
    title: 'Wrong Movie',
    posterUrl: null,
    href: '#/play/Wrong.mkv',
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    runtimeSeconds: null,
    year: 2010,
    genres: [],
    addedAt: 0,
    lastPlayedAt: null,
    imdbRating: null,
    ...overrides,
  };
}

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 5,
    path: 'TheBear/S01E99.mkv',
    season: 1,
    episode: 99,
    title: null,
    overview: null,
    absoluteNumber: null,
    stillUrl: null,
    runtimeSeconds: null,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    ...overrides,
  };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** <watched-button> renders its menu as a body-level portal (so card hover
 *  filters / transforms can't clip it). Locate menu items by querying body. */
function findPortalMenuItem(label: RegExp | string): HTMLButtonElement | null {
  const menus = document.body.querySelectorAll('[data-watched-button-menu] button');
  for (const m of menus) {
    const text = (m.textContent ?? '').trim();
    if (typeof label === 'string' ? text === label : label.test(text)) {
      return m as HTMLButtonElement;
    }
  }
  return null;
}

function clearPortalMenus(): void {
  document.body.querySelectorAll('[data-watched-button-menu]').forEach((m) => m.remove());
}

afterEach(() => {
  clearPortalMenus();
});

describe('<poster-strip> Identify manually kebab item', () => {
  it('opens the watched-button menu and clicking "Identify manually…" dispatches `manual-identify-item-request`', async () => {
    const strip = document.createElement('poster-strip') as PosterStrip;
    strip.heading = 'Movies';
    strip.items = [card({ id: 7, type: 'movie' })];
    document.body.appendChild(strip);
    await strip.updateComplete;

    // Open the watched-button kebab.
    const watchedBtn = strip.shadowRoot!.querySelector('watched-button')!;
    const innerBtn = (watchedBtn.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('.btn');
    expect(innerBtn).toBeTruthy();
    innerBtn!.click();
    await tick();

    const idBtn = findPortalMenuItem(/identify manually/i);
    expect(idBtn).toBeTruthy();

    let received: { id: number; type: string } | null = null;
    strip.addEventListener('manual-identify-item-request', (e) => {
      received = (e as CustomEvent<{ id: number; type: string }>).detail;
    });
    idBtn!.click();
    await tick();
    expect(received).toEqual({ id: 7, type: 'movie' });
    document.body.removeChild(strip);
  });

  it('"Re-probe" appears in the same menu and dispatches `reprobe-item-trigger`', async () => {
    const strip = document.createElement('poster-strip') as PosterStrip;
    strip.items = [card({ id: 11, type: 'movie' })];
    document.body.appendChild(strip);
    await strip.updateComplete;

    const watchedBtn = strip.shadowRoot!.querySelector('watched-button')!;
    (watchedBtn.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('.btn')!.click();
    await tick();

    const reBtn = findPortalMenuItem(/^re-probe$/i);
    expect(reBtn).toBeTruthy();
    let receivedId: number | null = null;
    strip.addEventListener('reprobe-item-trigger', (e) => {
      receivedId = (e as CustomEvent<{ id: number }>).detail.id;
    });
    reBtn!.click();
    await tick();
    expect(receivedId).toBe(11);
    document.body.removeChild(strip);
  });

  it('extra items are disabled while a job is active', async () => {
    const strip = document.createElement('poster-strip') as PosterStrip;
    strip.items = [card({ id: 1 })];
    strip.jobActive = true;
    document.body.appendChild(strip);
    await strip.updateComplete;
    const watchedBtn = strip.shadowRoot!.querySelector('watched-button')!;
    (watchedBtn.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('.btn')!.click();
    await tick();
    const idBtn = findPortalMenuItem(/identify manually/i)!;
    expect(idBtn.disabled).toBe(true);
    document.body.removeChild(strip);
  });

  it('Series tile dispatches type: "series" in the request payload', async () => {
    const strip = document.createElement('poster-strip') as PosterStrip;
    strip.items = [card({ id: 42, type: 'series', title: 'The Bear' })];
    document.body.appendChild(strip);
    await strip.updateComplete;
    const watchedBtn = strip.shadowRoot!.querySelector('watched-button')!;
    (watchedBtn.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('.btn')!.click();
    await tick();
    let received: { id: number; type: string } | null = null;
    strip.addEventListener('manual-identify-item-request', (e) => {
      received = (e as CustomEvent<{ id: number; type: string }>).detail;
    });
    findPortalMenuItem(/identify manually/i)!.click();
    await tick();
    expect(received).toEqual({ id: 42, type: 'series' });
    document.body.removeChild(strip);
  });
});

describe('<season-strip> Identify manually episode kebab item', () => {
  it('clicking "Identify manually…" in the watched-button menu dispatches `manual-identify-episode-request`', async () => {
    const strip = document.createElement('season-strip') as SeasonStrip;
    strip.seasonNumber = 1;
    const e1 = ep({ id: 100, episode: 1 });
    strip.episodes = [e1, ep({ id: 101, episode: 2 })];
    strip.isCurrent = true;
    document.body.appendChild(strip);
    await strip.updateComplete;
    await tick();

    // Each episode renders a watched-button.
    const watchedBtns = Array.from(
      strip.shadowRoot!.querySelectorAll('watched-button'),
    ) as HTMLElement[];
    expect(watchedBtns.length).toBe(2);

    // Open the first episode's menu.
    (watchedBtns[0]!.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>('.btn')!.click();
    await tick();

    let received: { id: number; episode: Episode } | null = null;
    strip.addEventListener('manual-identify-episode-request', (e) => {
      received = (e as CustomEvent<{ id: number; episode: Episode }>).detail;
    });
    const idBtn = findPortalMenuItem(/identify manually/i);
    expect(idBtn).toBeTruthy();
    idBtn!.click();
    await tick();
    expect(received).not.toBeNull();
    expect(received!.episode).toBeDefined();
    document.body.removeChild(strip);
  });
});
