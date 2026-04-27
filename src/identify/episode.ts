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

function withinKnownSeasons(
  s: number,
  e: number,
  known: ReadonlyArray<KnownSeason> | null,
): boolean {
  if (!known || known.length === 0) return true; // no known list → can't validate, accept
  const found = known.find((k) => k.season_number === s);
  if (!found) return false;
  return e >= 1 && e <= found.episode_count;
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

  // Strip series-name prefix from the basename so leftover digits don't confuse pattern matching.
  // Compare normalized forms; remove the leading run of tokens that match the series.
  const seriesNorm = normalize(seriesName);
  const baseNorm = normalize(noExt);
  let stripped = noExt;
  if (seriesNorm && baseNorm.startsWith(seriesNorm)) {
    // Find the index in `noExt` after the series-name tokens (case-insensitive, separator-tolerant).
    const re = new RegExp(
      '^' +
        seriesNorm
          .split(' ')
          .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[\\s._\\-]+'),
      'i',
    );
    const m = re.exec(noExt);
    if (m) stripped = noExt.slice(m[0].length);
  }

  const tryPatterns = (s: string): ExtractEpisodeResult | null => {
    const a = SXXEYY_RE.exec(s);
    if (a) return { season: Number(a[1]), episode: Number(a[2]) };
    const b = NXNN_RE.exec(s);
    if (b) return { season: Number(b[1]), episode: Number(b[2]) };
    const c = SEASON_EPISODE_RE.exec(s);
    if (c) return { season: Number(c[1]), episode: Number(c[2]) };
    return null;
  };

  // 1) Explicit S/E in the basename (or stripped basename).
  const fromBase = tryPatterns(stripped) ?? tryPatterns(basename);
  if (fromBase && withinKnownSeasons(fromBase.season, fromBase.episode, knownSeasons)) {
    return fromBase;
  }

  // 2) Explicit S/E in any parent segment.
  for (let i = dirSegments.length - 1; i >= 0; i--) {
    const seg = dirSegments[i]!;
    const m = tryPatterns(seg);
    if (m && withinKnownSeasons(m.season, m.episode, knownSeasons)) {
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
