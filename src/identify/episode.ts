import { normalize } from './strings.js';

export interface KnownSeason {
  season_number: number;
  episode_count: number;
}

export interface ExtractEpisodeResult {
  season: number;
  episode: number;
}

const SXXEYY_RE = /[Ss](\d{1,2})[. _\-]*[Ee](\d{1,3})/;
const NXNN_RE = /\b(\d{1,2})x(\d{1,3})\b/;
const SEASON_EPISODE_RE = /Season\s*(\d{1,2})\s*Episode\s*(\d{1,3})/i;
const SEASON_FOLDER_RE = /^(?:season|series)[\s._\-]*(\d{1,2})$/i;

/**
 * Validate a candidate (season, episode) against TMDB's known-season list.
 *
 * Two modes via `trustUnknownSeason`:
 *  - `false` (the weak heuristics — season-folder + bare number, 3-digit
 *    shorthand): an UNKNOWN season is rejected. These patterns guess, so we
 *    only trust them when the season is confirmed to exist.
 *  - `true` (an EXPLICIT SxxEyy / NxNN / "Season X Episode Y" marker): an
 *    unknown season is ACCEPTED. A show can air a renamed or not-yet-published
 *    season (e.g. "Interview with the Vampire S03" while TMDB still lists 2) —
 *    gating those into needs_review stranded them invisibly (uncategorized-view
 *    spec §7). A KNOWN season still enforces its episode range either way, so a
 *    typo'd "S04E99" on a 13-episode season is still rejected.
 */
function withinKnownSeasons(
  s: number,
  e: number,
  known: ReadonlyArray<KnownSeason> | null,
  trustUnknownSeason = false,
): boolean {
  if (!known || known.length === 0) return true; // no known list → can't validate, accept
  const found = known.find((k) => k.season_number === s);
  if (!found) return trustUnknownSeason; // season not in TMDB's list
  return e >= 1 && e <= found.episode_count;
}

/**
 * Strip a leading series-name prefix from a basename (sans extension) so leftover
 * digits don't confuse pattern matching. Compares normalized forms and removes
 * the leading run of tokens that match the series (case-insensitive,
 * separator-tolerant). Returns the basename unchanged when there's no match.
 */
function stripSeriesPrefix(noExt: string, seriesName: string): string {
  const seriesNorm = normalize(seriesName);
  const baseNorm = normalize(noExt);
  if (seriesNorm && baseNorm.startsWith(seriesNorm)) {
    const re = new RegExp(
      '^' +
        seriesNorm
          .split(' ')
          .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[\\s._\\-]+'),
      'i',
    );
    const m = re.exec(noExt);
    if (m) return noExt.slice(m[0].length);
  }
  return noExt;
}

