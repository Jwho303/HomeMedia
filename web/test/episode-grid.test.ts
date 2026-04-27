import { describe, it, expect } from 'vitest';
import '../src/components/episode-grid.js';
import {
  EpisodeGrid,
  tileState,
  progressRatio,
} from '../src/components/episode-grid.js';
import type { Episode, SeriesDetail } from '../src/types.js';

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 1,
    path: 'show/S1E1.mkv',
    season: 1,
    episode: 1,
    title: 'Pilot',
    overview: null,
    stillUrl: null,
    runtimeSeconds: 1800,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    ...overrides,
  };
}

function detail(eps: Episode[]): SeriesDetail {
  return {
    series: {
      id: 42,
      path: 'show',
      type: 'series',
      tmdbId: null,
      title: 'My Show',
      year: 2024,
      posterUrl: null,
      backdropUrl: null,
      overview: null,
      genres: [],
      runtimeSeconds: null,
      position: 0,
      duration: 0,
      watched: false,
      watchedAt: null,
      addedAt: 0,
      lastPlayedAt: null,
    },
    episodes: eps,
  };
}

describe('episode-grid pure helpers', () => {
  it('tileState marks current/watched/unwatched correctly', () => {
    const a = ep({ path: 'a', episode: 1, watched: true });
    const b = ep({ path: 'b', episode: 2, watched: false });
    const c = ep({ path: 'c', episode: 3, watched: false });
    expect(tileState(a, 'b')).toBe('watched');
    expect(tileState(b, 'b')).toBe('current');
    expect(tileState(c, 'b')).toBe('unwatched');
    // Current episode wins over watched.
    const d = ep({ path: 'd', episode: 4, watched: true });
    expect(tileState(d, 'd')).toBe('current');
  });

  it('progressRatio clamps to [0, 0.9] and handles zero duration', () => {
    expect(progressRatio(ep({ duration: 0, position: 100 }))).toBe(0);
    expect(progressRatio(ep({ duration: 100, position: -5 }))).toBe(0);
    expect(progressRatio(ep({ duration: 100, position: 50 }))).toBeCloseTo(0.5);
    expect(progressRatio(ep({ duration: 100, position: 99 }))).toBe(0.9);
  });
});

describe('<episode-grid>', () => {
  it('renders one tile per episode in the current season', async () => {
    const eps = [
      ep({ id: 1, path: 'a', episode: 1, watched: true }),
      ep({ id: 2, path: 'b', episode: 2 }),
      ep({ id: 3, path: 'c', episode: 3 }),
      ep({ id: 4, path: 'd', episode: 1, season: 2 }),
    ];
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = detail(eps);
    grid.currentPath = 'b';
    document.body.appendChild(grid);
    await grid.updateComplete;
    const tiles = grid.shadowRoot!.querySelectorAll('.tile');
    // Only season 1 (3 episodes), excluding the season-2 entry.
    expect(tiles.length).toBe(3);
    document.body.removeChild(grid);
  });

  it('marks the current tile with the .current class', async () => {
    const eps = [
      ep({ id: 1, path: 'a', episode: 1 }),
      ep({ id: 2, path: 'b', episode: 2 }),
    ];
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = detail(eps);
    grid.currentPath = 'b';
    document.body.appendChild(grid);
    await grid.updateComplete;
    const tiles = Array.from(grid.shadowRoot!.querySelectorAll('.tile')) as HTMLElement[];
    expect(tiles[0]!.className).toContain('unwatched');
    expect(tiles[1]!.className).toContain('current');
    document.body.removeChild(grid);
  });

  it('dispatches `episode-selected` with the path on tile click', async () => {
    const eps = [ep({ id: 1, path: 'a', episode: 1 })];
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = detail(eps);
    grid.currentPath = 'a';
    document.body.appendChild(grid);
    await grid.updateComplete;
    let received: string | null = null;
    grid.addEventListener('episode-selected', (e) => {
      received = (e as CustomEvent<{ path: string }>).detail.path;
    });
    const tile = grid.shadowRoot!.querySelector('.tile') as HTMLElement;
    tile.click();
    expect(received).toBe('a');
    document.body.removeChild(grid);
  });

  it('dispatches `view-all-episodes` with seriesId on footer click', async () => {
    const eps = [ep({ id: 1, path: 'a', episode: 1 })];
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = detail(eps);
    grid.currentPath = 'a';
    document.body.appendChild(grid);
    await grid.updateComplete;
    let received: number | null = null;
    grid.addEventListener('view-all-episodes', (e) => {
      received = (e as CustomEvent<{ seriesId: number }>).detail.seriesId;
    });
    const footerBtn = grid.shadowRoot!.querySelector('.footer button') as HTMLElement;
    footerBtn.click();
    expect(received).toBe(42);
    document.body.removeChild(grid);
  });

  it('scrollToCurrent sets the scroll container to centre the current tile', async () => {
    const eps = Array.from({ length: 30 }, (_, i) =>
      ep({ id: i + 1, path: `e${i + 1}`, episode: i + 1 }),
    );
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = detail(eps);
    grid.currentPath = 'e20';
    document.body.appendChild(grid);
    await grid.updateComplete;
    const scroller = grid.shadowRoot!.querySelector('.scroll') as HTMLElement;
    // Force layout dimensions so the math has something to work with — happy-dom
    // doesn't run real layout.
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    const currentTile = grid.shadowRoot!.querySelector('.tile.current') as HTMLElement;
    Object.defineProperty(currentTile, 'offsetTop', { value: 800, configurable: true });
    Object.defineProperty(currentTile, 'offsetHeight', { value: 100, configurable: true });
    let scrolledTo: number | null = null;
    scroller.scrollTo = ((opts: ScrollToOptions): void => {
      scrolledTo = opts.top ?? null;
    }) as typeof scroller.scrollTo;
    grid.scrollToCurrent({ instant: true });
    // tileMid (800 + 50) - clientHeight/2 (100) = 750
    expect(scrolledTo).toBe(750);
    document.body.removeChild(grid);
  });

  it('renders a "no episodes" placeholder when detail is null', async () => {
    const grid = document.createElement('episode-grid') as EpisodeGrid;
    grid.detail = null;
    document.body.appendChild(grid);
    await grid.updateComplete;
    expect(grid.shadowRoot!.textContent).toContain('No episodes');
    document.body.removeChild(grid);
  });
});
