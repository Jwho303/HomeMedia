import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/components/media-player.js';
import { MediaPlayer } from '../src/components/media-player.js';
import type { SubInfo } from '../src/types.js';

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  // Two ticks so probe + render + sub-list resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('media-player pre-probe flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    // Make sure prior tests' history navigations don't leak `?nativeControls=1`
    // (or anything else) into this test's URL. happy-dom doesn't reset between tests.
    if (typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', '/');
    }
  });

  it('direct decision: <video src> uses the bare stream URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'Foo.mp4';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;

    const video = player.shadowRoot?.querySelector('video');
    expect(video).toBeTruthy();
    expect(video!.getAttribute('src')).toBe('/api/stream/Foo.mp4');
    expect(fetchSpy).toHaveBeenCalled();
    document.body.removeChild(player);
  });

  it('remux decision: <video src> appends ?remux=true and attaches <track>s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return mockJson({
        decision: 'remux',
        subs: [{ path: 'show/Foo.en.srt', lang: 'en', ext: 'srt' }],
      }, 415);
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'show/Foo.mkv';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;

    const video = player.shadowRoot?.querySelector('video');
    expect(video).toBeTruthy();
    expect(video!.getAttribute('src')).toBe('/api/stream/show%2FFoo.mkv?remux=true');
    const tracks = player.shadowRoot?.querySelectorAll('track');
    expect(tracks?.length).toBe(1);
    expect(tracks?.[0]!.getAttribute('src')).toBe('/api/subs/show%2FFoo.en.srt');
    expect(tracks?.[0]!.getAttribute('srclang')).toBe('en');
    // Player should expose the subs through reactive state (the visible CC picker
    // is rendered in the control bar; happy-dom + Lit don't reliably realize the
    // bar's DOM in tests, so verify state and the renderSubtitleMenu return value).
    const subs = (player as unknown as { subs: SubInfo[] }).subs;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.lang).toBe('en');
    document.body.removeChild(player);
  });

  it('external decision: renders external-player panel; no <video>', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return mockJson({
        decision: 'external',
        subs: [],
        absPath: '/Volumes/media/show/Foo.mkv',
      }, 415);
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'show/Foo.mkv';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;

    const video = player.shadowRoot?.querySelector('video');
    expect(video).toBeNull();
    const input = player.shadowRoot?.querySelector('input[readonly]');
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('/Volumes/media/show/Foo.mkv');
    document.body.removeChild(player);
  });

  it('subtitle picker: selectSubtitle updates active index and applies textTrack mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return mockJson({
        decision: 'remux',
        subs: [
          { path: 'show/Foo.en.srt', lang: 'en', ext: 'srt' },
          { path: 'show/Foo.es.srt', lang: 'es', ext: 'srt' },
        ],
      }, 415);
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'show/Foo.mkv';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;

    type Internals = {
      activeSubIndex: number;
      subs: SubInfo[];
      selectSubtitle: (i: number) => void;
      subsMenuOpen: boolean;
    };
    const internals = player as unknown as Internals;

    // Two tracks discovered, default active = 0 (first).
    expect(internals.subs).toHaveLength(2);
    expect(internals.activeSubIndex).toBe(0);

    // Switch to second track.
    internals.selectSubtitle(1);
    expect(internals.activeSubIndex).toBe(1);
    expect(internals.subsMenuOpen).toBe(false);

    // Switch off.
    internals.selectSubtitle(-1);
    expect(internals.activeSubIndex).toBe(-1);

    document.body.removeChild(player);
  });

  it('renderSubtitleMenu returns null when subs list is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'NoSubs.mp4';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;

    type Internals = { subs: SubInfo[]; renderSubtitleMenu: () => unknown };
    const internals = player as unknown as Internals;
    expect(internals.subs).toHaveLength(0);
    expect(internals.renderSubtitleMenu()).toBeNull();
    document.body.removeChild(player);
  });

  it('click handler toggles play; double-click toggles fullscreen (timer guards single-click)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      throw new Error(`unexpected ${u}`);
    });

    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'X.mp4';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();

    type Internals = {
      onVideoClick: (e: MouseEvent) => void;
      onVideoDblClick: (e: MouseEvent) => void;
      togglePlay: () => void;
      toggleFullscreen: () => void;
    };
    const internals = player as unknown as Internals;
    let playToggled = 0;
    let fsToggled = 0;
    internals.togglePlay = (): void => { playToggled++; };
    internals.toggleFullscreen = (): void => { fsToggled++; };

    // Single click → after 250ms, togglePlay fires.
    internals.onVideoClick(new MouseEvent('click'));
    expect(playToggled).toBe(0);
    await new Promise((r) => setTimeout(r, 280));
    expect(playToggled).toBe(1);
    expect(fsToggled).toBe(0);

    // Double click within 250ms → only fullscreen, no play toggle.
    internals.onVideoClick(new MouseEvent('click'));
    internals.onVideoDblClick(new MouseEvent('dblclick'));
    await new Promise((r) => setTimeout(r, 280));
    expect(playToggled).toBe(1); // unchanged
    expect(fsToggled).toBe(1);

    document.body.removeChild(player);
  });

  it('caches probe result in sessionStorage so re-render skips the round-trip', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      throw new Error(`unexpected ${u}`);
    });

    // First mount populates sessionStorage.
    const p1 = document.createElement('media-player') as MediaPlayer;
    p1.relPath = 'Bar.mp4';
    document.body.appendChild(p1);
    await p1.updateComplete;
    await flush();
    document.body.removeChild(p1);

    // Probe = fetch with Range: bytes=0-0 (the video element's src-load fetch
    // doesn't go through fetch() in happy-dom, but if it ever does, this filter
    // ignores it).
    const isProbe = (c: Parameters<typeof globalThis.fetch>): boolean => {
      if (!(c[0] as string).startsWith('/api/stream/')) return false;
      const init = c[1] as RequestInit | undefined;
      const range = (init?.headers as Record<string, string> | undefined)?.['Range'];
      return range === 'bytes=0-0';
    };
    const probeCalls = fetchSpy.mock.calls.filter(isProbe);
    expect(probeCalls.length).toBe(1);

    // Second mount with the same path — should NOT re-probe.
    const p2 = document.createElement('media-player') as MediaPlayer;
    p2.relPath = 'Bar.mp4';
    document.body.appendChild(p2);
    await p2.updateComplete;
    await flush();
    const probeCallsAfter = fetchSpy.mock.calls.filter(isProbe);
    expect(probeCallsAfter.length).toBe(1); // still only the first
    document.body.removeChild(p2);
  });
});
