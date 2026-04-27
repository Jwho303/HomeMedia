import path from 'node:path';
import ptt from 'parse-torrent-title';
import { indexOfFirstTag } from './release-tags.js';
import { normalize } from './strings.js';
import type { Hypothesis, PathContext } from './types.js';

const SEASON_FOLDER_RE = /^(season|series)[\s._-]*\d+$/i;
const EPISODE_FOLDER_RE = /^(episode|ep|e)[\s._-]*\d+$/i;
const SE_ONLY_FOLDER_RE = /^s\d{1,2}([\s._-]*e\d{1,3})?$/i;
const STRONG_SE_RE = /(?:[Ss]\d{1,2}[. _-]*[Ee]\d{1,3})|(?:\b\d{1,2}x\d{1,3}\b)|(?:Season\s*\d+\s*Episode\s*\d+)/;
// 4-digit year in parens or bare: 1900-2099. Bare: surrounded by separator/start/end.
const YEAR_BARE_RE = /(?:^|[\s._\-(])(19\d{2}|20\d{2})(?=[\s._\-)\]]|$)/;

export interface RawParse {
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
}

export function isSubFolderMarker(name: string): boolean {
  return SEASON_FOLDER_RE.test(name) || EPISODE_FOLDER_RE.test(name) || SE_ONLY_FOLDER_RE.test(name);
}

export function pathContext(relPosix: string, siblingNames: string[] = []): PathContext {
  const segments = relPosix.split('/');
  const dirSegments = segments.slice(0, -1);
  const basename = segments[segments.length - 1] ?? '';
  const underSeasonFolder = dirSegments.some(
    (s) => SEASON_FOLDER_RE.test(s) || SE_ONLY_FOLDER_RE.test(s),
  );
  const hasExplicitSE =
    STRONG_SE_RE.test(basename) || dirSegments.some((s) => STRONG_SE_RE.test(s));
  return { segments, underSeasonFolder, hasExplicitSE, siblingNames };
}

function withoutExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function pickYearFromString(s: string): number | null {
  const m = YEAR_BARE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

function cleanedPrefix(basename: string): string {
  // Drop extension; truncate at first release/edition tag boundary OR first 4-digit year-in-parens.
  const noExt = withoutExt(basename);
  let cut = indexOfFirstTag(noExt);
  // Also consider truncating at the year-in-parens — the year itself is information we want
  // to keep, but trailing release tags follow it. We DON'T cut at year because year is part of
  // the title's disambiguator. We DO cut at any tag.
  if (cut < 0) cut = noExt.length;
  let prefix = noExt.slice(0, cut);
  // Trim trailing separators/parens.
  prefix = prefix.replace(/[\s._\-\[\(\{]+$/g, '').trim();
  return prefix;
}

function ptParse(s: string): RawParse {
  return ptt.parse(s) as RawParse;
}

function dedupePush(out: Hypothesis[], h: Hypothesis): void {
  const key = `${normalize(h.title)}|${h.year ?? ''}|${h.expectedType}|${h.season ?? ''}|${h.episode ?? ''}`;
  for (const existing of out) {
    const ek = `${normalize(existing.title)}|${existing.year ?? ''}|${existing.expectedType}|${existing.season ?? ''}|${existing.episode ?? ''}`;
    if (ek === key) {
      // Keep the one with the higher prior; nothing else to do.
      if (h.prior > existing.prior) existing.prior = h.prior;
      return;
    }
  }
  out.push(h);
}

function classify(parsed: RawParse, ctx: PathContext): 'movie' | 'series' | 'unknown' {
  if (parsed.season != null && parsed.episode != null) return 'series';
  if (ctx.hasExplicitSE || ctx.underSeasonFolder) return 'series';
  if (parsed.year != null) return 'movie';
  return 'unknown';
}

/**
 * Generate an ordered, deduped list of candidate hypotheses for one file.
 * Pure: no I/O, no async, no randomness. Same input → same output.
 */
export function generateHypotheses(relPosix: string, ctx: PathContext): Hypothesis[] {
  const segments = relPosix.split('/');
  const basename = segments[segments.length - 1] ?? relPosix;
  const dirSegments = segments.slice(0, -1);
  const out: Hypothesis[] = [];

  // 1) Cleaned-prefix from the basename — usually the strongest signal.
  const cleanedBase = cleanedPrefix(basename);
  if (cleanedBase) {
    const parsed = ptParse(cleanedBase);
    // Year may live AFTER the tag we truncated at (e.g. "Movie THEATRICAL EDITION (2002)");
    // recover it from the full basename if the cleaned prefix didn't have one.
    const year =
      parsed.year ??
      pickYearFromString(cleanedBase) ??
      pickYearFromString(withoutExt(basename));
    const title = (parsed.title ?? cleanedBase).trim();
    if (title) {
      dedupePush(out, {
        source: 'cleaned-prefix',
        title,
        year: year ?? null,
        season: parsed.season ?? null,
        episode: parsed.episode ?? null,
        expectedType: classify(year != null ? { ...parsed, year } : parsed, ctx),
        prior: 0.85,
      });
    }
  }

  // 2) Parent folder (cleaned + parsed). Especially valuable when the basename is just
  //    `S01E01.mkv` and the parent has the show name + year.
  const parentName = dirSegments[dirSegments.length - 1];
  if (parentName && !isSubFolderMarker(parentName)) {
    const cleanedParent = cleanedPrefix(parentName);
    if (cleanedParent) {
      const parsed = ptParse(cleanedParent);
      const title = (parsed.title ?? cleanedParent).trim();
      const year = parsed.year ?? pickYearFromString(cleanedParent);
      if (title) {
        dedupePush(out, {
          source: 'parent-folder',
          title,
          year: year ?? null,
          season: parsed.season ?? null,
          episode: parsed.episode ?? null,
          expectedType: classify(year != null ? { ...parsed, year } : parsed, ctx),
          prior: 0.8,
        });
      }
    }
  }

  // 3) Series-root: highest non-marker ancestor — useful for episode files deep in
  //    `Show/Season 1/Episode 01/file.mkv`. Skips the immediate parent we already used.
  let seriesRoot: string | null = null;
  for (const seg of dirSegments) {
    if (!isSubFolderMarker(seg)) {
      seriesRoot = seg;
      break;
    }
  }
  if (seriesRoot && seriesRoot !== parentName) {
    const cleanedRoot = cleanedPrefix(seriesRoot);
    if (cleanedRoot) {
      const parsed = ptParse(cleanedRoot);
      const title = (parsed.title ?? cleanedRoot).trim();
      const year = parsed.year ?? pickYearFromString(cleanedRoot);
      if (title) {
        dedupePush(out, {
          source: 'series-root',
          title,
          year: year ?? null,
          season: parsed.season ?? null,
          episode: parsed.episode ?? null,
          expectedType: classify(year != null ? { ...parsed, year } : parsed, ctx),
          prior: 0.78,
        });
      }
    }
  }

  // 4) Plain PTT on the basename (no cleaning prefix). Catches cases where the cleaned
  //    prefix nukes too much (rare, but cheap to keep).
  {
    const parsed = ptParse(withoutExt(basename));
    const title = (parsed.title ?? '').trim();
    if (title) {
      dedupePush(out, {
        source: 'basename',
        title,
        year: parsed.year ?? null,
        season: parsed.season ?? null,
        episode: parsed.episode ?? null,
        expectedType: classify(parsed, ctx),
        prior: 0.7,
      });
    }
  }

  // 5) Normalized basename — last-resort full token sequence, lowercased & alnum-only.
  {
    const norm = normalize(withoutExt(basename));
    if (norm) {
      // If the normalized form contains a year, keep it; the title is the rest.
      const yearM = /(19\d{2}|20\d{2})/.exec(norm);
      const year = yearM ? Number(yearM[1]) : null;
      const titleNoYear = year != null ? norm.replace(String(year), '').replace(/\s+/g, ' ').trim() : norm;
      dedupePush(out, {
        source: 'normalized',
        title: titleNoYear || norm,
        year,
        season: null,
        episode: null,
        expectedType: classify(year != null ? { year } : {}, ctx),
        prior: 0.5,
      });
    }
  }

  // 6) Fallback-stripped: alphanumeric-only token sequence of the basename. Ensures we
  //    always have at least one shot when nothing else cleaned up.
  if (out.length < 3) {
    const stripped = withoutExt(basename).replace(/[^A-Za-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped) {
      dedupePush(out, {
        source: 'fallback-stripped',
        title: stripped,
        year: pickYearFromString(stripped),
        season: null,
        episode: null,
        expectedType: 'unknown',
        prior: 0.4,
      });
    }
  }

  // Order: by prior descending. (`out` is already roughly sorted by insertion priority,
  // but a stable sort by prior makes the order explicit and testable.)
  out.sort((a, b) => b.prior - a.prior);
  return out;
}
