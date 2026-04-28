import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlayerSession } from '../src/components/player-session.js';

// hls.js can't run in happy-dom (no MSE). Stub to keep the attach path sane.
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

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BUNDLE = {
  playerId: 'test-id',
  relPath: 'movie.mkv',
  reused: false,
  session: {
    sessionId: 'sess-1',
    playlistUrl: '/api/hls/sess-1/master.m3u8',
    encodedWindow: { from: 0, to: 30 },
    startSeconds: 0,
  },
  metadata: {
    durationSeconds: 1200,
    container: 'matroska,webm',
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioStreams: [],
    subStreams: [],
    chapters: [],
    siblingSubs: [],
    title: null,
    posterUrl: null,
    backdropUrl: null,
    imdbRating: null,
    manualOverride: false,
    activeAudioStreamIndex: null,
    activeBurnSubStreamIndex: null,
  },
  resume: { position: 0, duration: 0, watched: false },
};

function makeSession(): {
  session: PlayerSession;
  video: HTMLVideoElement;
  events: ReturnType<typeof captureEvents>;
} {
  const video = document.createElement('video');
  // happy-dom doesn't implement canPlayType — stub to falsy so we go down
  // the hls.js branch (which is mocked).
  // @ts-expect-error happy-dom missing API
  video.canPlayType = (): string => '';
  const events = captureEvents();
  const session = new PlayerSession({
    videoEl: video,
    events,
    playerId: 'test-id',
  });
  return { session, video, events };
}

function captureEvents(): {
  onState: (s: string) => void;
  onBundle: (b: unknown) => void;
  onEncodedWindow: (w: unknown, p: boolean) => void;
  onCapacity: (b: unknown) => void;
  onError: (m: string) => void;
  states: string[];
  encodedWindows: Array<{ from: number; to: number; paused: boolean }>;
  errors: string[];
  capacities: unknown[];
  bundles: unknown[];
} {
  const states: string[] = [];
  const encodedWindows: Array<{ from: number; to: number; paused: boolean }> = [];
  const errors: string[] = [];
  const capacities: unknown[] = [];
  const bundles: unknown[] = [];
  return {
    onState: (s) => { states.push(s); },
    onBundle: (b) => { bundles.push(b); },
    onEncodedWindow: (w, p) => {
      const win = w as { from: number; to: number };
      encodedWindows.push({ from: win.from, to: win.to, paused: p });
    },
    onCapacity: (b) => { capacities.push(b); },
    onError: (m) => { errors.push(m); },
    states,
    encodedWindows,
    errors,
    capacities,
    bundles,
  };
}

beforeEach(() => {
  // Each test installs its own fetch mock.
});

describe('PlayerSession', () => {
  it('open() POSTs /open and surfaces the bundle', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/open')) return mockJson(BUNDLE);
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { session, events } = makeSession();
    await session.open({ relPath: 'movie.mkv' });
    expect(events.bundles).toHaveLength(1);
    expect(events.encodedWindows[0]).toEqual({ from: 0, to: 30, paused: false });
    expect(session.getEncodedWindow()).toEqual({ from: 0, to: 30 });
    expect(events.states.includes('attaching')).toBe(true);
  });

  it('seek() with target inside encodedWindow sets v.currentTime', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/open')) return mockJson(BUNDLE);
      if (u.endsWith('/seek')) {
        return mockJson({
          sessionId: 'sess-1',
          playlistUrl: '/api/hls/sess-1/master.m3u8',
          encodedWindow: { from: 0, to: 30 },
          mode: 'reuse',
          action: { kind: 'set-current-time', localSeconds: 12 },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { session, video } = makeSession();
    await session.open({ relPath: 'movie.mkv' });
    await session.seek(12);
    expect(video.currentTime).toBe(12);
  });

  it('seek() with target outside encodedWindow triggers reattach', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/open')) return mockJson(BUNDLE);
      if (u.endsWith('/seek')) {
        return mockJson({
          sessionId: 'sess-2',
          playlistUrl: '/api/hls/sess-2/master.m3u8',
          encodedWindow: { from: 600, to: 600 },
          mode: 'respawn',
          action: { kind: 'reattach', pendingResumeAt: 0 },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { session, video } = makeSession();
    await session.open({ relPath: 'movie.mkv' });
    await session.seek(600);
    expect(session.getEncodedWindow()).toEqual({ from: 600, to: 600 });
    expect(video.currentTime).toBe(0); // local origin of new playlist
  });

  it('open() raises capacity error on 503', async () => {
    const capBody = {
      error: 'capacity_exceeded',
      kind: 'global',
      limit: 3,
      active: 3,
      retryAfterSeconds: null,
    };
    const fetchMock = vi.fn(async () => mockJson(capBody, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { session, events } = makeSession();
    await session.open({ relPath: 'movie.mkv' });
    expect(events.capacities).toHaveLength(1);
    expect(session.getState()).toBe('capacity');
  });
});
