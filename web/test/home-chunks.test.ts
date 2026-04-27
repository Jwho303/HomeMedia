import { describe, it, expect } from 'vitest';
import {
  bucketByDateAdded,
  bucketByReleaseYear,
  bucketAlphabetical,
  isNew,
  formatTimeRemaining,
  pickAnchorIndex,
  computeChunks,
  continueChunks,
  type HomeCardItem,
} from '../src/components/home-chunks.js';
import type { ContinueRow } from '../src/types.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-04-26T12:00:00Z');

function card(overrides: Partial<HomeCardItem> = {}): HomeCardItem {
  return {
    id: 1,
    type: 'movie',
    title: 'Item',
    posterUrl: null,
    href: '#/play/x',
    position: 0,
    duration: 0,
    watched: false,
    watchedAt: null,
    runtimeSeconds: null,
    year: null,
    genres: [],
    addedAt: NOW,
    lastPlayedAt: null,
    ...overrides,
  };
}

// ---- isNew ------------------------------------------------------------------

describe('isNew', () => {
  it('is true within 7 days, never played', () => {
    expect(isNew(card({ addedAt: NOW - 3 * DAY_MS }), NOW)).toBe(true);
  });

  it('is false at boundary day 8', () => {
    expect(isNew(card({ addedAt: NOW - 8 * DAY_MS }), NOW)).toBe(false);
  });

  it('is true exactly at 7d boundary', () => {
    expect(isNew(card({ addedAt: NOW - 7 * DAY_MS }), NOW)).toBe(true);
  });

  it('is false once played (position > 0)', () => {
    expect(isNew(card({ addedAt: NOW - 1 * DAY_MS, position: 100 }), NOW)).toBe(false);
  });

  it('is false once watched', () => {
    expect(isNew(card({ addedAt: NOW - 1 * DAY_MS, watched: true }), NOW)).toBe(false);
  });
});

// ---- formatTimeRemaining ----------------------------------------------------

describe('formatTimeRemaining', () => {
  it('returns null when neither duration nor runtimeSeconds available', () => {
    expect(formatTimeRemaining({ position: 100, duration: 0, runtimeSeconds: null })).toBeNull();
  });

  it('falls back to runtimeSeconds when duration is 0', () => {
    expect(formatTimeRemaining({ position: 600, duration: 0, runtimeSeconds: 1500 })).toBe('15m left');
  });

  it('uses duration when available', () => {
    expect(formatTimeRemaining({ position: 1500, duration: 9300, runtimeSeconds: null })).toBe('2h 10m left');
  });

  it('handles round-hour case', () => {
    expect(formatTimeRemaining({ position: 0, duration: 3600, runtimeSeconds: null })).toBe('1h left');
  });

  it('returns null when fully watched (no remaining)', () => {
    expect(formatTimeRemaining({ position: 1500, duration: 1500, runtimeSeconds: null })).toBeNull();
  });
});

// ---- bucketByDateAdded ------------------------------------------------------

describe('bucketByDateAdded', () => {
  it('classifies <=7d as newWeek', () => {
    expect(bucketByDateAdded({ addedAt: NOW - 6 * DAY_MS }, NOW).key).toBe('newWeek');
  });
  it('classifies >7d <=30d as newMonth', () => {
    expect(bucketByDateAdded({ addedAt: NOW - 15 * DAY_MS }, NOW).key).toBe('newMonth');
  });
  it('classifies older but same year as thisYear', () => {
    expect(bucketByDateAdded({ addedAt: Date.parse('2026-01-15T12:00:00Z') }, NOW).key).toBe('thisYear');
  });
  it('classifies prior-year items as older', () => {
    expect(bucketByDateAdded({ addedAt: Date.parse('2024-01-15T12:00:00Z') }, NOW).key).toBe('older');
  });
});

// ---- bucketByReleaseYear ----------------------------------------------------

describe('bucketByReleaseYear', () => {
  it('treats null year as Unknown', () => {
    expect(bucketByReleaseYear({ year: null }, NOW).heading).toBe('Unknown year');
  });
  it('individual buckets for recent years', () => {
    expect(bucketByReleaseYear({ year: 2024 }, NOW).heading).toBe('2024');
  });
  it('rolls older years into 2010s/2000s decades', () => {
    expect(bucketByReleaseYear({ year: 2015 }, NOW).heading).toBe('2010s');
    expect(bucketByReleaseYear({ year: 2005 }, NOW).heading).toBe('2000s');
  });
  it('rolls pre-2000 into "2000s and earlier"', () => {
    expect(bucketByReleaseYear({ year: 1995 }, NOW).heading).toBe('2000s and earlier');
  });
});