// A leading release-group bracket like "[HorribleSubs]" or "{Group}".
const LEADING_GROUP_RE = /^[\s._\-]*[\[\{][^\]\}]*[\]\}][\s._\-]*/;
// After the series prefix is stripped, the LEADING token is a 1–3 digit episode
// number, optionally prefixed by "E"/"#", followed by a boundary (separator,
// dash, or end). A title may follow — e.g. "053 - Long Time No See", "E045",
// "  060  ", "220 - Departure". The trailing boundary keeps it from matching the
// "200" inside "2002" (a 4-digit year fails the \d{1,3} + boundary check).
const ABSOLUTE_LEAD_RE = /^[\s._\-]*[eE#]?(\d{1,3})(?=$|[\s._\-])/;

/**
 * If a file's basename leads with an absolute (series-wide) episode number,
 * return it; otherwise null. The caller decides whether the cohort is actually
 * absolute-numbered before mapping the number through the season list.
 *
 * Handles the common anime rip shape "<Series>  053 - <Episode Title>.mkv":
 * strips a leading release-group bracket and the series-name prefix, then reads
 * the leading number even when a "- Title" tail follows. Returns null when the
 * basename carries any SxxEyy / NxNN structure, so a normal "S01E05" never looks
 * absolute.
 */
export function extractAbsoluteNumber(relPosix: string, seriesName: string): number | null {
  const basename = relPosix.split('/').pop() ?? '';
  const noExt = basename.replace(/\.[^.]+$/, '');

  // Reject explicit season/episode markers up front.
  if (SXXEYY_RE.test(noExt) || NXNN_RE.test(noExt) || SEASON_EPISODE_RE.test(noExt)) {
    return null;
  }

  // Peel a leading "[Group]" then the series prefix (groups can come before or
  // after the title in the wild).
  let s = noExt.replace(LEADING_GROUP_RE, '');
  s = stripSeriesPrefix(s, seriesName);
  s = s.replace(LEADING_GROUP_RE, '');
  s = stripSeriesPrefix(s, seriesName);

  const m = ABSOLUTE_LEAD_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  return n;
}

/**
 * Map an absolute (series-wide) episode number to a concrete (season, episode)
 * using TMDB's per-season episode counts. Season 0 (specials) is skipped — its
 * episodes don't participate in the absolute count. Returns null when the number
 * runs past the last episode of the last season (e.g. a typo, or specials the
 * user counted in).
 */
export function absoluteToSe(
  absolute: number,
  seasons: ReadonlyArray<KnownSeason> | null | undefined,
): { season: number; episode: number } | null {
  if (!seasons || seasons.length === 0 || absolute < 1) return null;
  const ordered = seasons
    .filter((s) => s.season_number >= 1 && s.episode_count > 0)
    .sort((a, b) => a.season_number - b.season_number);
  let remaining = absolute;
  for (const s of ordered) {
    if (remaining <= s.episode_count) {
      return { season: s.season_number, episode: remaining };
    }
    remaining -= s.episode_count;
  }
  return null;
}

/**
 * Inverse of absoluteToSe: given a concrete (season, episode), return its
 * series-wide absolute number by summing the episode counts of all earlier
 * seasons (specials excluded). Returns null when the season isn't in the list.
 * Used to recover episode metadata for shows whose TMDB episodes are labeled
 * with the absolute number rather than the per-season one.
 */
export function absoluteOfSe(
  season: number,
  episode: number,
  seasons: ReadonlyArray<KnownSeason> | null | undefined,
): number | null {
  if (!seasons || seasons.length === 0) return null;
  const ordered = seasons
    .filter((s) => s.season_number >= 1 && s.episode_count > 0)
    .sort((a, b) => a.season_number - b.season_number);
  let before = 0;
  for (const s of ordered) {
    if (s.season_number === season) return before + episode;
    before += s.episode_count;
  }
  return null;
}

/**
 * Extract a (season, episode) pair for a file already known to belong to a series.
 * Uses several patterns in priority order; validates against the known season list when given.
 */
export function extractEpisode(
  relPosix: string,
  seriesName: string,
  knownSeasons: ReadonlyArray<KnownSeason> | null,
): ExtractEpisodeResult | null {
  const segments = relPosix.split('/');
  const basename = segments[segments.length - 1] ?? '';
  const dirSegments = segments.slice(0, -1);
  const noExt = basename.replace(/\.[^.]+$/, '');

  const stripped = stripSeriesPrefix(noExt, seriesName);

  const tryPatterns = (s: string): ExtractEpisodeResult | null => {
    const a = SXXEYY_RE.exec(s);
    if (a) return { season: Number(a[1]), episode: Number(a[2]) };
    const b = NXNN_RE.exec(s);
    if (b) return { season: Number(b[1]), episode: Number(b[2]) };
    const c = SEASON_EPISODE_RE.exec(s);
    if (c) return { season: Number(c[1]), episode: Number(c[2]) };
    return null;
  };

  // 1) Explicit S/E in the basename (or stripped basename). An explicit
  //    SxxEyy / NxNN / "Season X Episode Y" marker is trusted even for a season
  //    TMDB doesn't list yet (trustUnknownSeason — spec uncategorized-view §7:
  //    a renamed / not-yet-published season like "S03" must not be stranded in
  //    needs_review). A KNOWN season still enforces its episode range, so a
  //    bogus "S04E99" is still rejected.
  const fromBase = tryPatterns(stripped) ?? tryPatterns(basename);
  if (fromBase && withinKnownSeasons(fromBase.season, fromBase.episode, knownSeasons, true)) {
    return fromBase;
  }

  // 2) Explicit S/E in any parent segment — same trust as (1).
  for (let i = dirSegments.length - 1; i >= 0; i--) {
    const seg = dirSegments[i]!;
    const m = tryPatterns(seg);
    if (m && withinKnownSeasons(m.season, m.episode, knownSeasons, true)) {
      return m;
    }
  }

  // 3) Season folder ('Season 4') + episode-only number from basename.
  let seasonFromFolder: number | null = null;
  for (let i = dirSegments.length - 1; i >= 0; i--) {
    const sf = SEASON_FOLDER_RE.exec(dirSegments[i]!);
    if (sf) {
      seasonFromFolder = Number(sf[1]);
      break;
    }
  }
  if (seasonFromFolder != null) {
    // Look for a 1- to 3-digit standalone episode number near common positions.
    // Avoid years (4-digit) and resolutions (e.g. 720, 1080, 2160).
    const epOnly =
      /(?:^|[\s._\-])e(\d{1,3})(?=[\s._\-]|$)/i.exec(stripped) ??
      /(?:^|[\s._\-])(\d{1,3})(?=[\s._\-]|$)/.exec(stripped);
    if (epOnly) {
      const ep = Number(epOnly[1]);
      const isResolution = ep === 720 || ep === 1080 || ep === 2160 || ep === 480 || ep === 540 || ep === 576;
      if (!isResolution && ep >= 1) {
        const candidate = { season: seasonFromFolder, episode: ep };
        if (withinKnownSeasons(candidate.season, candidate.episode, knownSeasons)) {
          return candidate;
        }
      }
    }
  }

  // 4) 3-digit `NEE` shorthand (e.g. 402 = S04E02), validated against known seasons. Pull the
  //    LAST 3-digit run in the stripped basename — usually the episode marker, not the year.
  const threeDigit = [...stripped.matchAll(/(?:^|[\s._\-(])(\d{3})(?=[\s._\-)\]]|$)/g)];
  for (const match of threeDigit.reverse()) {
    const num = Number(match[1]);
    const s = Math.floor(num / 100);
    const e = num % 100;
    if (s >= 1 && s <= 99 && e >= 1) {
      // Only accept this shorthand when the season is one we know exists; otherwise too risky.
      if (knownSeasons && withinKnownSeasons(s, e, knownSeasons)) {
        return { season: s, episode: e };
      }
    }
  }

  return null;
}
