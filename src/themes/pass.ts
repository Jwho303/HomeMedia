/**
 * Theme pass (0.2.1): turn stored episode fingerprints into per-episode skip
 * markers. Pure CPU over DB rows — never calls ffmpeg.
 *
 * Per show, per kind (opening / ending), season by season:
 *   1. If the season already has linked themes, use them.
 *   2. Otherwise try every theme already known for the show; link the first
 *      one that hits enough of the season's episodes.
 *   3. Otherwise learn a new theme from the season and link it.
 *   4. Locate the theme in every episode. Episodes that miss everything get
 *      another learning round among themselves (a theme change mid-season).
 */

import type { DbHandle } from '../db.js';
import { ITEM_S, KIND_PARAMS, MATCH_PARAMS, locate, longestShared, type KindParams, type MatchParams, type ThemeKind } from './match.js';
import {
  insertTheme,
  linkSeasonTheme,
  listSeasonThemeIds,
  listSeriesEpisodeFps,
  listThemes,
  writeMarkers,
  type EpisodeFpRow,
  type Markers,
  type ThemeRow,
} from './store.js';

/** Bump to recompute every episode's markers (e.g. after tuning the matcher). */
export const MARKERS_VERSION = 1;

/** Episodes considered when learning a theme, and when testing a known one. */
const LEARN_SAMPLE = 4;
const TEST_SAMPLE = 6;
/** Rounds of re-learning among episodes that missed every known theme. */
const MAX_RELEARN_ROUNDS = 3;
/** A longer learned candidate beats the most-hitting one if it hits at least this share as many. */
const LONGER_WINS_RATIO = 0.75;

export interface PassOptions {
  kinds?: Record<ThemeKind, KindParams>;
  match?: MatchParams;
  /** Recompute every episode, not only stale ones. */
  force?: boolean;
}

export interface PassResult {
  seasons: number;
  themesLearned: number;
  episodesMarked: number;
  episodesWithIntro: number;
  episodesWithCredits: number;
}

interface Candidate {
  fingerprint: Uint32Array;
  learnedFrom: number;
}

const windowOf = (ep: EpisodeFpRow, kind: ThemeKind): Uint32Array | null => (kind === 'opening' ? ep.head : ep.tail);

function hits(theme: Uint32Array, eps: EpisodeFpRow[], kind: ThemeKind, p: MatchParams): number {
  let n = 0;
  for (const ep of eps) {
    const w = windowOf(ep, kind);
    if (w && locate(w, theme, p)) n++;
  }
  return n;
}

/**
 * Learn a theme shared by enough of these episodes. Tries every pair among
 * the first few. Prefers the candidate that hits the most episodes, but a
 * longer candidate wins if it hits nearly as many — otherwise a short sting
 * inside the opening (a logo, the first bars) beats the full theme.
 */
export function learnTheme(eps: EpisodeFpRow[], kind: ThemeKind, kp: KindParams, p: MatchParams): Candidate | null {
  const withFp = eps.filter((e) => windowOf(e, kind));
  if (withFp.length < 2) return null;
  const sample = withFp.slice(0, LEARN_SAMPLE);
  const test = withFp.slice(0, TEST_SAMPLE);
  const cands: Array<{ c: Candidate; hits: number; len: number }> = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = windowOf(sample[i]!, kind)!;
      const b = windowOf(sample[j]!, kind)!;
      const chain = longestShared(a, b, kp, p);
      if (!chain) continue;
      const fp = a.slice(chain.aStart, chain.aEnd);
      cands.push({ c: { fingerprint: fp, learnedFrom: sample[i]!.episodeId }, hits: hits(fp, test, kind, p), len: chain.matched });
    }
  }
  if (cands.length === 0) return null;
  const top = Math.max(...cands.map((c) => c.hits));
  const floor = Math.max(2, Math.ceil(top * LONGER_WINS_RATIO));
  const ok = cands.filter((c) => c.hits >= floor);
  if (ok.length === 0) return null;
  ok.sort((x, y) => y.len - x.len || y.hits - x.hits);
  return ok[0]!.c;
}

