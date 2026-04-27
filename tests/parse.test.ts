import { describe, it, expect } from 'vitest';
import { parseFilename } from '../src/parse.js';

describe('parseFilename', () => {
  it('extracts S01E01', () => {
    const r = parseFilename('The Bear/The.Bear.S01E01.1080p.x264-GROUP.mkv');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
    expect(r.title).toBe('The Bear');
  });

  it('extracts 1x01', () => {
    const r = parseFilename('Show/Show.1x01.mkv');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
  });

  it('extracts Season 1 Episode 1', () => {
    const r = parseFilename('Show/Show Season 1 Episode 1.mkv');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
  });

  it('extracts s01.e01 (fallback regex)', () => {
    const r = parseFilename('Show/Show.s01.e01.mkv');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(1);
  });

  it('extracts movie title + year, no season/episode', () => {
    const r = parseFilename('Dune.2021.1080p.BluRay.x264.mkv');
    expect(r.title).toBe('Dune');
    expect(r.year).toBe(2021);
    expect(r.season).toBeNull();
    expect(r.episode).toBeNull();
  });

  it('returns nulls for season/episode/year on a bare title', () => {
    const r = parseFilename('Some Mystery File.mkv');
    expect(r.season).toBeNull();
    expect(r.episode).toBeNull();
    expect(r.year).toBeNull();
  });

  it('uses only the basename, not the full path', () => {
    const r = parseFilename('S01E99/Dune.2021.mkv');
    expect(r.season).toBeNull();
    expect(r.year).toBe(2021);
  });
});
