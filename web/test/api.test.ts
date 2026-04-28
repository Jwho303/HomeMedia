import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiContinue,
  apiLibrary,
  apiManualIdentifyEpisode,
  apiManualIdentifyItem,
  apiManualIdentifySearch,
  apiPlaybackPost,
  apiSeries,
  apiShareStatus,
  apiSubsList,
  ShareOfflineError,
  subsUrl,
} from '../src/api.js';

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('apiLibrary fetches /api/library and returns JSON', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse({ movies: [], series: [] }));
    const lib = await apiLibrary();
    expect(fetchSpy).toHaveBeenCalledWith('/api/library', undefined);
    expect(lib).toEqual({ movies: [], series: [] });
  });

  it('apiLibrary({ includeStale: true }) appends the query', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse({ movies: [], series: [] }));
    await apiLibrary({ includeStale: true });
    expect(fetchSpy).toHaveBeenCalledWith('/api/library?includeStale=true', undefined);
  });

  it('throws ShareOfflineError on 503 with share_offline body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ error: 'share_offline' }, 503),
    );
    await expect(apiShareStatus()).rejects.toBeInstanceOf(ShareOfflineError);
  });

  it('apiPlaybackPost posts JSON body and returns playback', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse({ position: 5, duration: 100, watched: false }));
    const out = await apiPlaybackPost('Dune.mkv', { position: 5, duration: 100 });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/playback/Dune.mkv',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 5, duration: 100 }),
      }),
    );
    expect(out).toEqual({ position: 5, duration: 100, watched: false });
  });

  it('subsUrl encodes the path', () => {
    expect(subsUrl('A B/C.srt')).toBe('/api/subs/A%20B%2FC.srt');
  });

  it('apiSeries passes through inline playback + runtime fields (0.1.3.1)', async () => {
    const payload = {
      series: {
        id: 7, path: 'Cascadia', type: 'series', tmdbId: 100,
        title: 'Cascadia', year: 2024, posterUrl: null, backdropUrl: null, overview: null,
      },
      episodes: [
        {
          id: 1, path: 'Cascadia/S01E01.mkv', season: 1, episode: 1,
          title: 'Pilot', overview: null, stillUrl: null,
          runtimeSeconds: 3480, position: 1320, duration: 3000,
          watched: false, watchedAt: null,
        },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(payload));
    const detail = await apiSeries(7);
    expect(detail.episodes[0]!.runtimeSeconds).toBe(3480);
    expect(detail.episodes[0]!.position).toBe(1320);
    expect(detail.episodes[0]!.duration).toBe(3000);
    expect(detail.episodes[0]!.watched).toBe(false);
    expect(detail.episodes[0]!.watchedAt).toBeNull();
  });

  it('apiContinue unwraps the items array (0.1.3.2)', async () => {
    const payload = {
      items: [
        {
          type: 'series', itemId: 7, title: 'Show', posterUrl: null,
          resumePath: 'Show/S02E04.mkv', position: 600, duration: 1500,
          runtimeSeconds: 1500, resumeLabel: 'S2 · E4', lastPlayedAt: 10_000,
        },
      ],
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const out = await apiContinue();
    expect(fetchSpy).toHaveBeenCalledWith('/api/continue', undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Show');
    expect(out[0]!.resumeLabel).toBe('S2 · E4');
  });

  it('apiLibrary passes through home-screen fields (0.1.3.2)', async () => {
    const payload = {
      movies: [{
        id: 1, path: 'D.mkv', type: 'movie', tmdbId: 1, title: 'D', year: 2024,
        posterUrl: null, backdropUrl: null, overview: null,
        genres: ['Sci-Fi'], runtimeSeconds: 9000,
        position: 100, duration: 9000, watched: false, watchedAt: null,
        addedAt: 1_700_000_000_000, lastPlayedAt: 1_700_001_000_000,
      }],
      series: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const lib = await apiLibrary();
    expect(lib.movies[0]!.genres).toEqual(['Sci-Fi']);
    expect(lib.movies[0]!.runtimeSeconds).toBe(9000);
    expect(lib.movies[0]!.position).toBe(100);
    expect(lib.movies[0]!.addedAt).toBe(1_700_000_000_000);
  });

  it('apiSubsList returns the subs array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ subs: [{ path: 'a.srt', lang: null, ext: 'srt' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const subs = await apiSubsList('a.mkv');
    expect(subs).toHaveLength(1);
  });

  it('apiManualIdentifySearch builds the query and unwraps `candidates`', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ candidates: [{ tmdbId: 1, title: 'X', year: 2020, type: 'movie', overview: null, posterUrl: null, score: 0.9, sources: ['tmdb'], imdbId: null, tvdbId: null }] }),
    );
    const cs = await apiManualIdentifySearch('The Bear', { type: 'series' });
    expect(cs).toHaveLength(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('/api/manual-identify/search?');
    expect(url).toContain('q=The+Bear');
    expect(url).toContain('type=series');
  });

  it('apiManualIdentifySearch passes the AbortSignal through', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ candidates: [] }),
    );
    const aborter = new AbortController();
    await apiManualIdentifySearch('foo', { signal: aborter.signal });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(aborter.signal);
  });

  it('apiManualIdentifySearch throws ShareOfflineError on 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ error: 'share_offline' }, 503),
    );
    await expect(apiManualIdentifySearch('foo')).rejects.toBeInstanceOf(ShareOfflineError);
  });

  it('apiManualIdentifyItem POSTs JSON body to /api/manual-identify/item/:id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ item: { id: 7 } }),
    );
    const r = await apiManualIdentifyItem(7, { tmdbId: 42, type: 'movie' });
    expect(r.item).toEqual({ id: 7 });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/manual-identify/item/7',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: 42, type: 'movie' }),
      }),
    );
  });

  it('apiManualIdentifyEpisode POSTs JSON body to /api/manual-identify/episode/:id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse({ episode: { id: 5 }, item: null }),
    );
    const r = await apiManualIdentifyEpisode(5, { tmdbId: 136315, type: 'series', seInput: 'S04E01' });
    expect(r.episode).toEqual({ id: 5 });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/manual-identify/episode/5',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tmdbId: 136315, type: 'series', seInput: 'S04E01' }),
      }),
    );
  });
});
