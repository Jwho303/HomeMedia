/**
 * Theme-song matching over raw Chromaprint fingerprints (0.2.1).
 *
 * Pure functions. No ffmpeg, no DB. A fingerprint is a Uint32Array where each
 * item covers ~0.124 s of audio. Two copies of the same audio produce items
 * that differ in only a few bits, while unrelated audio differs in ~16 of 32.
 *
 *   learn()  — find the longest stretch of audio two windows share
 *   locate() — find where a known theme plays inside one window
 */

/** Seconds per Chromaprint item at the default algorithm (4096/3 samples at 11025 Hz). */
export const ITEM_S = 4096 / 3 / 11025;

export type ThemeKind = 'opening' | 'ending';

export interface KindParams {
  /** Seconds of audio fingerprinted at the start (opening) or end (ending) of a file. */
  windowS: number;
  /** Shortest shared run accepted as a theme. */
  minS: number;
  /** Longest shared run accepted as a theme. */
  maxS: number;
}

export interface MatchParams {
  /** An item "matches" when its bit error count is <= this. */
  itemBits: number;
  /** Items averaged when deciding whether a stretch is matching. */
  smoothItems: number;
  /** locate(): fraction of the theme's items that must match. */
  minCoverage: number;
  /** Shortest matching piece considered at all. */
  minSegmentS: number;
  /** Longest gap allowed between pieces of one theme. */
  maxGapS: number;
}

/** Per-kind tuning. Openings and endings behave differently (endings are
 *  often longer and sit next to post-credit scenes), so each has its own. */
export const KIND_PARAMS: Record<ThemeKind, KindParams> = {
  opening: { windowS: 600, minS: 15, maxS: 150 },
  ending: { windowS: 480, minS: 15, maxS: 180 },
};

export const MATCH_PARAMS: MatchParams = {
  itemBits: 10,
  smoothItems: 8,
  minCoverage: 0.5,
  minSegmentS: 4,
  maxGapS: 12,
};

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

export interface Segment {
  /** Start item in A. */
  aStart: number;
  /** Start item in B. */
  bStart: number;
  /** Length in items. */
  length: number;
}

export interface Chain {
  aStart: number;
  aEnd: number; // exclusive
  bStart: number;
  bEnd: number; // exclusive
  /** Items that actually matched (gaps excluded). */
  matched: number;
}

/**
 * Every run (>= minItems) where A and B carry the same audio at alignment
 * `offset = aIndex - bIndex`, judged on a moving average of bit errors.
 */
function runsAtOffset(a: Uint32Array, b: Uint32Array, offset: number, minItems: number, p: MatchParams, out: Segment[]): void {
  const aFrom = Math.max(0, offset);
  const aTo = Math.min(a.length, b.length + offset);
  const n = aTo - aFrom;
  if (n < minItems) return;
  const w = p.smoothItems;
  const limit = p.itemBits * w;
  const errs = new Uint8Array(n);
  let sum = 0;
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const e = popcount32((a[aFrom + i]! ^ b[aFrom + i - offset]!) >>> 0);
    errs[i] = e;
    sum += e;
    if (i >= w) sum -= errs[i - w]!;
    const ok = i >= w - 1 && sum <= limit;
    if (ok && runStart < 0) runStart = i - w + 1;
    if (runStart >= 0 && (!ok || i === n - 1)) {
      let start = runStart;
      let end = ok ? i + 1 : i;
      // The moving average lets a few unmatched items hang off each edge; trim them.
      while (start < end && errs[start]! > p.itemBits) start++;
      while (end > start && errs[end - 1]! > p.itemBits) end--;
      if (end - start >= minItems) {
        out.push({ aStart: aFrom + start, bStart: aFrom + start - offset, length: end - start });
      }
      runStart = -1;
    }
  }
}

/** All matching segments between A and B. */
export function segments(a: Uint32Array, b: Uint32Array, p: MatchParams = MATCH_PARAMS): Segment[] {
  const minItems = Math.ceil(p.minSegmentS / ITEM_S);
  const out: Segment[] = [];
  for (let offset = -(b.length - minItems); offset <= a.length - minItems; offset++) {
    runsAtOffset(a, b, offset, minItems, p, out);
  }
  return out;
}

