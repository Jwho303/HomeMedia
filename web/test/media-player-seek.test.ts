import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/components/media-player.js';
import { MediaPlayer } from '../src/components/media-player.js';

// hls.js doesn't run under happy-dom (no MSE), and the attach path would set
// `this.error = 'Your browser does not support HLS playback.'`, replacing the
// <video> element with the error div before tests can introspect it. Stub the
// module to a no-op that satisfies isSupported() and the attach surface.
vi.mock('hls.js', () => {
  class HlsStub {
    static isSupported(): boolean { return true; }
    on(): void { /* no-op */ }
    loadSource(): void { /* no-op */ }
    attachMedia(): void { /* no-op */ }
    destroy(): void { /* no-op */ }
  }
  return { default: HlsStub };
});

/**
 * HLS seek-math regression tests (0.1.7).
 *
 * Background: an HLS session encodes from `?start=streamOffset`, so the
 * playlist's segments are *stream-local* (t=0 = source-second `streamOffset`).
 * The player's `<video>.currentTime` therefore tracks stream-local time,
 * not absolute time. Seek handlers must subtract `streamOffset` when
 * setting `v.currentTime` for HLS (and respawn when the absolute target
 * lies outside the encoded window).
 *
 * The bug these tests guard against: previously `isInPlaceSeekMode()`
 * returned true for HLS, which meant scrub commits set `v.currentTime` to
 * the absolute target, landing past EOF of the local playlist and
 * silently failing the seek.
 */

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Internals {
  playMode: 'direct' | 'remux' | 'nvenc' | 'hls' | 'external' | 'pre-probe';
  streamOffset: number;
  pendingSeek: number | null;
  currentTime: number;
  duration: number;
  seeking: boolean;
  onScrubCommit: (e: Event) => void;
  onChapterClick: (chapter: { startSeconds: number }) => void;
  isInPlaceSeekMode: () => boolean;
}

describe('media-player HLS seek math (0.1.7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    if (typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', '/');
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      // Phase 4: HLS is the only path; the player bootstraps via /api/stream-meta
      // and then preflights /api/hls/master.m3u8 to capture the session id header.
      if (u.startsWith('/api/stream-meta/')) {
        return mockJson({
          relPath: 'X.mp4', absPath: '/m/X.mp4',
          container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
          durationSeconds: 0, audioStreams: [], subStreams: [], chapters: [], subs: [],
        });
      }
      if (u.startsWith('/api/hls/')) {
        return new Response('#EXTM3U\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'x-hls-session-id': 'test-session' },
        });
      }
      if (u.startsWith('/api/library')) return mockJson({ movies: [], series: [] });
      if (u.startsWith('/api/series')) return mockJson({ series: { id: 0, episodes: [] }, episodes: [] });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      if (u.startsWith('/api/client-log')) return mockJson({}, 200);
      throw new Error(`unexpected ${u}`);
    });
  });

  async function mount(): Promise<MediaPlayer> {
    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'X.mp4';
    document.body.appendChild(player);
    // The HLS bootstrap awaits Promise.all([apiStreamMeta, apiPlaybackGet])
    // before flipping `probing` off, so we need to drain microtasks twice
    // after the macrotask flush for the probe to materialize and the
    // <video> element to appear in the shadow DOM.
    await player.updateComplete;
    await flush();
    await player.updateComplete;
    await flush();
    await player.updateComplete;
    return player;
  }

  /** Synthesize a TimeRanges-shaped object with one buffered range. */
  function makeBuffered(start: number, end: number): TimeRanges {
    return {
      length: 1,
      start: (i: number) => (i === 0 ? start : 0),
      end: (i: number) => (i === 0 ? end : 0),
    } as TimeRanges;
  }

  it('isInPlaceSeekMode is true ONLY for direct mode', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'direct';
    expect(inner.isInPlaceSeekMode()).toBe(true);
    inner.playMode = 'hls';
    expect(inner.isInPlaceSeekMode()).toBe(false);
    inner.playMode = 'remux';
    expect(inner.isInPlaceSeekMode()).toBe(false);
    inner.playMode = 'nvenc';
    expect(inner.isInPlaceSeekMode()).toBe(false);
    document.body.removeChild(p);
  });

  it('HLS in-buffer scrub commit sets v.currentTime to t - streamOffset', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'hls';
    inner.streamOffset = 600; // ffmpeg started at 600s
    inner.duration = 3000;

    const v = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    // Stub buffered to cover [0, 30] in stream-local coords (i.e. abs 600..630).
    Object.defineProperty(v, 'buffered', { get: () => makeBuffered(0, 30), configurable: true });
    let setLocal = -1;
    Object.defineProperty(v, 'currentTime', {
      get: () => 0,
      set: (val: number) => { setLocal = val; },
      configurable: true,
    });

    // Seek to abs t=620 (in buffer). Should set v.currentTime = 620 - 600 = 20.
    const ev = { target: { value: '620' } } as unknown as Event;
    inner.onScrubCommit(ev);

    expect(setLocal).toBe(20);
    expect(inner.currentTime).toBe(620);
    expect(inner.pendingSeek).toBeNull();
    document.body.removeChild(p);
  });

  it('HLS out-of-buffer scrub commit triggers respawn (streamOffset bumped)', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'hls';
    inner.streamOffset = 600;
    inner.duration = 3000;

    const v = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    // Buffer covers [0, 30] in local (600..630 abs). Seeking to abs 1500 → respawn.
    Object.defineProperty(v, 'buffered', { get: () => makeBuffered(0, 30), configurable: true });

    const ev = { target: { value: '1500' } } as unknown as Event;
    inner.onScrubCommit(ev);

    expect(inner.streamOffset).toBe(1500);
    expect(inner.pendingSeek).toBe(1500);
    expect(inner.currentTime).toBe(1500);
    expect(inner.seeking).toBe(true);
    document.body.removeChild(p);
  });

  it('direct mode in-buffer scrub uses absolute currentTime (no streamOffset subtraction)', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'direct';
    inner.streamOffset = 0;
    inner.duration = 3000;

    const v = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(v, 'buffered', { get: () => makeBuffered(0, 1000), configurable: true });
    let setVal = -1;
    Object.defineProperty(v, 'currentTime', {
      get: () => 0,
      set: (val: number) => { setVal = val; },
      configurable: true,
    });

    const ev = { target: { value: '500' } } as unknown as Event;
    inner.onScrubCommit(ev);

    expect(setVal).toBe(500); // absolute, not 500 - 0
    document.body.removeChild(p);
  });

  it('chapter click in HLS out-of-buffer triggers respawn', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'hls';
    inner.streamOffset = 100;
    inner.duration = 3000;

    const v = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(v, 'buffered', { get: () => makeBuffered(0, 30), configurable: true });

    inner.onChapterClick({ startSeconds: 1800 });

    expect(inner.streamOffset).toBe(1800);
    expect(inner.pendingSeek).toBe(1800);
    expect(inner.seeking).toBe(true);
    document.body.removeChild(p);
  });

  it('chapter click in HLS in-buffer subtracts streamOffset', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.playMode = 'hls';
    inner.streamOffset = 100;
    inner.duration = 3000;

    const v = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(v, 'buffered', { get: () => makeBuffered(0, 200), configurable: true });
    let setLocal = -1;
    Object.defineProperty(v, 'currentTime', {
      get: () => 0,
      set: (val: number) => { setLocal = val; },
      configurable: true,
    });

    inner.onChapterClick({ startSeconds: 250 });

    expect(setLocal).toBe(150); // 250 - 100
    expect(inner.currentTime).toBe(250);
    document.body.removeChild(p);
  });
});
