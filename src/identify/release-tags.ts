// Release-quality tags and edition tags. The cleaned-prefix hypothesis truncates a
// basename at the first occurrence of any tag token; downstream hypotheses compare
// against these sets too. Patterns are case-insensitive, matched as whole-ish tokens.

export const RELEASE_TAGS: readonly string[] = [
  // resolutions
  '2160p', '1440p', '1080p', '720p', '576p', '540p', '480p', '4k', 'uhd',
  // sources
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'webrip', 'web-dl', 'webdl', 'web',
  'hdtv', 'hdrip', 'dvdrip', 'dvdscr', 'screener', 'cam', 'ts',
  'remux', 'remastered',
  // codecs
  'x264', 'x265', 'h264', 'h.264', 'h265', 'h.265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  // audio
  'aac', 'ac3', 'dts', 'dts-hd', 'dtshd', 'truehd', 'atmos', 'flac', 'mp3',
  'ddp5.1', 'ddp', 'ddp2.0', 'dd5.1', 'dd2.0', 'eac3', '5.1', '7.1', '2.0',
  // tv broadcast
  'dsr', 'pdtv', 'sdtv',
  // misc/groups
  'yify', 'rarbg', 'ettv', 'eztv', 'notv', 'fov', 'lol',
  // hdr
  'hdr', 'hdr10', 'dolby', 'vision', 'sdr',
];

export const EDITION_TAGS: readonly string[] = [
  'theatrical edition', 'theatrical cut', 'theatrical',
  'extended edition', 'extended cut', 'extended',
  "director's cut", 'directors cut', 'director cut',
  'unrated', 'uncut', 'uncensored',
  'imax', 'imax edition',
  'special edition', 'collector’s edition', 'collectors edition',
  'final cut', 'remastered',
  'repack', 'proper', 'real-proper',
  'multi', 'dubbed', 'dubbed.subbed', 'subbed',
  'ws', 'open matte', 'limited',
  'criterion', 'criterion collection',
];

// Lowercased, NFD-stripped versions for matching against normalized strings.
function lower(arr: readonly string[]): readonly string[] {
  return arr.map((s) => s.toLowerCase());
}

export const RELEASE_TAGS_LOWER = lower(RELEASE_TAGS);
export const EDITION_TAGS_LOWER = lower(EDITION_TAGS);

// Build a single regex that matches any tag (release OR edition) as a token boundary.
// Tags can include dots (`h.264`) and apostrophes (`director's cut`); we escape regex
// metachars and let the tag itself dictate separators it requires.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALL_TAGS_LOWER = [...EDITION_TAGS_LOWER, ...RELEASE_TAGS_LOWER]
  // sort longest-first so multi-word tags match before their prefixes (`theatrical edition` before `theatrical`).
  .slice()
  .sort((a, b) => b.length - a.length);

const TAG_BOUNDARY_RE = new RegExp(
  // Match at a word boundary, OR after a separator (.,_,-,space,(,[,{) — torrent filenames
  // typically separate tokens with these. Followed by the tag.
  String.raw`(?:^|[\s._\-\[\(\{])(` + ALL_TAGS_LOWER.map(escapeRe).join('|') + String.raw`)(?=$|[\s._\-\]\)\}])`,
  'i',
);

/**
 * Find the index of the first release/edition tag in `s` (using the original casing/separators).
 * Returns the index of the tag itself (not the leading separator) or -1 if none.
 */
export function indexOfFirstTag(s: string): number {
  const m = TAG_BOUNDARY_RE.exec(s);
  if (!m) return -1;
  // m.index is at the leading boundary; skip the boundary char if any.
  const lead = m[0]!.length - m[1]!.length;
  return m.index + lead;
}