/**
 * Join segments that follow each other in both A and B with short gaps into
 * chains. A theme song interrupted by a varying gag (the Simpsons chalkboard,
 * a different credits voice-over) is still one chain. Returns the best chain
 * ending at each segment.
 */
export function chains(segs: Segment[], p: MatchParams = MATCH_PARAMS): Chain[] {
  const gap = Math.ceil(p.maxGapS / ITEM_S);
  const tol = p.smoothItems;
  const s = [...segs].sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
  const best: Chain[] = [];
  for (let j = 0; j < s.length; j++) {
    const sj = s[j]!;
    let c: Chain = { aStart: sj.aStart, aEnd: sj.aStart + sj.length, bStart: sj.bStart, bEnd: sj.bStart + sj.length, matched: sj.length };
    for (let i = j - 1; i >= 0; i--) {
      const ci = best[i]!;
      if (sj.aStart - ci.aEnd > gap) {
        // Sorted by aStart, but chains can end late; keep scanning a bounded window.
        if (sj.aStart - s[i]!.aStart > gap * 40) break;
        continue;
      }
      const aGap = sj.aStart - ci.aEnd;
      const bGap = sj.bStart - ci.bEnd;
      if (aGap < -tol || bGap < -tol || bGap > gap) continue;
      if (sj.aStart + sj.length <= ci.aEnd) continue; // adds nothing
      const added = sj.length - Math.max(0, -aGap);
      const matched = ci.matched + added;
      if (matched > c.matched) {
        c = {
          aStart: ci.aStart,
          aEnd: Math.max(ci.aEnd, sj.aStart + sj.length),
          bStart: ci.bStart,
          bEnd: Math.max(ci.bEnd, sj.bStart + sj.length),
          matched,
        };
      }
    }
    best.push(c);
  }
  return best;
}

/** Longest shared stretch of audio (gaps allowed) between two windows, within the kind's bounds. */
export function longestShared(
  a: Uint32Array,
  b: Uint32Array,
  kind: KindParams,
  p: MatchParams = MATCH_PARAMS,
): Chain | null {
  const minItems = Math.ceil(kind.minS / ITEM_S);
  const maxItems = Math.floor(kind.maxS / ITEM_S);
  let best: Chain | null = null;
  for (const c of chains(segments(a, b, p), p)) {
    const span = c.aEnd - c.aStart;
    if (span < minItems || span > maxItems) continue;
    if (!best || c.matched > best.matched) best = c;
  }
  return best;
}

export interface Located {
  /** Seconds from the start of the window. */
  startS: number;
  endS: number;
  /** Fraction of the theme found. */
  coverage: number;
}

/** Find a theme inside a window. Returns null when it isn't there. */
export function locate(
  window: Uint32Array,
  theme: Uint32Array,
  p: MatchParams = MATCH_PARAMS,
): Located | null {
  if (theme.length === 0 || window.length === 0) return null;
  let best: Chain | null = null;
  for (const c of chains(segments(window, theme, p), p)) {
    if (!best || c.matched > best.matched) best = c;
  }
  if (!best) return null;
  const coverage = Math.min(1, best.matched / theme.length);
  if (coverage < p.minCoverage) return null;
  // Extend to the theme's full length when the match stops short of its edges
  // (the theme's first/last seconds can be quiet and match poorly).
  const startItem = Math.max(0, best.aStart - best.bStart);
  const endItem = Math.min(window.length, best.aEnd + (theme.length - best.bEnd));
  return { startS: startItem * ITEM_S, endS: endItem * ITEM_S, coverage };
}

/** Raw ffmpeg chromaprint output (little-endian int32 stream) → Uint32Array. */
export function decodeRaw(buf: Buffer): Uint32Array {
  const n = Math.floor(buf.length / 4);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

export function encodeFp(fp: Uint32Array): Buffer {
  const buf = Buffer.alloc(fp.length * 4);
  for (let i = 0; i < fp.length; i++) buf.writeUInt32LE(fp[i]!, i * 4);
  return buf;
}
