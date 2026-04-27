/**
 * Pure helpers for the home view (0.1.3.2 D5).
 *
 * `computeChunks(items, sortMode)` is the only function the component calls. It returns
 * an ordered list of chunks, each with its heading, ordered items, and pre-computed
 * smart-anchor index. Switching the sort selector reshuffles the entire page; this
 * function captures all of that logic.
 *
 * The home component appends the Continue Watching chunk separately — `computeChunks`
 * never sees those rows.
 */

import { playHref, seriesHref } from '../router.js';
import type { LibraryItem, ContinueRow } from '../types.js';

export type SortMode = 'dateAdded' | 'releaseDate' | 'genre' | 'name';

export type ChunkType = 'continue' | 'dateAdded' | 'releaseDate' | 'genre' | 'name';

export interface HomeCardItem {
  id: number;
  type: 'movie' | 'series';
  title: string;
  posterUrl: string | null;
  /** Where to navigate on click. */
  href: string;
  position: number;
  duration: number;
  watched: boolean;
  watchedAt: number | null;
  runtimeSeconds: number | null;
  year: number | null;
  genres: string[];
  addedAt: number;
  lastPlayedAt: number | null;
  /** Continue rows only. */
  resumeLabel?: string | null;
}

export interface Chunk {
  key: string;
  type: ChunkType;
  heading: string;
  subtitle: string;
  items: HomeCardItem[];
  /** Index into `items` to anchor at the LEFT edge on mount. */
  anchorIndex: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

// ------------------------------------------------------------
// Card-shape conversion
// ------------------------------------------------------------

/** Convert a LibraryItem into the card shape used by `<poster-strip>`. */
export function libraryItemToCard(item: LibraryItem): HomeCardItem {
  const href = item.type === 'series' ? seriesHref(item.id) : playHref(item.path);
  return {
    id: item.id,
    type: item.type,
    title: item.title ?? item.path,
    posterUrl: item.posterUrl,
    href,
    position: item.position,
    duration: item.duration,
    watched: item.watched,
    watchedAt: item.watchedAt,
    runtimeSeconds: item.runtimeSeconds,
    year: item.year,
    genres: item.genres,
    addedAt: item.addedAt,
    lastPlayedAt: item.lastPlayedAt,
  };
}

/** Convert a Continue row. The href is always the resume target (movie or specific episode). */
export function continueRowToCard(row: ContinueRow): HomeCardItem {
  return {
    id: row.itemId,
    type: row.type,
    title: row.title ?? '',
    posterUrl: row.posterUrl,
    href: playHref(row.resumePath),
    position: row.position,
    duration: row.duration,
    watched: false,
    watchedAt: null,
    runtimeSeconds: row.runtimeSeconds,
    year: null,
    genres: [],
    addedAt: row.lastPlayedAt,
    lastPlayedAt: row.lastPlayedAt,
    resumeLabel: row.resumeLabel,
  };
}

// ------------------------------------------------------------
// NEW badge / formatting helpers
// ------------------------------------------------------------

/** NEW badge: added within the last 7 days, never played. (D8) */
export function isNew(item: HomeCardItem | LibraryItem, now: number): boolean {
  if (item.watched) return false;
  if (item.position > 0) return false;
  return item.addedAt >= now - WEEK_MS;
}

/** Format the time-remaining label for an in-progress card: "1h 22m left". */
export function formatTimeRemaining(item: { position: number; duration: number; runtimeSeconds: number | null }): string | null {
  let total = item.duration > 0 ? item.duration : item.runtimeSeconds ?? 0;
  if (total <= 0) return null;
  const remaining = Math.max(0, total - item.position);
  if (remaining <= 0) return null;
  const totalMin = Math.max(1, Math.round(remaining / 60));
  if (totalMin < 60) return `${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h left` : `${h}h ${m}m left`;
}

// ------------------------------------------------------------
// Bucketing helpers (one per sort mode)
// ------------------------------------------------------------

export interface DateAddedBucket {
  key: 'newWeek' | 'newMonth' | 'thisYear' | 'older';
  heading: string;
}

/** Decide which Date Added bucket an item lands in given the current `now`. (D7) */
export function bucketByDateAdded(item: { addedAt: number }, now: number): DateAddedBucket {
  const age = now - item.addedAt;
  if (age <= WEEK_MS) return { key: 'newWeek', heading: 'New This Week' };
  if (age <= MONTH_MS) return { key: 'newMonth', heading: 'New This Month' };
  const itemYear = new Date(item.addedAt).getFullYear();
  const nowYear = new Date(now).getFullYear();
  if (itemYear === nowYear) return { key: 'thisYear', heading: 'Earlier This Year' };
  return { key: 'older', heading: 'Older' };
}

export interface ReleaseDateBucket {
  /** Sort key (year value or decade-start year, with explicit ordering for "Older"). */
  sortKey: number;
  heading: string;
}

/** Decide which Release Date bucket. */
export function bucketByReleaseYear(item: { year: number | null }, now: number): ReleaseDateBucket {
  const nowYear = new Date(now).getFullYear();
  if (item.year == null) return { sortKey: -1, heading: 'Unknown year' };
  // Recent years (>= nowYear - 5) → individual year buckets.
  if (item.year >= nowYear - 5) {
    return { sortKey: item.year, heading: String(item.year) };
  }
  // 2010s, 2000s → decade buckets, but only down to 2000.
  if (item.year >= 2010) return { sortKey: 2010, heading: '2010s' };
  if (item.year >= 2000) return { sortKey: 2000, heading: '2000s' };
  return { sortKey: 0, heading: '2000s and earlier' };
}

export interface AlphaBucket {
  /** Sort key index 0..N. Letters go A-D, E-H, I-L, M-P, Q-T, U-Z, then "0–9 / other". */
  sortKey: number;
  heading: string;
}

const LETTER_RANGES: Array<{ from: string; to: string; heading: string }> = [
  { from: 'A', to: 'D', heading: 'A–D' },
  { from: 'E', to: 'H', heading: 'E–H' },
  { from: 'I', to: 'L', heading: 'I–L' },
  { from: 'M', to: 'P', heading: 'M–P' },
  { from: 'Q', to: 'T', heading: 'Q–T' },
  { from: 'U', to: 'Z', heading: 'U–Z' },
];

export function bucketAlphabetical(item: { title: string }): AlphaBucket {
  const t = stripLeadingArticle(item.title).trim().toUpperCase();
  const c = t.charAt(0);
  if (c < 'A' || c > 'Z') return { sortKey: 999, heading: '0–9 / other' };
  for (let i = 0; i < LETTER_RANGES.length; i++) {
    const r = LETTER_RANGES[i]!;
    if (c >= r.from && c <= r.to) return { sortKey: i, heading: r.heading };
  }
  return { sortKey: 999, heading: '0–9 / other' };
}

function stripLeadingArticle(s: string): string {
  return s.replace(/^(?:the|a|an)\s+/i, '');
}

// ------------------------------------------------------------
// Anchor rule per chunk type
// ------------------------------------------------------------

/** Compute the smart-anchor index per chunk type. (Spec table) */
export function pickAnchorIndex(chunkType: ChunkType, items: HomeCardItem[]): number {
  if (items.length === 0) return 0;
  switch (chunkType) {
    case 'continue':
      return 0; // already ordered most-recent-first
    case 'dateAdded':
    case 'releaseDate':
    case 'name':
      return 0;
    case 'genre': {
      // First unwatched item, falling back to 0 if all are watched.
      const idx = items.findIndex((i) => !i.watched);
      return idx < 0 ? 0 : idx;
    }
    default:
      return 0;
  }
}

// ------------------------------------------------------------
// computeChunks — the public entry point
// ------------------------------------------------------------

export interface ComputeChunksOptions {
  now: number;
}

/**
 * Compute chunks from filtered items + a sort mode.
 *
 * Empty buckets are removed. Within-chunk ordering follows the spec table.
 * Continue Watching is NOT included here — the component prepends it separately.
 */
export function computeChunks(
  items: HomeCardItem[],
  sortMode: SortMode,
  opts: ComputeChunksOptions,
): Chunk[] {
  if (items.length === 0) return [];
  switch (sortMode) {
    case 'dateAdded':
      return chunksByDateAdded(items, opts.now);
    case 'releaseDate':
      return chunksByReleaseYear(items, opts.now);
    case 'genre':
      return chunksByGenre(items);
    case 'name':
      return chunksAlphabetical(items);
    default:
      return [];
  }
}

function chunksByDateAdded(items: HomeCardItem[], now: number): Chunk[] {
  const groups = new Map<DateAddedBucket['key'], { heading: string; items: HomeCardItem[] }>();
  for (const it of items) {
    const b = bucketByDateAdded(it, now);
    let g = groups.get(b.key);
    if (!g) {
      g = { heading: b.heading, items: [] };
      groups.set(b.key, g);
    }
    g.items.push(it);
  }
  // Order: newWeek > newMonth > thisYear > older
  const order: Array<DateAddedBucket['key']> = ['newWeek', 'newMonth', 'thisYear', 'older'];
  const out: Chunk[] = [];
  for (const key of order) {
    const g = groups.get(key);
    if (!g || g.items.length === 0) continue;
    const sorted = g.items.slice().sort((a, b) => b.addedAt - a.addedAt); // newest first
    out.push({
      key: `dateAdded:${key}`,
      type: 'dateAdded',
      heading: g.heading,
      subtitle: subtitleFor(sorted),
      items: sorted,
      anchorIndex: pickAnchorIndex('dateAdded', sorted),
    });
  }
  return out;
}

function chunksByReleaseYear(items: HomeCardItem[], now: number): Chunk[] {
  const groups = new Map<string, { sortKey: number; heading: string; items: HomeCardItem[] }>();
  for (const it of items) {
    const b = bucketByReleaseYear(it, now);
    let g = groups.get(b.heading);
    if (!g) {
      g = { sortKey: b.sortKey, heading: b.heading, items: [] };
      groups.set(b.heading, g);
    }
    g.items.push(it);
  }
  // Order: highest sortKey first; "Unknown year" (sortKey -1) lands last.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.sortKey === -1 && b.sortKey !== -1) return 1;
    if (b.sortKey === -1 && a.sortKey !== -1) return -1;
    return b.sortKey - a.sortKey;
  });
  return ordered.map((g) => {
    const sorted = g.items.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    return {
      key: `releaseDate:${g.heading}`,
      type: 'releaseDate' as const,
      heading: g.heading,
      subtitle: subtitleFor(sorted),
      items: sorted,
      anchorIndex: pickAnchorIndex('releaseDate', sorted),
    };
  });
}