// ---- bucketAlphabetical -----------------------------------------------------

describe('bucketAlphabetical', () => {
  it('letters split into ranges', () => {
    expect(bucketAlphabetical({ title: 'Apple' }).heading).toBe('A–D');
    expect(bucketAlphabetical({ title: 'Eel' }).heading).toBe('E–H');
    expect(bucketAlphabetical({ title: 'Igloo' }).heading).toBe('I–L');
    expect(bucketAlphabetical({ title: 'Mango' }).heading).toBe('M–P');
    expect(bucketAlphabetical({ title: 'Quail' }).heading).toBe('Q–T');
    expect(bucketAlphabetical({ title: 'Zebra' }).heading).toBe('U–Z');
  });
  it('numerics + symbols land in "0–9 / other"', () => {
    expect(bucketAlphabetical({ title: '1984' }).heading).toBe('0–9 / other');
    expect(bucketAlphabetical({ title: '$pecial' }).heading).toBe('0–9 / other');
  });
  it('strips leading articles', () => {
    expect(bucketAlphabetical({ title: 'The Bear' }).heading).toBe('A–D');
  });
});

// ---- pickAnchorIndex --------------------------------------------------------

describe('pickAnchorIndex', () => {
  it('continue: 0', () => {
    expect(pickAnchorIndex('continue', [card(), card()])).toBe(0);
  });
  it('dateAdded / releaseDate / name: 0', () => {
    const items = [card({ watched: true }), card()];
    expect(pickAnchorIndex('dateAdded', items)).toBe(0);
    expect(pickAnchorIndex('releaseDate', items)).toBe(0);
    expect(pickAnchorIndex('name', items)).toBe(0);
  });
  it('genre: first unwatched', () => {
    const items = [card({ watched: true }), card({ watched: true }), card({ id: 9 })];
    expect(pickAnchorIndex('genre', items)).toBe(2);
  });
  it('genre with all watched: falls back to 0', () => {
    const items = [card({ watched: true }), card({ watched: true })];
    expect(pickAnchorIndex('genre', items)).toBe(0);
  });
  it('empty input: 0', () => {
    expect(pickAnchorIndex('genre', [])).toBe(0);
  });
});

// ---- computeChunks ----------------------------------------------------------

describe('computeChunks: dateAdded', () => {
  it('empty input → empty chunks', () => {
    expect(computeChunks([], 'dateAdded', { now: NOW })).toEqual([]);
  });

  it('drops empty buckets and orders by recency', () => {
    const items = [
      card({ id: 1, addedAt: NOW - 1 * DAY_MS, title: 'A' }),  // newWeek
      card({ id: 2, addedAt: NOW - 20 * DAY_MS, title: 'B' }), // newMonth
      card({ id: 3, addedAt: Date.parse('2024-05-01T00:00:00Z'), title: 'C' }), // older
    ];
    const chunks = computeChunks(items, 'dateAdded', { now: NOW });
    expect(chunks.map((c) => c.heading)).toEqual(['New This Week', 'New This Month', 'Older']);
    expect(chunks[0]!.items[0]!.id).toBe(1);
    expect(chunks[0]!.anchorIndex).toBe(0);
  });

  it('items missing addedAt fields go through bucketing without crashing', () => {
    const items = [card({ id: 1, addedAt: 0 })];
    const chunks = computeChunks(items, 'dateAdded', { now: NOW });
    expect(chunks).toHaveLength(1);
  });
});

describe('computeChunks: releaseDate', () => {
  it('produces year + decade buckets descending', () => {
    const items = [
      card({ id: 1, year: 2026, title: 'A' }),
      card({ id: 2, year: 2024, title: 'B' }),
      card({ id: 3, year: 2015, title: 'C' }),
      card({ id: 4, year: 2003, title: 'D' }),
      card({ id: 5, year: 1990, title: 'E' }),
      card({ id: 6, year: null, title: 'F' }),
    ];
    const chunks = computeChunks(items, 'releaseDate', { now: NOW });
    expect(chunks.map((c) => c.heading)).toEqual([
      '2026', '2024', '2010s', '2000s', '2000s and earlier', 'Unknown year',
    ]);
  });

  it('empty input → empty', () => {
    expect(computeChunks([], 'releaseDate', { now: NOW })).toEqual([]);
  });

  it('all unknown years collapses to one bucket', () => {
    const items = [card({ year: null, id: 1 }), card({ year: null, id: 2 })];
    const chunks = computeChunks(items, 'releaseDate', { now: NOW });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe('Unknown year');
  });
});

