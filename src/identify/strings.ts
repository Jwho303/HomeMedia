// String utilities for identification: normalization, diacritic stripping,
// bigram-based Sørensen–Dice similarity. Pure, no I/O.

const SEPARATORS = /[._\-]+/g;
const WHITESPACE = /\s+/g;
const NON_ALNUM = /[^a-z0-9 ]+/g;

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

export function normalize(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(SEPARATORS, ' ')
    .replace(NON_ALNUM, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

export function bigrams(s: string): string[] {
  if (s.length < 2) return s.length === 1 ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === '' && nb === '') return 1;
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;

  // Multiset intersection — count duplicates correctly.
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of B) {
    const c = counts.get(g);
    if (c && c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}