/** Run the pass for one show. */
export function runThemePass(db: DbHandle, seriesId: number, opts: PassOptions = {}): PassResult {
  const kinds = opts.kinds ?? KIND_PARAMS;
  const p = opts.match ?? MATCH_PARAMS;
  const result: PassResult = { seasons: 0, themesLearned: 0, episodesMarked: 0, episodesWithIntro: 0, episodesWithCredits: 0 };

  const all = listSeriesEpisodeFps(db, seriesId);
  const bySeason = new Map<number, EpisodeFpRow[]>();
  for (const ep of all) {
    const list = bySeason.get(ep.season) ?? [];
    list.push(ep);
    bySeason.set(ep.season, list);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);

  const run = db.raw.transaction(() => {
    const known: Record<ThemeKind, ThemeRow[]> = {
      opening: listThemes(db, seriesId, 'opening'),
      ending: listThemes(db, seriesId, 'ending'),
    };
    /** Final markers per episode, written once at the end. */
    const out = new Map<number, Markers>();

    const learn = (eps: EpisodeFpRow[], season: number, kind: ThemeKind): ThemeRow | null => {
      const c = learnTheme(eps, kind, kinds[kind], p);
      if (!c) return null;
      const durationS = c.fingerprint.length * ITEM_S;
      const id = insertTheme(db, { seriesId, kind, fingerprint: c.fingerprint, durationS, learnedFrom: c.learnedFrom });
      const row: ThemeRow = { id, kind, fingerprint: c.fingerprint, durationS };
      known[kind].push(row);
      linkSeasonTheme(db, seriesId, season, id);
      result.themesLearned++;
      return row;
    };

    const processSeason = (season: number, allowLearn: boolean): void => {
      const eps = bySeason.get(season)!;
      const found: Record<ThemeKind, Map<number, { startS: number; endS: number }>> = { opening: new Map(), ending: new Map() };

      for (const kind of ['opening', 'ending'] as const) {
        const linkedIds = new Set(listSeasonThemeIds(db, seriesId, season, kind));
        let linked = known[kind].filter((t) => linkedIds.has(t.id));

        if (linked.length === 0 && allowLearn) {
          const test = eps.filter((e) => windowOf(e, kind)).slice(0, TEST_SAMPLE);
          const need = Math.min(2, test.length);
          const reuse = need > 0 ? known[kind].find((t) => hits(t.fingerprint, test, kind, p) >= need) : undefined;
          if (reuse) {
            linkSeasonTheme(db, seriesId, season, reuse.id);
            linked = [reuse];
          } else {
            const fresh = learn(eps, season, kind);
            if (fresh) linked = [fresh];
          }
        }

        // For each episode, the longest match among `themes` (a short sting
        // and the full theme can both hit; the full theme is what to skip).
        const tryLocate = (themes: ThemeRow[], targets: EpisodeFpRow[]): EpisodeFpRow[] => {
          const missed: EpisodeFpRow[] = [];
          for (const ep of targets) {
            const w = windowOf(ep, kind);
            if (!w) continue;
            let best: { startS: number; endS: number; theme: ThemeRow } | null = null;
            for (const t of themes) {
              const l = locate(w, t.fingerprint, p);
              if (l && (!best || l.endS - l.startS > best.endS - best.startS)) best = { ...l, theme: t };
            }
            if (best) {
              if (!linked.includes(best.theme)) {
                linkSeasonTheme(db, seriesId, season, best.theme.id);
                linked.push(best.theme);
              }
              const off = kind === 'ending' ? ep.tailOffsetS : 0;
              found[kind].set(ep.episodeId, { startS: best.startS + off, endS: best.endS + off });
            } else {
              missed.push(ep);
            }
          }
          return missed;
        };

        // Linked themes first, then every other known theme.
        let missed = tryLocate(linked, eps);
        missed = tryLocate(known[kind].filter((t) => !linked.includes(t)), missed);
        // A season that changes theme part-way: learn again among the misses.
        for (let round = 0; allowLearn && round < MAX_RELEARN_ROUNDS && missed.length >= 2; round++) {
          const fresh = learn(missed, season, kind);
          if (!fresh) break;
          missed = tryLocate([fresh], missed);
        }
      }

      for (const ep of eps) {
        const o = found.opening.get(ep.episodeId);
        const e = found.ending.get(ep.episodeId);
        out.set(ep.episodeId, {
          introStart: o ? round1(o.startS) : null,
          introEnd: o ? round1(o.endS) : null,
          creditsStart: e ? round1(e.startS) : null,
          creditsEnd: e ? round1(e.endS) : null,
        });
      }
    };

    const stale = seasons.filter((s) => opts.force || bySeason.get(s)!.some((e) => e.markersVersion !== MARKERS_VERSION));
    for (const season of stale) processSeason(season, true);
    // A theme learned in a later season can also play in earlier ones (or
    // be the full version of a short sting learned earlier): re-locate every
    // season against everything known, without learning more.
    if (result.themesLearned > 0) for (const season of seasons) processSeason(season, false);

    result.seasons = stale.length;
    for (const [id, m] of out) {
      writeMarkers(db, id, m, MARKERS_VERSION);
      result.episodesMarked++;
      if (m.introStart != null) result.episodesWithIntro++;
      if (m.creditsStart != null) result.episodesWithCredits++;
    }
  });
  run();
  return result;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
