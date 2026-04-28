import { describe, it, expect } from 'vitest';
import {
  SeriesDetailView,
  cacheLibrary,
  findCachedSeriesItemByEpisodePath,
} from '../src/components/series-detail.js';
import type { Episode, Library, LibraryItem } from '../src/types.js';

function libraryItem(overrides: Partial<LibraryItem>): LibraryItem {
  return {
    id: 0,
    path: '',
    type: 'series',
    tmdbId: null,
    title: null,
    year: null,
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
    imdbRating: null,
    imdbVotes: null,
    ...overrides,
  };
}

function ep(season: number, episode: number, opts: Partial<Episode> = {}): Episode {
  return {
    id: season * 100 + episode,
    path: `Show/S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`,
    season,
    episode,
    title: `Ep ${season}.${episode}`,
    overview: null,
    stillUrl: null,
    runtimeSeconds: null,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    ...opts,
  };
}

describe('SeriesDetailView.groupBySeason', () => {
  it('groups by season ascending and preserves episode order within a season', () => {
    const groups = SeriesDetailView.groupBySeason([
      ep(2, 1),
      ep(1, 1),
      ep(1, 2),
      ep(2, 2),
    ]);
    expect(groups.map((g) => g.season)).toEqual([1, 2]);
    expect(groups[0]!.eps.map((e) => e.episode)).toEqual([1, 2]);
    expect(groups[1]!.eps.map((e) => e.episode)).toEqual([1, 2]);
  });

  it('returns [] for empty input', () => {
    expect(SeriesDetailView.groupBySeason([])).toEqual([]);
  });
});

describe('SeriesDetailView.computeCurrentSeason', () => {
  it('with watched/in-progress/unstarted seasons, picks the in-progress one', () => {
    const groups = [
      { season: 1, eps: [ep(1, 1, { watched: true }), ep(1, 2, { watched: true })] },
      { season: 2, eps: [ep(2, 1, { watched: true }), ep(2, 2, { position: 600, duration: 1500 })] },
      { season: 3, eps: [ep(3, 1), ep(3, 2)] },
    ];
    expect(SeriesDetailView.computeCurrentSeason(groups)).toBe(2);
  });

  it('falls back to the first season when every season is fully watched', () => {
    const groups = [
      { season: 1, eps: [ep(1, 1, { watched: true })] },
      { season: 2, eps: [ep(2, 1, { watched: true })] },
    ];
    expect(SeriesDetailView.computeCurrentSeason(groups)).toBe(1);
  });

  it('returns 1 for empty groups', () => {
    expect(SeriesDetailView.computeCurrentSeason([])).toBe(1);
  });

  it('picks the first season with anything not-yet-watched if none in progress', () => {
    const groups = [
      { season: 1, eps: [ep(1, 1, { watched: true }), ep(1, 2, { watched: true })] },
      { season: 2, eps: [ep(2, 1), ep(2, 2)] },
    ];
    expect(SeriesDetailView.computeCurrentSeason(groups)).toBe(2);
  });
});

describe('findCachedSeriesItemByEpisodePath', () => {
  it('matches by directory prefix and ignores movies', () => {
    const lib: Library = {
      movies: [libraryItem({ id: 1, type: 'movie', path: 'Movies/Foo.mkv', title: 'Foo' })],
      series: [
        libraryItem({ id: 10, type: 'series', path: 'Shows/Cascadia', title: 'Cascadia' }),
        libraryItem({ id: 20, type: 'series', path: 'Shows/Other', title: 'Other' }),
      ],
    };
    cacheLibrary(lib);
    const hit = findCachedSeriesItemByEpisodePath('Shows/Cascadia/S01/E08.mkv');
    expect(hit?.id).toBe(10);
    expect(findCachedSeriesItemByEpisodePath('Movies/Foo.mkv')).toBe(null);
  });

  it('picks the longest matching prefix when one series path is a prefix of another', () => {
    cacheLibrary({
      movies: [],
      series: [
        libraryItem({ id: 30, type: 'series', path: 'Shows/Show', title: 'Show' }),
        libraryItem({ id: 31, type: 'series', path: 'Shows/Show 2', title: 'Show 2' }),
      ],
    });
    const hit = findCachedSeriesItemByEpisodePath('Shows/Show 2/S01E01.mkv');
    expect(hit?.id).toBe(31);
  });

  it('handles backslash-separated episode paths against forward-slash dirs', () => {
    cacheLibrary({
      movies: [],
      series: [libraryItem({ id: 40, type: 'series', path: 'Shows/Mixed', title: 'Mixed' })],
    });
    const hit = findCachedSeriesItemByEpisodePath('Shows\\Mixed\\S01\\E01.mkv');
    expect(hit?.id).toBe(40);
  });
});
