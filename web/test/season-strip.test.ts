import { describe, it, expect } from 'vitest';
import {
  pickHero,
  partition,
  formatRuntime,
  formatStatus,
  pickBadgeRuntime,
  computePageCount,
  pageFromScroll,
  episodeLabel,
} from '../src/components/season-strip.js';
import type { Episode } from '../src/types.js';

function ep(
  num: number,
  opts: Partial<Episode> = {},
): Episode {
  return {
    id: num,
    path: `Show/S01E${String(num).padStart(2, '0')}.mkv`,
    season: 1,
    episode: num,
    title: `Ep ${num}`,
    overview: null,
    absoluteNumber: null,
    stillUrl: null,
    runtimeSeconds: null,
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    ...opts,
  };
}

describe('episodeLabel', () => {
  it('uses the per-season number, zero-padded to 2, when not absolute', () => {
    expect(episodeLabel({ episode: 7, absoluteNumber: null })).toBe('07');
    expect(episodeLabel({ episode: 12, absoluteNumber: null })).toBe('12');
  });

  it('prefers the absolute number, zero-padded to 3, when present', () => {
    // Naruto S2E1 is absolute 53 → shows "053", not "01".
    expect(episodeLabel({ episode: 1, absoluteNumber: 53 })).toBe('053');
    expect(episodeLabel({ episode: 62, absoluteNumber: 220 })).toBe('220');
  });
});

describe('pickHero', () => {
  it('returns null + allWatched for an empty array', () => {
    expect(pickHero([])).toEqual({ hero: null, mode: 'allWatched' });
  });

  it('all-unwatched → mode "next" pointing at the first episode', () => {
    const eps = [ep(1), ep(2), ep(3)];
    const got = pickHero(eps);
    expect(got.mode).toBe('next');
    expect(got.hero?.episode).toBe(1);
  });

  it('mixed with one in-progress → mode "resume" on that one', () => {
    const eps = [
      ep(1, { watched: true }),
      ep(2, { position: 600, duration: 1500 }),  // 0.4 → resume
      ep(3),
    ];
    const got = pickHero(eps);
    expect(got.mode).toBe('resume');
    expect(got.hero?.episode).toBe(2);
  });

  it('three in-progress → highest-numbered wins', () => {
    const eps = [
      ep(1, { position: 100, duration: 1500 }),
      ep(2, { position: 200, duration: 1500 }),
      ep(3, { position: 300, duration: 1500 }),
      ep(4),
    ];
    const got = pickHero(eps);
    expect(got.mode).toBe('resume');
    expect(got.hero?.episode).toBe(3);
  });

  it('an episode at 90%+ is NOT considered in-progress', () => {
    // Both E1 and E2 are above the 0.9 threshold and have been auto-marked watched.
    // E3 is unwatched → "next".
    const eps = [
      ep(1, { position: 1500, duration: 1500, watched: true }),
      ep(2, { position: 1400, duration: 1500, watched: true }),  // 0.93 above 0.9
      ep(3),
    ];
    const got = pickHero(eps);
    expect(got.mode).toBe('next');
    expect(got.hero?.episode).toBe(3);
  });

  it('a watched episode with leftover position never becomes resume', () => {
    const eps = [
      ep(1, { position: 600, duration: 1500, watched: true }),
      ep(2),
    ];
    const got = pickHero(eps);
    expect(got.mode).toBe('next');
    expect(got.hero?.episode).toBe(2);
  });

  it('all-watched → no hero, mode "allWatched"', () => {
    const eps = [
      ep(1, { watched: true }),
      ep(2, { watched: true }),
    ];
    expect(pickHero(eps)).toEqual({ hero: null, mode: 'allWatched' });
  });

  it('resume rule beats first-unwatched even when first ep is unwatched', () => {
    // S2 finale shipped: e1 watched, e2 mid-play, e3 unwatched. Hero must be e2.
    const eps = [
      ep(1, { watched: true }),
      ep(2, { position: 800, duration: 2000 }),
      ep(3),
    ];
    const got = pickHero(eps);
    expect(got.mode).toBe('resume');
    expect(got.hero?.episode).toBe(2);
  });
});

describe('partition', () => {
  it('null hero → empty before/after', () => {
    expect(partition([ep(1), ep(2)], null)).toEqual({ before: [], after: [] });
  });

  it('hero in the middle → before=[1], after=[3]', () => {
    const eps = [ep(1), ep(2), ep(3)];
    const got = partition(eps, eps[1]!);
    expect(got.before.map((e) => e.episode)).toEqual([1]);
    expect(got.after.map((e) => e.episode)).toEqual([3]);
  });

  it('hero at the start → before=[], after=[2,3]', () => {
    const eps = [ep(1), ep(2), ep(3)];
    const got = partition(eps, eps[0]!);
    expect(got.before).toEqual([]);
    expect(got.after.map((e) => e.episode)).toEqual([2, 3]);
  });

  it('hero at the end → before=[1,2], after=[]', () => {
    const eps = [ep(1), ep(2), ep(3)];
    const got = partition(eps, eps[2]!);
    expect(got.before.map((e) => e.episode)).toEqual([1, 2]);
    expect(got.after).toEqual([]);
  });
});

