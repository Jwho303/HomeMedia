import ptt from 'parse-torrent-title';
import path from 'node:path';

export interface ParsedFilename {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
}

interface RawParse {
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
}

// Catches patterns parse-torrent-title v2 misses, notably `s01.e01` where the dot separator
// breaks its default season+episode regex. We only use this as a fallback when PTT returned
// a season but no episode.
const FALLBACK_SE = /[Ss](\d{1,2})[. _-]*[Ee](\d{1,3})/;

// PTT sometimes treats resolution dimensions like "1436x1080p" as season×episode. Reject
// season/episode pairs that look like they came from a resolution match — episode numbers
// over 999 don't exist, and a large NxN substring with a trailing "p" is the smoking gun.
const RESOLUTION_SHAPE = /\d{3,4}x\d{3,4}p?/i;
// Strong-signal series patterns: explicit S01E01 / 1x01 / Season 1 Episode 1. If the basename
// matches one of these, we trust season+episode came from there, not from a resolution.
const STRONG_SE = /(?:[Ss]\d{1,2}[. _-]*[Ee]\d{1,3})|(?:\b\d{1,2}x\d{1,3}\b)|(?:Season\s*\d+\s*Episode\s*\d+)/i;

function looksLikeResolutionMistake(basename: string, season: number, episode: number): boolean {
  if (STRONG_SE.test(basename)) return false;          // explicit S/E present — trust it
  if (episode >= 1000) return true;                    // no series has 4-digit episode numbers
  if (RESOLUTION_SHAPE.test(basename)) return true;    // resolution-shape overlap with no strong S/E
  return false;
}

export function parseFilename(relPosix: string): ParsedFilename {
  const basename = path.posix.basename(relPosix);
  const raw = ptt.parse(basename) as RawParse;

  let season = raw.season ?? null;
  let episode = raw.episode ?? null;

  if (season != null && episode == null) {
    const m = FALLBACK_SE.exec(basename);
    if (m) {
      const sFromRegex = Number(m[1]);
      const eFromRegex = Number(m[2]);
      if (sFromRegex === season) episode = eFromRegex;
    }
  }

  if (season != null && episode != null && looksLikeResolutionMistake(basename, season, episode)) {
    season = null;
    episode = null;
  }

  return {
    title: (raw.title ?? '').trim(),
    year: raw.year ?? null,
    season,
    episode,
  };
}
