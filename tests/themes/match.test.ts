import { describe, it, expect } from 'vitest';
import { ITEM_S, decodeRaw, encodeFp, locate, longestShared, popcount32, type KindParams } from '../../src/themes/match.js';
import { items, noisy, randomFp, rng, windowWith } from './fixtures.js';

const KIND: KindParams = { windowS: 300, minS: 15, maxS: 150 };

describe('popcount32', () => {
  it('counts bits', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0b1011)).toBe(3);
  });
});

describe('fingerprint encoding', () => {
  it('round-trips through a buffer', () => {
    const fp = randomFp(50, rng(1));
    expect(Array.from(decodeRaw(encodeFp(fp)))).toEqual(Array.from(fp));
  });
});

describe('longestShared', () => {
  it('finds a 90 s theme planted at different offsets', () => {
    const r = rng(2);
    const theme = randomFp(items(90), r);
    const a = windowWith(300, r, theme, 20);
    const b = windowWith(300, r, theme, 75);
    const c = longestShared(a, b, KIND)!;
    expect(c).not.toBeNull();
    expect(Math.abs((c.aEnd - c.aStart) * ITEM_S - 90)).toBeLessThan(1);
    expect(Math.abs(c.aStart * ITEM_S - 20)).toBeLessThan(1);
    expect(Math.abs(c.bStart * ITEM_S - 75)).toBeLessThan(1);
  });

  it('returns null when the shared run is shorter than minS', () => {
    const r = rng(3);
    const theme = randomFp(items(10), r);
    expect(longestShared(windowWith(300, r, theme, 5), windowWith(300, r, theme, 50), KIND)).toBeNull();
  });

  it('returns null when the shared run is longer than maxS', () => {
    const r = rng(4);
    const theme = randomFp(items(200), r);
    expect(longestShared(windowWith(300, r, theme, 0), windowWith(300, r, theme, 10), KIND)).toBeNull();
  });

  it('returns null for unrelated audio', () => {
    const r = rng(5);
    expect(longestShared(windowWith(300, r), windowWith(300, r), KIND)).toBeNull();
  });

  it('joins a theme interrupted by a varying gag into one stretch', () => {
    const r = rng(6);
    const part1 = randomFp(items(20), r);
    const part2 = randomFp(items(25), r);
    const mk = (): Uint32Array => {
      const gag = randomFp(items(6), r); // differs per episode
      const t = new Uint32Array(part1.length + gag.length + part2.length);
      t.set(part1, 0);
      t.set(gag, part1.length);
      t.set(part2, part1.length + gag.length);
      return t;
    };
    const c = longestShared(windowWith(300, r, mk(), 30), windowWith(300, r, mk(), 60), KIND)!;
    expect(c).not.toBeNull();
    expect((c.aEnd - c.aStart) * ITEM_S).toBeGreaterThan(48);
  });
});

describe('locate', () => {
  it('finds the theme within 1 s of where it was planted', () => {
    const r = rng(7);
    const theme = randomFp(items(60), r);
    const l = locate(windowWith(300, r, theme, 180), theme)!;
    expect(l).not.toBeNull();
    expect(Math.abs(l.startS - 180)).toBeLessThan(1);
    expect(Math.abs(l.endS - 240)).toBeLessThan(1);
  });

  it('returns null when the theme is absent', () => {
    const r = rng(8);
    expect(locate(windowWith(300, r), randomFp(items(60), r))).toBeNull();
  });

  it('still hits with 10% of items heavily corrupted', () => {
    const r = rng(9);
    const theme = randomFp(items(60), r);
    const w = noisy(windowWith(300, r, theme, 40), 0.1, 16, r);
    const l = locate(w, theme)!;
    expect(l).not.toBeNull();
    expect(Math.abs(l.startS - 40)).toBeLessThan(1);
  });

  it('finds a theme cut off by the end of the window', () => {
    const r = rng(10);
    const theme = randomFp(items(60), r);
    const l = locate(windowWith(300, r, theme, 260), theme)!; // only 40 s fit
    expect(l).not.toBeNull();
    expect(Math.abs(l.startS - 260)).toBeLessThan(1);
  });
});