describe('computeChunks: genre', () => {
  it('one chunk per genre, sorted by user-watched-count first', () => {
    const items = [
      card({ id: 1, title: 'Drama 1', genres: ['Drama'], watched: true }),
      card({ id: 2, title: 'Drama 2', genres: ['Drama'], watched: true }),
      card({ id: 3, title: 'Drama 3', genres: ['Drama'] }),
      card({ id: 4, title: 'Sci 1', genres: ['Sci-Fi'] }),
      card({ id: 5, title: 'No genre', genres: [] }),
    ];
    const chunks = computeChunks(items, 'genre', { now: NOW });
    // Drama (2 watched) > Sci-Fi (0 watched) > No genre last
    expect(chunks.map((c) => c.heading)).toEqual(['Drama', 'Sci-Fi', 'No genre']);
    // Anchor lands on the first unwatched ('Drama 3' = id 3) in Drama chunk
    const drama = chunks[0]!;
    expect(drama.items[drama.anchorIndex]!.id).toBe(3);
  });

  it('genre membership cross-listing duplicates an item across multiple genre chunks', () => {
    const items = [card({ id: 1, title: 'Mixed', genres: ['Drama', 'Sci-Fi'] })];
    const chunks = computeChunks(items, 'genre', { now: NOW });
    expect(chunks.map((c) => c.heading).sort()).toEqual(['Drama', 'Sci-Fi']);
  });

  it('empty input → empty', () => {
    expect(computeChunks([], 'genre', { now: NOW })).toEqual([]);
  });
});

describe('computeChunks: name', () => {
  it('groups into letter ranges and sorts alphabetically', () => {
    const items = [
      card({ id: 1, title: 'Zebra' }),
      card({ id: 2, title: 'Apple' }),
      card({ id: 3, title: 'The Bear' }),
      card({ id: 4, title: '1984' }),
    ];
    const chunks = computeChunks(items, 'name', { now: NOW });
    expect(chunks.map((c) => c.heading)).toEqual(['A–D', 'U–Z', '0–9 / other']);
    // Within A–D, "Apple" then "The Bear" (after stripping article)
    expect(chunks[0]!.items.map((i) => i.id)).toEqual([2, 3]);
  });

  it('empty input → empty', () => {
    expect(computeChunks([], 'name', { now: NOW })).toEqual([]);
  });

  it('does not apply smart-anchor logic (anchor=0 even if some items watched)', () => {
    const items = [
      card({ id: 1, title: 'Apple', watched: true }),
      card({ id: 2, title: 'Banana' }),
    ];
    const chunks = computeChunks(items, 'name', { now: NOW });
    expect(chunks[0]!.anchorIndex).toBe(0);
  });
});

// ---- continueChunk ----------------------------------------------------------

describe('continueChunks', () => {
  function row(overrides: Partial<ContinueRow> = {}): ContinueRow {
    return {
      type: 'movie',
      itemId: 1,
      title: 'Item',
      posterUrl: null,
      resumePath: 'X.mkv',
      position: 100,
      duration: 1000,
      runtimeSeconds: null,
      resumeLabel: null,
      lastPlayedAt: 1000,
      ...overrides,
    };
  }

  it('empty when no rows', () => {
    expect(continueChunks([])).toEqual([]);
  });

  it('splits movies + series into separate chunks; movies first', () => {
    const chunks = continueChunks([
      row({ itemId: 7, title: 'Show', type: 'series', resumePath: 'Show/S2E4.mkv', resumeLabel: 'S2 · E4' }),
      row({ itemId: 1, title: 'Dune', resumePath: 'Dune.mkv' }),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.items[0]!.title).toBe('Dune');
    expect(chunks[1]!.items[0]!.title).toBe('Show');
  });

  it('only emits one chunk when only one type is present', () => {
    expect(continueChunks([row({ title: 'Dune' })])).toHaveLength(1);
    expect(continueChunks([row({ type: 'series', title: 'Show', resumeLabel: 'S1 · E2' })])).toHaveLength(1);
  });
});
