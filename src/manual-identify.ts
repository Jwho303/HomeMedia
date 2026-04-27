import { parseAction, type ReviewAction } from './cli/review-core.js';
import type { DbHandle, MediaItemRow, EpisodeRow, ReviewItemRow } from './db.js';

const TMDB_URL_RE = /^https?:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)/i;
const IMDB_URL_RE = /^https?:\/\/(?:www\.)?imdb\.com\/(?:[a-z-]+\/)?title\/(tt\d{5,})/i;

export type LinkAction = Extract<
  ReviewAction,
  { kind: 'tmdb' } | { kind: 'tvdb' } | { kind: 'imdb' }
>;

/**
 * Parse a "paste a link" string into a `ReviewAction`. Accepts:
 *  - `tmdb:12345`, `tvdb:67890`, `imdb:tt0123456` (CLI-style)
 *  - `https://www.themoviedb.org/{movie,tv}/12345-slug`
 *  - `https://www.imdb.com/title/tt0123456/` (with or without locale prefix)
 *  - bare `tt0123456`
 *
 * Returns null for empty input, URLs of unrecognized shape, or kinds the
 * modal does not support (skip/quit/retitle/invalid). Bare numeric input is
 * rejected as ambiguous (could be TMDB or TVDB id).
 */
export function parseLink(raw: string): LinkAction | null {
  const s = raw.trim();
  if (!s) return null;

  const tmdbUrl = TMDB_URL_RE.exec(s);
  if (tmdbUrl) {
    return { kind: 'tmdb', id: Number(tmdbUrl[2]) };
  }
  const imdbUrl = IMDB_URL_RE.exec(s);
  if (imdbUrl) {
    return { kind: 'imdb', id: imdbUrl[1]!.toLowerCase() };
  }

  if (/^\d+$/.test(s)) return null;

  const action = parseAction(s);
  switch (action.kind) {
    case 'tmdb':
    case 'tvdb':
    case 'imdb':
      return action;
    default:
      return null;
  }
}

/**
 * Build a synthetic `ReviewItemRow` from an existing `media_items` or `episodes`
 * row so that `applyChoice()` (which was designed for needs_review entries) can
 * persist a manual override against an already-identified file.
 */
export function rowToReviewItem(row: { path: string; mtime: number; scanned_at: number }): ReviewItemRow {
  return {
    path: row.path,
    reason: 'manual_identify',
    candidates: '[]',
    added_at: row.scanned_at,
    scanned_at: row.scanned_at,
  };
}

/**
 * Look up either a movie media_item, a series media_item, or an episode by id.
 * Returns the `MediaItemRow` or `EpisodeRow` and a discriminating kind, or null
 * if no row with that id exists in the requested table.
 */
export function getItemById(
  db: DbHandle,
  id: number,
): MediaItemRow | undefined {
  return db.raw
    .prepare<[number], MediaItemRow>('SELECT * FROM media_items WHERE id = ?')
    .get(id);
}

export function getEpisodeById(
  db: DbHandle,
  id: number,
): EpisodeRow | undefined {
  return db.raw
    .prepare<[number], EpisodeRow>('SELECT * FROM episodes WHERE id = ?')
    .get(id);
}
