/** Synthetic Chromaprint-like fingerprints for theme tests. Random 32-bit
 *  items never match each other (~16 bit errors), so a planted copy of a
 *  "theme" is the only shared audio between two windows. */
import { ITEM_S } from '../../src/themes/match.js';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

export const items = (seconds: number): number => Math.round(seconds / ITEM_S);

export function randomFp(n: number, rand: () => number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand();
  return out;
}

/** A window of `totalS` random audio with `theme` planted at `atS`. */
export function windowWith(totalS: number, rand: () => number, theme?: Uint32Array, atS = 0): Uint32Array {
  const w = randomFp(items(totalS), rand);
  if (theme) w.set(theme.subarray(0, Math.max(0, w.length - items(atS))), items(atS));
  return w;
}

/** Flip `bits` random bits in a `fraction` of items. */
export function noisy(fp: Uint32Array, fraction: number, bits: number, rand: () => number): Uint32Array {
  const out = fp.slice();
  for (let i = 0; i < out.length; i++) {
    if (rand() / 0x100000000 >= fraction) continue;
    for (let b = 0; b < bits; b++) out[i] = (out[i]! ^ (1 << (rand() % 32))) >>> 0;
  }
  return out;
}
