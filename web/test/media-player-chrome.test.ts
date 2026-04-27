import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/components/media-player.js';
import {
  MediaPlayer,
  titleFromPath,
  formatSeasonEpisode,
} from '../src/components/media-player.js';

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

interface Internals {
  chromeIdle: boolean;
  paused: boolean;
  openPopover: 'cc' | 'audio' | 'settings' | 'grid' | null;
  toggleNamedPopover: (k: 'cc' | 'audio' | 'settings' | 'grid') => void;
  kickIdleTimer: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  isFullscreen: boolean;
  muted: boolean;
  volume: number;
  toggleMute: () => void;
  onLoadedMetadata: () => void;
  onVolume: (e: Event) => void;
}

describe('media-player chrome / popover state', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    if (typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', '/');
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = url as string;
      if (u.startsWith('/api/playback/')) return mockJson({ position: 0, duration: 0, watched: false });
      if (u.startsWith('/api/stream/')) return new Response('x', { status: 206 });
      if (u.startsWith('/api/subs-list/')) return mockJson({ subs: [] });
      throw new Error(`unexpected ${u}`);
    });
  });

  async function mount(): Promise<MediaPlayer> {
    const player = document.createElement('media-player') as MediaPlayer;
    player.relPath = 'X.mp4';
    document.body.appendChild(player);
    await player.updateComplete;
    await flush();
    await player.updateComplete;
    return player;
  }

  it('idle timer starts disarmed when paused', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    // We're paused on mount (no autoplay in happy-dom). Calling kickIdleTimer
    // should NOT schedule the idle flip.
    inner.kickIdleTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(inner.chromeIdle).toBe(false);
    document.body.removeChild(p);
  });

  it('opening a popover holds the chrome visible', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.toggleNamedPopover('cc');
    expect(inner.openPopover).toBe('cc');
    inner.kickIdleTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(inner.chromeIdle).toBe(false);
    document.body.removeChild(p);
  });

  it('only one popover open at a time — opening a second key replaces it', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.toggleNamedPopover('cc');
    expect(inner.openPopover).toBe('cc');
    inner.toggleNamedPopover('settings');
    expect(inner.openPopover).toBe('settings');
    inner.toggleNamedPopover('settings'); // toggle off
    expect(inner.openPopover).toBe(null);
    document.body.removeChild(p);
  });

  it('Escape closes an open popover (priority over fullscreen)', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    inner.toggleNamedPopover('grid');
    expect(inner.openPopover).toBe('grid');
    inner.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inner.openPopover).toBe(null);
    document.body.removeChild(p);
  });

  it('Escape with no popover and no fullscreen is a no-op', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    expect(inner.openPopover).toBe(null);
    inner.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inner.openPopover).toBe(null);
    document.body.removeChild(p);
  });

  it('mute state survives a relPath change and is re-applied to the new <video>', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    // User mutes the current episode.
    inner.toggleMute();
    expect(inner.muted).toBe(true);
    const v1 = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    expect(v1.muted).toBe(true);

    // Switch to next episode (same component, new src + remounted <video>).
    p.relPath = 'Y.mp4';
    await p.updateComplete;
    await flush();
    await p.updateComplete;

    // Reactive state is preserved.
    expect(inner.muted).toBe(true);

    // The new <video> element should also reflect the mute, after loadedmetadata
    // (we fire it manually because happy-dom doesn't decode media).
    const v2 = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    inner.onLoadedMetadata();
    expect(v2.muted).toBe(true);
    document.body.removeChild(p);
  });

  it('volume level survives a relPath change and is re-applied to the new <video>', async () => {
    const p = await mount();
    const inner = p as unknown as Internals;
    // Drive onVolume directly — the slider DOM lives behind a hover-expanding
    // wrap that happy-dom can't reliably surface.
    const fakeInput = { value: '0.3' } as HTMLInputElement;
    inner.onVolume({ target: fakeInput } as unknown as Event);
    expect(inner.volume).toBeCloseTo(0.3);
    const v1 = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    expect(v1.volume).toBeCloseTo(0.3);

    p.relPath = 'Z.mp4';
    await p.updateComplete;
    await flush();
    await p.updateComplete;

    expect(inner.volume).toBeCloseTo(0.3);
    const v2 = p.shadowRoot!.querySelector('video') as HTMLVideoElement;
    inner.onLoadedMetadata();
    expect(v2.volume).toBeCloseTo(0.3);
    document.body.removeChild(p);
  });
});

describe('title formatting helpers', () => {
  it('titleFromPath strips directories and extension', () => {
    expect(titleFromPath('Foo.mp4')).toBe('Foo');
    expect(titleFromPath('show/Foo.Bar.S01E01.mkv')).toBe('Foo.Bar.S01E01');
    expect(titleFromPath('a\\b\\c\\Movie (2020).mp4')).toBe('Movie (2020)');
    expect(titleFromPath('NoExtension')).toBe('NoExtension');
    expect(titleFromPath('.hidden')).toBe('.hidden');
  });

  it('formatSeasonEpisode zero-pads to two digits', () => {
    expect(formatSeasonEpisode(1, 1)).toBe('S01E01');
    expect(formatSeasonEpisode(2, 8)).toBe('S02E08');
    expect(formatSeasonEpisode(10, 12)).toBe('S10E12');
    expect(formatSeasonEpisode(0, 0)).toBe('S00E00');
  });
});
