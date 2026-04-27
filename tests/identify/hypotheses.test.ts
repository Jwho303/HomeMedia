import { describe, it, expect } from 'vitest';
import { generateHypotheses, pathContext, isSubFolderMarker } from '../../src/identify/hypotheses.js';

const ctxFor = (rel: string, siblings: string[] = []) => pathContext(rel, siblings);

describe('hypotheses', () => {
  it('detects sub-folder markers', () => {
    expect(isSubFolderMarker('Season 1')).toBe(true);
    expect(isSubFolderMarker('season 12')).toBe(true);
    expect(isSubFolderMarker('Episode 3')).toBe(true);
    expect(isSubFolderMarker('S01E02')).toBe(true);
    expect(isSubFolderMarker('The Bear')).toBe(false);
  });

  it('generates a cleaned-prefix hypothesis at the highest prior', () => {
    const rel = 'Minority Report (2002).mp4';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    expect(hs.length).toBeGreaterThanOrEqual(1);
    const top = hs[0]!;
    expect(top.title.toLowerCase()).toContain('minority report');
    expect(top.year).toBe(2002);
    expect(top.expectedType).toBe('movie');
  });

  it('strips THEATRICAL EDITION before searching', () => {
    const rel = 'The Lord of the Rings The Two Towers THEATRICAL EDITION (2002).mp4';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    const cleaned = hs.find((h) => h.source === 'cleaned-prefix');
    expect(cleaned).toBeDefined();
    expect(cleaned!.title.toLowerCase()).not.toContain('theatrical');
    expect(cleaned!.title.toLowerCase()).toContain('two towers');
    expect(cleaned!.year).toBe(2002);
  });

  it('strips trailing release tags from cleaned-prefix', () => {
    const rel = 'Minority.Report.2002.1080p.BluRay.x264.YIFY.mp4';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    const cleaned = hs.find((h) => h.source === 'cleaned-prefix')!;
    expect(cleaned.title.toLowerCase()).not.toContain('1080');
    expect(cleaned.title.toLowerCase()).not.toContain('bluray');
    expect(cleaned.year).toBe(2002);
  });

  it('handles parens-wrapped junk like (BDRip 1436x1080p ...)', () => {
    const rel = 'Devilman The Birth (1987) (BDRip 1436x1080p x265 HEVC).mkv';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    const top = hs[0]!;
    expect(top.title.toLowerCase()).toContain('devilman');
    expect(top.year).toBe(1987);
    expect(top.expectedType).toBe('movie'); // year present, no S/E or season folder
  });

  it('classifies as series when under a Season folder', () => {
    const rel = 'Show/Season 1/episode_one.mkv';
    const ctx = ctxFor(rel);
    expect(ctx.underSeasonFolder).toBe(true);
    const hs = generateHypotheses(rel, ctx);
    const seriesRoot = hs.find((h) => h.source === 'series-root');
    expect(seriesRoot).toBeDefined();
    expect(seriesRoot!.title.toLowerCase()).toContain('show');
    expect(seriesRoot!.expectedType).toBe('series');
  });

  it('produces ≥3 distinct hypotheses for a typical messy filename', () => {
    const rel = 'The Bear (2022)/The.Bear.S01E01.1080p.WEB-DL.mkv';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    expect(hs.length).toBeGreaterThanOrEqual(3);
    const sources = new Set(hs.map((h) => h.source));
    expect(sources.size).toBeGreaterThanOrEqual(3);
  });

  it('dedupes hypotheses with identical (title, year, type, S, E)', () => {
    // Cleaned-prefix and basename-PTT will both extract the same thing for a clean filename.
    const rel = 'Dune.2021.mkv';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    const seen = new Set<string>();
    for (const h of hs) {
      const k = `${h.title.toLowerCase().trim()}|${h.year}|${h.expectedType}|${h.season}|${h.episode}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('hypotheses are returned in prior-descending order', () => {
    const rel = 'The Bear (2022)/Season 1/The.Bear.S01E01.mkv';
    const ctx = ctxFor(rel);
    const hs = generateHypotheses(rel, ctx);
    for (let i = 1; i < hs.length; i++) {
      expect(hs[i - 1]!.prior).toBeGreaterThanOrEqual(hs[i]!.prior);
    }
  });

  it('is pure: same input → same output', () => {
    const rel = 'A Show/Season 4/its.always.sunny.in.phila.402.dsr.xvid.notv.avi';
    const ctx = ctxFor(rel);
    const a = generateHypotheses(rel, ctx);
    const b = generateHypotheses(rel, ctx);
    expect(a).toEqual(b);
  });

  it('pathContext flags hasExplicitSE for SxxEyy basenames', () => {
    expect(pathContext('Show/The.Show.S02E05.mkv').hasExplicitSE).toBe(true);
    expect(pathContext('Show/Some.File.1x05.mkv').hasExplicitSE).toBe(true);
    expect(pathContext('Movie.2010.mkv').hasExplicitSE).toBe(false);
  });
});