describe('formatRuntime', () => {
  it('returns null for null/zero/negative input', () => {
    expect(formatRuntime(null)).toBeNull();
    expect(formatRuntime(0)).toBeNull();
    expect(formatRuntime(-1)).toBeNull();
  });

  it('returns minutes for sub-hour runtimes', () => {
    expect(formatRuntime(58 * 60)).toBe('58m');
    expect(formatRuntime(30)).toBe('1m');         // rounds up to 1m floor
  });

  it('returns hours+minutes for ≥60-minute runtimes', () => {
    expect(formatRuntime(60 * 60)).toBe('1h');
    expect(formatRuntime(63 * 60)).toBe('1h 3m');
    expect(formatRuntime(150 * 60)).toBe('2h 30m');
  });
});

describe('formatStatus', () => {
  it('"Not started · 0 / N watched" when nothing watched', () => {
    expect(formatStatus([ep(1), ep(2), ep(3)])).toBe('Not started · 0 / 3 watched');
  });

  it('"In progress · M / N watched" when partial', () => {
    expect(
      formatStatus([
        ep(1, { watched: true }),
        ep(2, { watched: true }),
        ep(3),
      ]),
    ).toBe('In progress · 2 / 3 watched');
  });

  it('"Watched · N / N watched" when all watched', () => {
    expect(
      formatStatus([ep(1, { watched: true }), ep(2, { watched: true })]),
    ).toBe('Watched · 2 / 2 watched');
  });

  it('handles empty input', () => {
    expect(formatStatus([])).toBe('No episodes');
  });
});

describe('pickBadgeRuntime', () => {
  it('prefers live duration once played', () => {
    expect(
      pickBadgeRuntime(ep(1, { runtimeSeconds: 1800, duration: 1750 })),
    ).toBe(1750);
  });

  it('falls back to runtimeSeconds when never played', () => {
    expect(pickBadgeRuntime(ep(1, { runtimeSeconds: 1800 }))).toBe(1800);
  });

  it('returns null when neither is present', () => {
    expect(pickBadgeRuntime(ep(1))).toBeNull();
  });
});

describe('computePageCount', () => {
  it('returns 0 when content fits the viewport', () => {
    expect(computePageCount(800, 1000)).toBe(0);
    expect(computePageCount(800, 800)).toBe(0);
  });

  it('uses half-viewport steps so 2x scroll = ~3 dots', () => {
    // 2400 width, 800 viewport → extra=1600 → 1600/400 = 4 steps + 1 = 5 dots.
    expect(computePageCount(2400, 800)).toBe(5);
    // 1600 width, 800 viewport → extra=800 → 800/400 = 2 steps + 1 = 3 dots.
    expect(computePageCount(1600, 800)).toBe(3);
  });

  it('always reports at least 2 dots once any overflow exists', () => {
    expect(computePageCount(820, 800)).toBe(2);
  });

  it('caps at the supplied max so very long strips do not render 50 dots', () => {
    expect(computePageCount(20_000, 800, 16)).toBe(16);
  });

  it('handles zero clientWidth defensively', () => {
    expect(computePageCount(2400, 0)).toBe(0);
  });
});

describe('pageFromScroll', () => {
  it('maps scrollLeft to nearest half-viewport step', () => {
    expect(pageFromScroll(0, 800, 5)).toBe(0);
    expect(pageFromScroll(400, 800, 5)).toBe(1);   // half a viewport
    expect(pageFromScroll(800, 800, 5)).toBe(2);   // one full viewport
    expect(pageFromScroll(1200, 800, 5)).toBe(3);  // 1.5 viewports
    expect(pageFromScroll(1600, 800, 5)).toBe(4);
  });

  it('clamps to [0, pageCount-1]', () => {
    expect(pageFromScroll(-50, 800, 3)).toBe(0);
    expect(pageFromScroll(999_999, 800, 3)).toBe(2);
  });

  it('returns 0 when pageCount is 0 (no pager visible)', () => {
    expect(pageFromScroll(500, 800, 0)).toBe(0);
  });

  it('lights the last dot when at end-of-scroll, even if max < nominal step', () => {
    // Viewport 800, content 1300 → maxScroll = 500, dots = 3.
    // Without the maxScroll guard, round(500/400)=1 would leave the last dot dark.
    expect(pageFromScroll(500, 800, 3, 500)).toBe(2);
  });

  it('1px slack covers sub-pixel rounding at the trailing edge', () => {
    expect(pageFromScroll(499.2, 800, 3, 500)).toBe(2);
  });
});
