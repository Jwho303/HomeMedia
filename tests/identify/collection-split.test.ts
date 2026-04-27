/**
 * Tests for `shouldSplitCollectionBucket` — the post-0.1.5.1 heuristic that
 * detects "this folder is a packaged collection of independent movies, not
 * a single series" and splits the cohort into per-file singletons.
 *
 * Two halves:
 *   - POSITIVE: collections that should split (Scary Movie Collection 1-5 etc.)
 *   - NEGATIVE: legit series/movie folders that must NOT split (false-positive
 *     prevention — much more important than missing a collection)
 */

import { describe, it, expect } from 'vitest';
import { shouldSplitCollectionBucket, type FileEntry } from '../../src/identify/cohorts.js';

function f(relPosix: string): FileEntry {
  return { relPosix, mtime: 0 };
}

describe('shouldSplitCollectionBucket — positive cases', () => {
  it('splits "Collection 1-5" with distinct sequel titles', () => {
    const folder = 'Scary Movie Collection 1-5 2000-2013 720p BluRay';
    const files = [
      f(`${folder}/Scary.Movie.2000.mkv`),
      f(`${folder}/Scary.Movie.2.2001.mkv`),
      f(`${folder}/Scary.Movie.3.2003.mkv`),
      f(`${folder}/Scary.Movie.4.2006.mkv`),
      f(`${folder}/Scary.Movie.5.2013.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });

  it('splits "Trilogy" folder with 3 distinct movies', () => {
    const folder = 'Lord of the Rings Trilogy';
    const files = [
      f(`${folder}/Fellowship.of.the.Ring.2001.mkv`),
      f(`${folder}/Two.Towers.2002.mkv`),
      f(`${folder}/Return.of.the.King.2003.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });

  it('splits "Anthology" folder with distinct films', () => {
    const folder = 'Alien Anthology';
    const files = [
      f(`${folder}/Alien.1979.mkv`),
      f(`${folder}/Aliens.1986.mkv`),
      f(`${folder}/Alien.3.1992.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });

  it('splits a year-range folder ("2000-2013") even without a keyword', () => {
    const folder = 'Mission Impossible 1996-2018';
    const files = [
      f(`${folder}/Mission.Impossible.1996.mkv`),
      f(`${folder}/Mission.Impossible.II.2000.mkv`),
      f(`${folder}/Mission.Impossible.III.2006.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });

  it('splits a sequel-range folder ("1-5")', () => {
    const folder = 'Rocky 1-5';
    const files = [
      f(`${folder}/Rocky.1976.mkv`),
      f(`${folder}/Rocky.II.1979.mkv`),
      f(`${folder}/Rocky.III.1982.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });

  it('splits a "Box Set" folder', () => {
    const folder = 'James Bond Box Set';
    const files = [
      f(`${folder}/Goldfinger.1964.mkv`),
      f(`${folder}/Casino.Royale.2006.mkv`),
      f(`${folder}/Skyfall.2012.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(true);
  });
});

describe('shouldSplitCollectionBucket — negative cases (false-positive prevention)', () => {
  it('does NOT split a real series folder (S/E patterns present)', () => {
    // "The Bear S01-S03" has a year-range AND would match `_keyword|range`,
    // BUT the files have S/E patterns → real series, must not split.
    const folder = 'The Bear S01-S03';
    const files = [
      f(`${folder}/The.Bear.S01E01.mkv`),
      f(`${folder}/The.Bear.S01E02.mkv`),
      f(`${folder}/The.Bear.S02E01.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split "Complete Series" folder when files have S/E', () => {
    const folder = 'Breaking Bad Complete Series';
    const files = [
      f(`${folder}/Breaking.Bad.S01E01.mkv`),
      f(`${folder}/Breaking.Bad.S02E01.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split a single-movie cohort (only one file)', () => {
    const folder = 'The Matrix Collection';
    const files = [f(`${folder}/The.Matrix.1999.mkv`)];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split a regular movie folder (no collection marker)', () => {
    const folder = 'Dune (2021)';
    const files = [
      f(`${folder}/Dune.2021.1080p.mkv`),
      f(`${folder}/Dune.2021.4K.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split when files parse to the SAME title (multi-rip of one movie)', () => {
    // "Collection" keyword present, but the two files are two rips of the
    // same movie with the same parsed title → don't split.
    const folder = 'Dune Collection';
    const files = [
      f(`${folder}/Dune.2021.1080p.mkv`),
      f(`${folder}/Dune.2021.4K.mkv`),
    ];
    // Both parse to title "Dune" → should NOT split (would otherwise nuke
    // the multi-rip-as-one-row contract).
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split when folder has no collection keyword and no year-range', () => {
    const folder = 'My Movies';
    const files = [
      f(`${folder}/Movie.A.2010.mkv`),
      f(`${folder}/Movie.B.2011.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split when one file has S/E even if others do not', () => {
    // Mixed bag: shouldn't auto-split — let the standard cohort path handle it.
    const folder = 'Some Collection';
    const files = [
      f(`${folder}/Movie.2020.mkv`),
      f(`${folder}/Series.S01E01.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });

  it('does NOT split a series whose S/E is on the parent folder, not the filename', () => {
    // Some rip layouts put S01E01 in the folder name and a generic "video.mkv"
    // inside. parsedSeOf checks parent dir, so the S/E check should still fire.
    const folder = 'Some Show Collection';
    const files = [
      f(`${folder}/S01E01 - Pilot/video.mkv`),
      f(`${folder}/S01E02 - Hands/video.mkv`),
    ];
    expect(shouldSplitCollectionBucket(folder, files)).toBe(false);
  });
});