function chunksByGenre(items: HomeCardItem[]): Chunk[] {
  // Compute per-genre watched counts for the "most-watched-genre first" rule.
  const watchedCounts = new Map<string, number>();
  const groups = new Map<string, HomeCardItem[]>();
  for (const it of items) {
    if (it.genres.length === 0) {
      const arr = groups.get('__no_genre__') ?? [];
      arr.push(it);
      groups.set('__no_genre__', arr);
      continue;
    }
    for (const g of it.genres) {
      const arr = groups.get(g) ?? [];
      arr.push(it);
      groups.set(g, arr);
      if (it.watched) watchedCounts.set(g, (watchedCounts.get(g) ?? 0) + 1);
    }
  }
  const named = [...groups.entries()].filter(([k]) => k !== '__no_genre__');
  named.sort((a, b) => {
    const wa = watchedCounts.get(a[0]) ?? 0;
    const wb = watchedCounts.get(b[0]) ?? 0;
    if (wb !== wa) return wb - wa;
    return a[0].localeCompare(b[0]);
  });
  const noGenre = groups.get('__no_genre__');

  const out: Chunk[] = named.map(([genre, list]) => {
    const sorted = list.slice().sort((a, b) => a.title.localeCompare(b.title));
    return {
      key: `genre:${genre}`,
      type: 'genre' as const,
      heading: genre,
      subtitle: subtitleFor(sorted),
      items: sorted,
      anchorIndex: pickAnchorIndex('genre', sorted),
    };
  });
  if (noGenre && noGenre.length > 0) {
    const sorted = noGenre.slice().sort((a, b) => a.title.localeCompare(b.title));
    out.push({
      key: 'genre:__no_genre__',
      type: 'genre',
      heading: 'No genre',
      subtitle: subtitleFor(sorted),
      items: sorted,
      anchorIndex: pickAnchorIndex('genre', sorted),
    });
  }
  return out;
}

