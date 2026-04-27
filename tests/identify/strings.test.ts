import { describe, it, expect } from 'vitest';
import { normalize, similarity, stripDiacritics, bigrams } from '../../src/identify/strings.js';

describe('strings', () => {
  it('strips diacritics', () => {
    expect(stripDiacritics('Pokémon')).toBe('Pokemon');
    expect(stripDiacritics('Nausicaä')).toBe('Nausicaa');
    expect(stripDiacritics('Amélie')).toBe('Amelie');
  });

  it('normalize lowercases, replaces separators with space, strips non-alnum', () => {
    expect(normalize('Minority.Report.2002.1080p.BluRay')).toBe('minority report 2002 1080p bluray');
    expect(normalize('The Lord of the Rings: The Two Towers')).toBe('the lord of the rings the two towers');
    expect(normalize('  trim  me  ')).toBe('trim me');
  });

  it('bigrams returns adjacent character pairs', () => {
    expect(bigrams('abc')).toEqual(['ab', 'bc']);
    expect(bigrams('a')).toEqual(['a']);
    expect(bigrams('')).toEqual([]);
  });

  it('similarity is symmetric', () => {
    const pairs: Array<[string, string]> = [
      ['Minority Report', 'Minority Report'],
      ['The Bear', 'Bear, The'],
      ['Pokémon: The First Movie', 'Pokemon The First Movie'],
      ['Foo', 'Bar'],
      ['', 'something'],
    ];
    for (const [a, b] of pairs) {
      expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 12);
    }
  });

  it('similarity treats diacritic-equivalent strings as identical', () => {
    expect(similarity('Pokémon: The First Movie', 'Pokemon The First Movie')).toBeGreaterThanOrEqual(0.95);
    expect(similarity('Naïve', 'Naive')).toBe(1);
  });

  it('similarity is 1 for identical normalized titles', () => {
    expect(similarity('The Bear', 'The Bear')).toBe(1);
    expect(similarity('Minority.Report', 'Minority Report')).toBe(1);
  });

  it('similarity is 0 for empty vs non-empty', () => {
    expect(similarity('', 'abc')).toBe(0);
    expect(similarity('abc', '')).toBe(0);
  });

  it('similarity stays in [0, 1]', () => {
    const samples = [
      ['Dune', 'Dune'],
      ['Dune 2021', 'Dune Part Two'],
      ['Fight Club', 'Inception'],
      ['It', 'Up'],
    ];
    for (const [a, b] of samples) {
      const s = similarity(a!, b!);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
