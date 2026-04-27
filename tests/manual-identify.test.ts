import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-mi-unit');

const { parseLink, rowToReviewItem } = await import('../src/manual-identify.js');

describe('parseLink', () => {
  it('parses CLI-style tmdb:N', () => {
    expect(parseLink('tmdb:12345')).toEqual({ kind: 'tmdb', id: 12345 });
  });

  it('parses CLI-style tvdb:N', () => {
    expect(parseLink('tvdb:67890')).toEqual({ kind: 'tvdb', id: 67890 });
  });

  it('parses CLI-style imdb:ttN', () => {
    expect(parseLink('imdb:tt0123456')).toEqual({ kind: 'imdb', id: 'tt0123456' });
  });

  it('parses TMDB movie URL', () => {
    expect(parseLink('https://www.themoviedb.org/movie/12345-the-thing'))
      .toEqual({ kind: 'tmdb', id: 12345 });
  });

  it('parses TMDB tv URL', () => {
    expect(parseLink('https://www.themoviedb.org/tv/136315'))
      .toEqual({ kind: 'tmdb', id: 136315 });
  });

  it('parses TMDB URL without slug', () => {
    expect(parseLink('https://themoviedb.org/movie/55'))
      .toEqual({ kind: 'tmdb', id: 55 });
  });

  it('parses IMDb URL with trailing slash', () => {
    expect(parseLink('https://www.imdb.com/title/tt0167261/'))
      .toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('parses IMDb URL with locale prefix', () => {
    expect(parseLink('https://www.imdb.com/en/title/tt0167261/'))
      .toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('parses bare tt-id', () => {
    expect(parseLink('tt0167261')).toEqual({ kind: 'imdb', id: 'tt0167261' });
  });

  it('rejects bare numeric (ambiguous tmdb vs tvdb)', () => {
    expect(parseLink('12345')).toBeNull();
  });

  it('rejects empty / whitespace input', () => {
    expect(parseLink('')).toBeNull();
    expect(parseLink('   ')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(parseLink('not a link')).toBeNull();
  });

  it('rejects retitle / skip / quit kinds', () => {
    expect(parseLink('t:Some Title')).toBeNull();
    expect(parseLink('skip')).toBeNull();
    expect(parseLink('quit')).toBeNull();
  });

  it('handles whitespace around inputs', () => {
    expect(parseLink('  tmdb:42  ')).toEqual({ kind: 'tmdb', id: 42 });
  });
});

describe('rowToReviewItem', () => {
  it('builds a synthetic ReviewItemRow for an existing media row', () => {
    const r = rowToReviewItem({ path: 'foo.mkv', mtime: 1000, scanned_at: 2000 });
    expect(r.path).toBe('foo.mkv');
    expect(r.reason).toBe('manual_identify');
    expect(r.candidates).toBe('[]');
    expect(r.scanned_at).toBe(2000);
    expect(r.added_at).toBe(2000);
  });
});