function chunksAlphabetical(items: HomeCardItem[]): Chunk[] {
  const groups = new Map<number, { heading: string; items: HomeCardItem[] }>();
  for (const it of items) {
    const b = bucketAlphabetical(it);
    let g = groups.get(b.sortKey);
    if (!g) {
      g = { heading: b.heading, items: [] };
      groups.set(b.sortKey, g);
    }
    g.items.push(it);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a - b);
  return ordered.map(([_, g]) => {
    const sorted = g.items
      .slice()
      .sort((a, b) =>
        stripLeadingArticle(a.title).localeCompare(stripLeadingArticle(b.title)),
      );
    return {
      key: `name:${g.heading}`,
      type: 'name' as const,
      heading: g.heading,
      subtitle: subtitleFor(sorted),
      items: sorted,
      anchorIndex: pickAnchorIndex('name', sorted),
    };
  });
}

function subtitleFor(items: HomeCardItem[]): string {
  const total = items.length;
  const watched = items.reduce((n, i) => n + (i.watched ? 1 : 0), 0);
  if (watched === 0) return `${total} item${total === 1 ? '' : 's'}`;
  return `${total} · ${watched} watched`;
}

/**
 * Build Continue Watching chunks from `/api/continue` rows. Caller is expected to
 * pre-filter rows by the active Movies/Series tab so each toggle only sees its own
 * resumable items (overrides D6 from the original spec). Movies and series each
 * get their own chunk if both type rows happen to be passed in. Returns an empty
 * array when there are no resumable items.
 */
export function continueChunks(rows: ContinueRow[]): Chunk[] {
  if (rows.length === 0) return [];
  const movies = rows.filter((r) => r.type === 'movie').map(continueRowToCard);
  const series = rows.filter((r) => r.type === 'series').map(continueRowToCard);
  const out: Chunk[] = [];
  if (movies.length > 0) {
    out.push({
      key: 'continue:movies',
      type: 'continue',
      heading: 'Continue Watching',
      subtitle: `${movies.length} item${movies.length === 1 ? '' : 's'}`,
      items: movies,
      anchorIndex: pickAnchorIndex('continue', movies),
    });
  }
  if (series.length > 0) {
    out.push({
      key: 'continue:series',
      type: 'continue',
      heading: 'Continue Watching',
      subtitle: `${series.length} item${series.length === 1 ? '' : 's'}`,
      items: series,
      anchorIndex: pickAnchorIndex('continue', series),
    });
  }
  return out;
}
