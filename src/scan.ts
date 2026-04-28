import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { status as shareStatus, ShareOfflineError } from './share.js';
import { toNativeAbsolute, toPosixRelative } from './paths.js';
import { getDb, type DbHandle, type MediaItemRow } from './db.js';
import { parseFilename } from './parse.js';
import * as tmdb from './tmdb.js';
import { tmdbSource, type Source } from './identify/sources.js';
import { probeFile, type ProbeFileDeps, type ProbeStatus } from './prober.js';
import type { ProgressEmitter } from './scan-progress.js';
import {
  groupIntoCohorts,
  identifyCohort,
  fitFileIntoCohort,
  type Cohort,
  type CohortIdentity,
  type FileEntry,
  type IdentifyDeps,
  type LibraryLookup,
  type LibraryMatch,
} from './identify/cohorts.js';
import { type KnownSeason } from './identify/episode.js';
import { similarity } from './identify/strings.js';
import { createOmdbSource, createOmdbRatingFetcher } from './identify/sources/omdb.js';
import { createTvdbSource } from './identify/sources/tvdb.js';
import { createBudgetTracker } from './identify/budget.js';
import { passBIdentify, type PassBSources } from './identify/passB.js';
import { applyIdentity } from './identify/apply.js';

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const EXTRAS_FOLDER = /^(featurettes?|extras?|bonus|bonus[ _-]?features?|behind[ _-]?the[ _-]?scenes|deleted[ _-]?scenes?|outtakes?|trailers?|interviews?|box[ _-]?set[ _-]?extras?)$/i;

function isUnderExtrasFolder(relPosix: string): boolean {
  const segments = relPosix.split('/').slice(0, -1);
  return segments.some((s) => EXTRAS_FOLDER.test(s));
}

const SEASON_FOLDER = /^(season|series)[\s._-]*\d+$/i;
const EPISODE_FOLDER = /^(episode|ep|e)[\s._-]*\d+$/i;
const SE_ONLY_FOLDER = /^s\d{1,2}([\s._-]*e\d{1,3})?$/i;

function isSubFolderMarker(name: string): boolean {
  return SEASON_FOLDER.test(name) || EPISODE_FOLDER.test(name) || SE_ONLY_FOLDER.test(name);
}

function findSeriesKey(relPosix: string, parsedTitle: string): { key: string; folderName: string | null } {
  const segments = relPosix.split('/').slice(0, -1);
  if (segments.length === 0) {
    return { key: `__title__:${parsedTitle.toLowerCase()}`, folderName: null };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!isSubFolderMarker(seg)) {
      const seriesPath = segments.slice(0, i + 1).join('/');
      const folderParse = parseFilename(seg);
      if (folderParse.season != null && folderParse.episode != null && folderParse.title) {
        return { key: `__title__:${folderParse.title.toLowerCase()}`, folderName: folderParse.title };
      }
      return { key: seriesPath, folderName: seg };
    }
  }
  return { key: `__title__:${parsedTitle.toLowerCase()}`, folderName: null };
}

export interface ScanOptions {
  full?: boolean;
  dryRun?: boolean;
  /** Disable identifier early-bail; re-evaluate every hypothesis. */
  aggressive?: boolean;
}

export interface ScanResult {
  added: number;
  updated: number;
  stale: number;
  errors: number;
  scanned: number;
  needsReview: number;
  /** Number of needs_review items that Pass B promoted to media_items. */
  rescuedByPassB?: number;
  /** Number of files identified via a manual override (D4). */
  manualOverridesApplied?: number;
  /** 0.1.4.3 — number of files for which the prober ran during this scan
   *  (i.e. ProbeStatus === 'reprobed'). Stays 0 on a no-change refresh. */
  probed?: number;
}

export interface ScanLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: ScanLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface WalkedFile {
  absPath: string;
  mtime: number;
}

async function* walk(root: string): AsyncGenerator<WalkedFile> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        try {
          const st = await fs.stat(full);
          yield { absPath: full, mtime: Math.floor(st.mtimeMs) };
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 0.1.5.1 — diff-and-gate helpers for smart refresh.
// ---------------------------------------------------------------------------

interface DbPathRow {
  mtime: number;
  kind: 'movie' | 'episode' | 'media-file' | 'review';
}

/** Build an in-memory map of every (path, mtime) the DB knows about. Walks
 *  the four tables that can hold a path-mtime pair (media_items for movies,
 *  episodes, media_files, needs_review). Cheap — bounded by library size. */
export function buildDbPathIndex(db: DbHandle): Map<string, DbPathRow> {
  const out = new Map<string, DbPathRow>();
  const movies = db.raw
    .prepare<[], { path: string; mtime: number }>(
      `SELECT path, mtime FROM media_items WHERE type = 'movie'`,
    )
    .all();
  for (const r of movies) out.set(r.path, { mtime: r.mtime, kind: 'movie' });
  const eps = db.raw
    .prepare<[], { path: string; mtime: number }>(`SELECT path, mtime FROM episodes`)
    .all();
  for (const r of eps) out.set(r.path, { mtime: r.mtime, kind: 'episode' });
  const mfs = db.raw
    .prepare<[], { path: string; mtime: number }>(`SELECT path, mtime FROM media_files`)
    .all();
  for (const r of mfs) {
    // media_files is the canonical "playable file exists" table — overwrite
    // any movie entry from media_items so we use the file-level mtime.
    out.set(r.path, { mtime: r.mtime, kind: 'media-file' });
  }
  const reviews = db.raw
    .prepare<[], { path: string; mtime: number }>(
      `SELECT path, scanned_at AS mtime FROM needs_review`,
    )
    .all();
  for (const r of reviews) {
    if (!out.has(r.path)) out.set(r.path, { mtime: r.mtime, kind: 'review' });
  }
  return out;
}

interface DiffResult {
  newOrChanged: FileEntry[];
  disappeared: string[];
}

/** Diff the files we just walked off disk against the DB's known paths.
 *  Pure — no I/O. */
export function diffPaths(
  disk: FileEntry[],
  dbIndex: Map<string, DbPathRow>,
): DiffResult {
  const onDisk = new Set(disk.map((f) => f.relPosix));
  const newOrChanged: FileEntry[] = [];
  for (const f of disk) {
    const known = dbIndex.get(f.relPosix);
    if (!known || known.mtime !== f.mtime) newOrChanged.push(f);
  }
  const disappeared: string[] = [];
  for (const p of dbIndex.keys()) {
    if (!onDisk.has(p)) disappeared.push(p);
  }
  return { newOrChanged, disappeared };
}

/** Bump scanned_at on every existing row that points at one of `files`.
 *  Used by smart refresh to mark on-disk-but-unchanged rows as "still here"
 *  without otherwise touching them. Mirrors `tryFastSkip()`'s update logic. */
function bumpScannedAtForFiles(db: DbHandle, files: FileEntry[], startedAt: number): void {
  const updItem = db.raw.prepare(`UPDATE media_items SET scanned_at = ? WHERE id = ?`);
  const updEp = db.raw.prepare(`UPDATE episodes SET scanned_at = ? WHERE path = ?`);
  const updMf = db.raw.prepare(`UPDATE media_files SET scanned_at = ? WHERE path = ?`);
  const updReview = db.raw.prepare(`UPDATE needs_review SET scanned_at = ? WHERE path = ?`);
  const tx = db.raw.transaction((items: FileEntry[]) => {
    for (const f of items) {
      const ep = db.getEpisodeByPath(f.relPosix);
      if (ep) {
        updEp.run(startedAt, f.relPosix);
        updItem.run(startedAt, ep.series_id);
        continue;
      }
      const mf = db.getMediaFileByPath(f.relPosix);
      if (mf) {
        updMf.run(startedAt, f.relPosix);
        updItem.run(startedAt, mf.item_id);
        continue;
      }
      const item = db.getByPath(f.relPosix);
      if (item) {
        updItem.run(startedAt, item.id);
        continue;
      }
      const review = db.getReviewItem(f.relPosix);
      if (review) updReview.run(startedAt, f.relPosix);
    }
  });
  tx(files);
}

/** Mutable monotonic counter used to drive SSE `file` / `probe` events. The
 *  denominator covers identify+persist+probe phases per file × the number of
 *  files in the scan. We tick once per emitted event so the user sees the
 *  number climb steadily. */
interface FileCounter {
  next(): number;
  total: number;
}

function makeFileCounter(fileCount: number): FileCounter {
  // Per file, a smart/hard refresh emits at most three ticks:
  //   1. identify  (per file)
  //   2. persist   (per file)
  //   3. probe     (per file)
  // Picking the worst-case as the denominator keeps the counter monotone
  // and never overshoots the displayed maximum.
  let i = 0;
  const total = Math.max(1, fileCount * 3);
  return {
    next(): number {
      i = Math.min(total, i + 1);
      return i;
    },
    total,
  };
}

interface TmdbDeps {
  searchMulti: typeof tmdb.searchMulti;
  getSeries: typeof tmdb.getSeries;
  getEpisodes: typeof tmdb.getEpisodes;
  posterUrl: typeof tmdb.posterUrl;
  stillUrl: typeof tmdb.stillUrl;
  /** Optional — manual override hydration calls this if title isn't already cached. */
  getMovie?: typeof tmdb.getMovie;
  /** Optional — used by Pass B to resolve an IMDb id to a TMDB record. */
  findByImdbId?: typeof tmdb.findByImdbId;
  /** 0.1.8 — IMDb id resolver per TMDB id. Used by the rating-fetch path
   *  (cohort-identified items don't carry imdbId; we ask TMDB for it before
   *  hitting OMDb). */
  getMovieExternalIds?: typeof tmdb.getMovieExternalIds;
  getSeriesExternalIds?: typeof tmdb.getSeriesExternalIds;
}

/** 0.1.8 — IMDb rating fetcher dependency. Returns null on miss (unknown
 *  imdbId, network error, OMDb quota exhausted) — call site treats absence
 *  as "leave existing DB value alone". */
export interface RatingDeps {
  fetchRating(imdbId: string): Promise<{ rating: number; votes: number | null } | null>;
}

export interface ScanDeps {
  db?: DbHandle;
  mediaRoot?: string;
  tmdb?: TmdbDeps;
  logger?: ScanLogger;
  share?: typeof shareStatus;
  /** Override OMDb source (for tests / disabling). When undefined, built from config. */
  omdbSource?: Source | null;
  /** Override TVDB source. */
  tvdbSource?: Source | null;
  /** 0.1.8 — Override IMDb rating fetcher (for tests / disabling). When undefined
   *  and `OMDB_API_KEY` is set, built from config alongside the OMDb source. */
  ratingFetcher?: RatingDeps | null;
  /** 0.1.4.3 — overrides for the per-file prober. Tests inject a fake probe()
   *  to avoid spawning ffprobe. */
  proberDeps?: ProbeFileDeps;
  /** 0.1.5.1 — optional progress channel. The scan emits walk/diff/file/probe
   *  events via this emitter; the SSE route consumes them. No-op when unset. */
  progress?: ProgressEmitter;
}

/** Strip the TMDB CDN base off a stored poster_url, leaving the bare
 *  `/abc.jpg` path that `t.posterUrl()` expects. Returns null for non-TMDB
 *  or already-bare URLs (we only carry forward CDN-prefixed values, since
 *  `posterUrl()` would corrupt anything else). */
function stripTmdbPosterBase(stored: string | null): string | null {
  if (!stored) return null;
  const m = stored.match(/^https?:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/.+)$/);
  return m ? (m[1] ?? null) : null;
}

function buildLibraryLookup(db: DbHandle): LibraryLookup {
  const startedAt = db.latestScannedAt();
  // Pull every non-stale series row up-front (cheap; bounded by library size).
  const rows = db.raw
    .prepare<[number], MediaItemRow>(
      `SELECT * FROM media_items WHERE type = 'series' AND scanned_at >= ? AND tmdb_id IS NOT NULL`,
    )
    .all(startedAt);
  return (seedTitle: string): LibraryMatch[] => {
    if (!seedTitle) return [];
    const out: LibraryMatch[] = [];
    for (const r of rows) {
      if (similarity(seedTitle, r.title ?? '') >= 0.7) {
        out.push({
          tmdbId: r.tmdb_id!,
          type: r.type as 'movie' | 'series',
          title: r.title ?? '',
          year: r.year,
          // 0.1.5.1+: carry forward the existing TMDB poster path so a
          // library-tiebreaker D5 win doesn't wipe poster_url back to null
          // when the persist UPDATE runs.
          posterPath: stripTmdbPosterBase(r.poster_url),
          backdropPath: stripTmdbPosterBase(r.backdrop_url),
          overview: r.overview,
        });
      }
    }
    return out;
  };
}

export async function scan(opts: ScanOptions = {}, deps: ScanDeps = {}): Promise<ScanResult> {
  const db = deps.db ?? getDb();
  const mediaRoot = deps.mediaRoot ?? config.mediaRoot;
  const t = deps.tmdb ?? tmdb;
  const log = deps.logger ?? noopLogger;
  const share = deps.share ?? shareStatus;
  const source: Source = tmdbSource(t);
  const progress = deps.progress;
  // 0.1.8 — IMDb rating fetcher. Built once per scan, shared budget with the
  // OMDb identification source so a heavy Pass B + a rating refresh don't
  // both blow through the daily quota.
  const ratingFetcher: RatingDeps | null =
    deps.ratingFetcher !== undefined
      ? deps.ratingFetcher
      : config.omdbApiKey
      ? createOmdbRatingFetcher({
          apiKey: config.omdbApiKey,
          budget: createBudgetTracker(config.omdbBudgetPath, 1000),
        })
      : null;

  const s = await share(mediaRoot);
  if (!s.online) throw new ShareOfflineError(mediaRoot);

  const startedAt = Date.now();
  const result: ScanResult = {
    added: 0,
    updated: 0,
    stale: 0,
    errors: 0,
    scanned: 0,
    needsReview: 0,
    rescuedByPassB: 0,
    manualOverridesApplied: 0,
    probed: 0,
  };

  // 1. Walk everything first.
  const allFilesWalked: FileEntry[] = [];
  for await (const file of walk(mediaRoot)) {
    const relPosix = toPosixRelative(file.absPath, mediaRoot);
    if (isUnderExtrasFolder(relPosix)) continue;
    allFilesWalked.push({ relPosix, mtime: file.mtime });
    result.scanned++;
  }
  progress?.emit({ type: 'walk', scanned: result.scanned });

  if (allFilesWalked.length === 0) {
    progress?.emit({ type: 'diff', dirty: 0, disappeared: 0, total: 0 });
    return result;
  }

  // 1.5. Apply manual overrides BEFORE any identification (D4). Overridden files are
  // pulled out of the cohort pipeline entirely.
  const allFiles: FileEntry[] = [];
  for (const f of allFilesWalked) {
    const override = db.getManualOverride(f.relPosix);
    if (!override) {
      allFiles.push(f);
      continue;
    }
    try {
      // Hydrate identity from existing row if we have one for this tmdb_id; otherwise
      // fetch from TMDB once. The override's tmdb_id is canonical.
      const existing = db.getByTmdbId(override.tmdb_id, override.type);
      let title = existing?.title ?? '';
      let year = existing?.year ?? null;
      let posterUrl = existing?.poster_url ?? null;
      let backdropUrl = existing?.backdrop_url ?? null;
      let overview = existing?.overview ?? null;
      if (!title) {
        try {
          if (override.type === 'movie') {
            const m = await t.getMovie?.(override.tmdb_id);
            if (m) {
              title = m.title;
              year = m.release_date ? Number(m.release_date.slice(0, 4)) : null;
              posterUrl = t.posterUrl(m.poster_path) ?? null;
              backdropUrl = t.posterUrl(m.backdrop_path) ?? null;
              overview = m.overview ?? null;
            }
          } else {
            const s = await t.getSeries(override.tmdb_id);
            title = s.name;
            year = s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null;
            posterUrl = t.posterUrl(s.poster_path) ?? null;
            backdropUrl = t.posterUrl(s.backdrop_path) ?? null;
            overview = s.overview ?? null;
          }
        } catch (err) {
          log.warn(`could not hydrate manual override ${f.relPosix}: ${(err as Error).message}`);
        }
      }
      if (!title) title = `tmdb:${override.tmdb_id}`;     // fallback path key

      // 0.1.8 — fetch IMDb rating for the manually-overridden identity. Skip
      // when the existing row already has a rating, except on `--full` (Hard
      // refresh) which re-pulls everything. Failures are silent.
      let imdbRating: number | null = null;
      let imdbVotes: number | null = null;
      let resolvedImdbId: string | null = override.imdb_id ?? existing?.imdb_id ?? null;
      const skipRating = !opts.full && !!(existing && existing.imdb_rating != null);
      if (ratingFetcher && !skipRating) {
        const r = await resolveImdbRating(override.tmdb_id, override.type, resolvedImdbId, ratingFetcher, t, log);
        if (r) {
          resolvedImdbId = r.imdbId;
          imdbRating = r.rating;
          imdbVotes = r.votes;
        }
      }

      await applyIdentity(
        f.relPosix,
        {
          tmdbId: override.tmdb_id,
          imdbId: resolvedImdbId,
          tvdbId: override.tvdb_id,
          type: override.type,
          title,
          year,
          posterUrl,
          backdropUrl,
          overview,
          imdbRating,
          imdbVotes,
        },
        {
          confidence: 1.0,
          identificationJson: JSON.stringify({ source: 'manual', reason: override.reason }),
          season: override.season ?? undefined,
          episode: override.episode ?? undefined,
          mtime: f.mtime,
          scannedAt: startedAt,
        },
        { db, tmdb: { getEpisodes: t.getEpisodes, stillUrl: t.stillUrl, getSeries: t.getSeries } },
      );
      result.manualOverridesApplied!++;
      log.info(`= ${f.relPosix} → manual-override tmdb=${override.tmdb_id}`);
    } catch (err) {
      result.errors++;
      log.error(`error applying override ${f.relPosix}: ${(err as Error).message}`);
    }
  }

  if (allFiles.length === 0) {
    progress?.emit({ type: 'diff', dirty: 0, disappeared: 0, total: 0 });
    const staleRow = db.raw
      .prepare(`SELECT COUNT(*) AS c FROM media_items WHERE scanned_at < ?`)
      .get(startedAt) as { c: number };
    result.stale = staleRow.c;
    return result;
  }

  // 1.6. Diff against the DB (smart-refresh fast path). For !opts.full we use
  // the diff to skip cohort identification on unchanged files entirely. For
  // opts.full we still build the diff so the progress channel knows the
  // total file count and "disappeared" set, but every file goes through
  // cohort identification.
  const dbIndex = buildDbPathIndex(db);
  const { newOrChanged, disappeared } = diffPaths(allFiles, dbIndex);
  progress?.emit({
    type: 'diff',
    dirty: newOrChanged.length,
    disappeared: disappeared.length,
    total: allFiles.length,
  });

  // Smart-refresh no-change early return: nothing on disk has changed and
  // nothing has disappeared. Bump scanned_at on every existing on-disk row
  // (so they don't fall under the stale gate) and exit. ZERO TMDB calls,
  // ZERO probeFile calls.
  if (!opts.full && newOrChanged.length === 0 && disappeared.length === 0) {
    bumpScannedAtForFiles(db, allFiles, startedAt);
    const staleRow = db.raw
      .prepare(`SELECT COUNT(*) AS c FROM media_items WHERE scanned_at < ?`)
      .get(startedAt) as { c: number };
    result.stale = staleRow.c;
    return result;
  }

  // For smart refresh, only `newOrChanged` go through cohort identification.
  // Untouched files (still on disk, mtime matches) get scanned_at bumped so
  // they don't appear stale. Disappeared files are intentionally NOT touched
  // (D3): keeping their previous scanned_at < latestRunAt is what makes the
  // existing 0.1.5 stale UI hide them.
  const filesForCohorts = opts.full ? allFiles : newOrChanged;
  if (!opts.full) {
    // Bump scanned_at for the on-disk-but-unchanged files first so the cohort
    // pipeline only has to think about dirty files.
    const dirtySet = new Set(newOrChanged.map((f) => f.relPosix));
    const untouched = allFiles.filter((f) => !dirtySet.has(f.relPosix));
    bumpScannedAtForFiles(db, untouched, startedAt);
  }

  // 2. Group into cohorts (pure, no I/O).
  const cohorts = groupIntoCohorts(filesForCohorts, mediaRoot);

  // Cohort-identification dependencies: source, library lookup (D5), known-seasons fetcher.
  const knownSeasonsCache = new Map<number, KnownSeason[] | null>();
  const seasonEpisodesCache = new Map<string, tmdb.TmdbSeason | null>();
  const libraryLookup = buildLibraryLookup(db);

  const cohortDeps: IdentifyDeps = {
    source,
    libraryLookup,
    getKnownSeasons: async (tmdbId) => {
      if (knownSeasonsCache.has(tmdbId)) return knownSeasonsCache.get(tmdbId) ?? null;
      try {
        const series = await t.getSeries(tmdbId);
        const known = series.seasons
          ? series.seasons.map((sn) => ({ season_number: sn.season_number, episode_count: sn.episode_count }))
          : null;
        knownSeasonsCache.set(tmdbId, known);
        return known;
      } catch (err) {
        log.warn(`could not fetch series ${tmdbId}: ${(err as Error).message}`);
        knownSeasonsCache.set(tmdbId, null);
        return null;
      }
    },
  };

  // Counter for the SSE progress channel — ticks once per file processed
  // (identify + persist + probe phases each emit, see processCohort).
  const fileCounter = makeFileCounter(filesForCohorts.length);

  // 3. For each cohort: identify, then fit each file.
  for (const cohort of cohorts) {
    progress?.emit({ type: 'cohort', key: cohort.key, size: cohort.files.length });
    try {
      await processCohort(
        cohort,
        cohortDeps,
        opts,
        startedAt,
        db,
        t,
        source,
        log,
        seasonEpisodesCache,
        result,
        mediaRoot,
        deps.proberDeps,
        progress,
        fileCounter,
        ratingFetcher,
      );
    } catch (err) {
      result.errors++;
      log.error(`error processing cohort ${cohort.key}: ${(err as Error).message}`);
    }
  }

  // 4. Pass B — multi-source rescue over needs_review entries (0.1.1.3).
  await runPassB(deps, source, db, log, t, startedAt, result, ratingFetcher, opts);

  const staleRow = db.raw
    .prepare(`SELECT COUNT(*) AS c FROM media_items WHERE scanned_at < ?`)
    .get(startedAt) as { c: number };
  result.stale = staleRow.c;

  return result;
}

/**
 * Build the Pass B multi-source kit from config (or test overrides). OMDb/TVDB are
 * optional — when their API keys are absent (or the dep is explicitly null), they're
 * just not part of the source set.
 */
function buildPassBSources(deps: ScanDeps, tmdbSrc: Source): PassBSources {
  let omdb: Source | null;
  if (deps.omdbSource !== undefined) {
    omdb = deps.omdbSource;
  } else if (config.omdbApiKey) {
    omdb = createOmdbSource({
      apiKey: config.omdbApiKey,
      budget: createBudgetTracker(config.omdbBudgetPath, 1000),
    });
  } else {
    omdb = null;
  }

  let tvdb: Source | null;
  if (deps.tvdbSource !== undefined) {
    tvdb = deps.tvdbSource;
  } else if (config.tvdbApiKey) {
    tvdb = createTvdbSource({
      apiKey: config.tvdbApiKey,
      budget: createBudgetTracker(config.tvdbBudgetPath, 5000),
      tokenPath: config.tvdbTokenPath,
    });
  } else {
    tvdb = null;
  }

  return { tmdb: tmdbSrc, omdb, tvdb };
}

async function runPassB(
  deps: ScanDeps,
  tmdbSrc: Source,
  db: DbHandle,
  log: ScanLogger,
  t: TmdbDeps,
  startedAt: number,
  result: ScanResult,
  rating: RatingDeps | null,
  opts: ScanOptions,
): Promise<void> {
  const reviewItems = db.listReview();
  if (reviewItems.length === 0) return;

  const sources = buildPassBSources(deps, tmdbSrc);
  // Skip Pass B entirely if neither corroborating source is configured — TMDB alone
  // already failed in Pass A; re-running it adds no signal.
  if (!sources.omdb && !sources.tvdb) {
    log.info(`pass-B skipped: no OMDb/TVDB configured (${reviewItems.length} entries remain in needs_review)`);
    return;
  }

  log.info(`pass-B: re-evaluating ${reviewItems.length} needs_review entries with ${[
    'tmdb',
    sources.omdb && 'omdb',
    sources.tvdb && 'tvdb',
  ].filter(Boolean).join('+')}`);

  for (const review of reviewItems) {
    const relPosix = review.path;
    let outcome;
    try {
      outcome = await passBIdentify(relPosix, sources);
    } catch (err) {
      log.warn(`pass-B error for ${relPosix}: ${(err as Error).message}`);
      continue;
    }

    if (outcome.winner) {
      const w = outcome.winner;
      const r = w.tmdb;       // SourceResult
      // Fallback resolution: if the winning candidate is from OMDb/TVDB and lacks a TMDB
      // id, try to resolve via the IMDb id so we can persist a tmdb_id for downstream
      // metadata (TMDB has the richest movie/episode data).
      let resolvedTmdbId = r.tmdbId ?? null;
      let resolvedTmdb = r;
      if (resolvedTmdbId == null && r.imdbId && tmdbSrc.byImdbId) {
        try {
          const found = await tmdbSrc.byImdbId(r.imdbId);
          if (found?.tmdbId != null) {
            resolvedTmdbId = found.tmdbId;
            resolvedTmdb = { ...found, imdbId: r.imdbId, tvdbId: r.tvdbId ?? found.tvdbId };
          }
        } catch {
          // ignore
        }
      }
      if (resolvedTmdbId == null) {
        // No TMDB id even after IMDb cross-resolution — leave in needs_review.
        const candidates = JSON.stringify(outcome.candidates.slice(0, 3));
        db.upsertReviewItem({
          path: relPosix,
          reason: 'low_score',
          candidates,
          added_at: review.added_at,
          scanned_at: startedAt,
        });
        continue;
      }

      // Look up file mtime — the row in needs_review carries scanned_at, but mtime is on the
      // original file. We use the review row's added_at as a stand-in: the file is unchanged
      // between Pass A and Pass B in the same scan.
      const mtime = review.scanned_at;

      try {
        const type = resolvedTmdb.type === 'tv' ? 'series' : 'movie';
        // 0.1.8 — fetch IMDb rating for the rescued identity. Pass B already
        // hit OMDb during corroboration, so the budget tracker may say no
        // here — that's fine, we just leave imdb_rating null and let
        // --refresh-ratings catch up later.
        const seriesType: 'movie' | 'series' = type === 'series' ? 'series' : 'movie';
        let imdbRating: number | null = null;
        let imdbVotes: number | null = null;
        let resolvedImdbId: string | null = resolvedTmdb.imdbId ?? r.imdbId ?? null;
        const existingRow = db.getByTmdbId(resolvedTmdbId, seriesType);
        const skipRating = !opts.full && !!(existingRow && existingRow.imdb_rating != null);
        if (rating && !skipRating) {
          const rr = await resolveImdbRating(resolvedTmdbId, seriesType, resolvedImdbId, rating, t, log);
          if (rr) {
            resolvedImdbId = rr.imdbId;
            imdbRating = rr.rating;
            imdbVotes = rr.votes;
          }
        }
        // posterPath/backdropPath at this layer are TMDB raw paths
        // (e.g. "/abc.jpg"). Convert to full CDN URLs before persisting,
        // otherwise the browser treats the leading-slash path as
        // app-origin-relative and 404s. (Bug fix on top of 0.1.5.1.)
        await applyIdentity(
          relPosix,
          {
            tmdbId: resolvedTmdbId,
            imdbId: resolvedImdbId,
            tvdbId: resolvedTmdb.tvdbId ?? r.tvdbId ?? null,
            type,
            title: resolvedTmdb.title,
            year: resolvedTmdb.year,
            posterUrl: t.posterUrl(resolvedTmdb.posterPath),
            backdropUrl: t.posterUrl(resolvedTmdb.backdropPath),
            overview: resolvedTmdb.overview,
            imdbRating,
            imdbVotes,
          },
          {
            confidence: w.score,
            identificationJson: JSON.stringify({
              source: 'pass-b',
              sources: w.sources,
              perSourceScores: w.perSourceScores,
              agreementBonus: w.agreementBonus,
            }),
            mtime,
            scannedAt: startedAt,
          },
          { db, tmdb: { getEpisodes: t.getEpisodes, stillUrl: t.stillUrl, getSeries: t.getSeries } },
        );
        result.rescuedByPassB!++;
        result.added++;
        if (result.needsReview > 0) result.needsReview--;
        log.info(`+ pass-B ${relPosix} → tmdb=${resolvedTmdbId} (${w.sources.join('+')}, conf=${w.score.toFixed(2)})`);
      } catch (err) {
        log.warn(`pass-B apply failed for ${relPosix}: ${(err as Error).message}`);
        // Fall through and update candidates so reviewers can still see what happened.
        const candidates = JSON.stringify(outcome.candidates.slice(0, 3));
        db.upsertReviewItem({
          path: relPosix,
          reason: 'episode_unresolved',
          candidates,
          added_at: review.added_at,
          scanned_at: startedAt,
        });
      }
    } else {
      // Still no win — refresh the candidates payload so the manual rescue CLI sees fresh data.
      const candidates = JSON.stringify(outcome.candidates.slice(0, 3));
      db.upsertReviewItem({
        path: relPosix,
        reason: outcome.candidates.length === 0 ? 'no_results' : 'low_score',
        candidates,
        added_at: review.added_at,
        scanned_at: startedAt,
      });
    }
  }
}

interface ProcessIdentityCacheKey {
  tmdbId: number;
  type: 'movie' | 'series';
}

async function processCohort(
  cohort: Cohort,
  cohortDeps: IdentifyDeps,
  opts: ScanOptions,
  startedAt: number,
  db: DbHandle,
  t: TmdbDeps,
  source: Source,
  log: ScanLogger,
  seasonEpisodesCache: Map<string, tmdb.TmdbSeason | null>,
  result: ScanResult,
  mediaRoot: string,
  proberDeps: ProbeFileDeps | undefined,
  progress: ProgressEmitter | undefined,
  counter: FileCounter,
  rating: RatingDeps | null,
): Promise<void> {
  // mtime-skip optimization: if NOT --full and every file has unchanged mtime AND there's no
  // pending review entry that needs re-evaluation, just bump scanned_at on existing rows.
  // For smart refresh this rarely fires now (the upstream diff already screens
  // out unchanged files); the path remains for hard refresh and for cohorts
  // that are partially changed.
  if (!opts.full && (await tryFastSkip(cohort, db, startedAt))) {
    // Tick the counter for the files we elided so the SSE counter stays
    // monotone and reflects forward progress.
    for (const f of cohort.files) {
      progress?.emit({
        type: 'file',
        i: counter.next(),
        n: counter.total,
        path: f.relPosix,
        phase: 'persist',
      });
    }
    return;
  }

  for (const f of cohort.files) {
    progress?.emit({
      type: 'file',
      i: counter.next(),
      n: counter.total,
      path: f.relPosix,
      phase: 'identify',
    });
  }

  const identity = await identifyCohort(cohort, cohortDeps, opts.aggressive ? { aggressive: true } : {});
  if (!identity) {
    // Cohort failed to identify — every file goes to needs_review (unless already-identified
    // and unchanged, but processCohort's fast-skip would have handled that case).
    for (const f of cohort.files) {
      recordReview(db, f.relPosix, 'low_score', startedAt, result, log);
      progress?.emit({
        type: 'file',
        i: counter.next(),
        n: counter.total,
        path: f.relPosix,
        phase: 'persist',
      });
    }
    return;
  }

  // Persist the cohort identity. Movies → one media_items row + N media_files rows. Series →
  // one media_items row + N episodes rows.
  if (identity.type === 'movie') {
    await persistMovieCohort(cohort, identity, opts, startedAt, db, t, log, result, rating);
  } else {
    await persistSeriesCohort(cohort, identity, cohortDeps, opts, startedAt, db, t, source, log, seasonEpisodesCache, result, rating);
  }
  for (const f of cohort.files) {
    progress?.emit({
      type: 'file',
      i: counter.next(),
      n: counter.total,
      path: f.relPosix,
      phase: 'persist',
    });
  }

  // 0.1.4.3 — after identification + upsert, probe each file in the cohort.
  // The prober is mtime-gated: unchanged files return 'fresh' without spawning
  // ffprobe. A failure for one file is logged but doesn't abort the scan.
  for (const f of cohort.files) {
    const absPath = toNativeAbsolute(f.relPosix, mediaRoot);
    let status: ProbeStatus | undefined;
    try {
      status = await probeFile(absPath, f.relPosix, f.mtime, db, {}, proberDeps ?? {});
    } catch (err) {
      // probeFile() should never throw, but belt-and-suspenders so a bug there
      // can't crash the whole scan.
      log.warn(`prober crashed for ${f.relPosix}: ${(err as Error).message}`);
      progress?.emit({
        type: 'probe',
        i: counter.next(),
        n: counter.total,
        path: f.relPosix,
        status: 'failed',
      });
      continue;
    }
    if (status === 'reprobed') {
      result.probed = (result.probed ?? 0) + 1;
    }
    progress?.emit({
      type: 'probe',
      i: counter.next(),
      n: counter.total,
      path: f.relPosix,
      status,
    });
  }
}

async function tryFastSkip(cohort: Cohort, db: DbHandle, startedAt: number): Promise<boolean> {
  // Try to skip cohort entirely if every file is already in the DB with matching mtime.
  // This preserves 0.1.1's "re-running with no changes makes zero TMDB requests" behaviour.
  for (const f of cohort.files) {
    const item = db.getByPath(f.relPosix);
    const ep = db.getEpisodeByPath(f.relPosix);
    const mediaFile = db.getMediaFileByPath(f.relPosix);
    const review = db.getReviewItem(f.relPosix);

    if (item && item.mtime === f.mtime) continue;
    if (ep && ep.mtime === f.mtime) continue;
    if (mediaFile && mediaFile.mtime === f.mtime) continue;
    if (review && review.scanned_at === f.mtime) continue;

    // At least one file is new or changed → can't fast-skip the cohort.
    return false;
  }

  // All files unchanged. Bump scanned_at on existing rows and return true.
  for (const f of cohort.files) {
    const ep = db.getEpisodeByPath(f.relPosix);
    if (ep) {
      db.raw.prepare(`UPDATE episodes SET scanned_at = ? WHERE path = ?`).run(startedAt, f.relPosix);
      db.raw.prepare(`UPDATE media_items SET scanned_at = ? WHERE id = ?`).run(startedAt, ep.series_id);
      continue;
    }
    const mf = db.getMediaFileByPath(f.relPosix);
    if (mf) {
      db.raw.prepare(`UPDATE media_files SET scanned_at = ? WHERE path = ?`).run(startedAt, f.relPosix);
      db.raw.prepare(`UPDATE media_items SET scanned_at = ? WHERE id = ?`).run(startedAt, mf.item_id);
      continue;
    }
    const item = db.getByPath(f.relPosix);
    if (item) {
      db.raw.prepare(`UPDATE media_items SET scanned_at = ? WHERE id = ?`).run(startedAt, item.id);
      continue;
    }
    const review = db.getReviewItem(f.relPosix);
    if (review) {
      db.raw.prepare(`UPDATE needs_review SET scanned_at = ? WHERE path = ?`).run(startedAt, f.relPosix);
    }
  }
  return true;
}

/** 0.1.8 — Resolve IMDb id (if not already known) and fetch the rating.
 *  Returns the imdb_id (so the caller can persist it alongside the rating)
 *  plus the /10 rating and vote count. Returns null when no rating could
 *  be obtained — either no fetcher, no IMDb id resolvable, or OMDb has no
 *  rating for this title. Caller treats null as "leave any existing
 *  imdb_rating in the DB alone" (upsert COALESCEs).
 */
async function resolveImdbRating(
  tmdbId: number,
  type: 'movie' | 'series',
  imdbIdHint: string | null,
  rating: RatingDeps | null,
  t: TmdbDeps,
  log: ScanLogger,
): Promise<{ imdbId: string; rating: number; votes: number | null } | null> {
  if (!rating) return null;
  let imdbId = imdbIdHint;
  if (!imdbId) {
    try {
      const ext =
        type === 'movie'
          ? await t.getMovieExternalIds?.(tmdbId)
          : await t.getSeriesExternalIds?.(tmdbId);
      if (ext?.imdb_id) imdbId = ext.imdb_id;
    } catch (err) {
      log.warn(`could not resolve imdb id for tmdb=${tmdbId}: ${(err as Error).message}`);
    }
  }
  if (!imdbId) return null;
  const r = await rating.fetchRating(imdbId);
  if (!r) return null;
  return { imdbId, rating: r.rating, votes: r.votes };
}

function recordReview(
  db: DbHandle,
  relPosix: string,
  reason: string,
  startedAt: number,
  result: ScanResult,
  log: ScanLogger,
): void {
  const existing = db.getReviewItem(relPosix);
  db.upsertReviewItem({
    path: relPosix,
    reason,
    candidates: '[]',
    added_at: existing?.added_at ?? startedAt,
    scanned_at: startedAt,
  });
  result.needsReview++;
  log.warn(`? ${relPosix} → needs_review (${reason})`);
}

async function persistMovieCohort(
  cohort: Cohort,
  identity: CohortIdentity,
  opts: ScanOptions,
  startedAt: number,
  db: DbHandle,
  t: TmdbDeps,
  log: ScanLogger,
  result: ScanResult,
  rating: RatingDeps | null,
): Promise<void> {
  // For movie cohorts: one media_items row per cohort. Path is the cohort folder when there
  // is one, otherwise the (single) file's path. media_files holds each rip's playable path.
  const itemPath = cohort.context.commonPath || cohort.files[0]!.relPosix;
  const existing = db.getByTmdbId(identity.tmdbId, 'movie') ?? db.getByPath(itemPath);

  // 0.1.3.2: pull genres + runtime from TMDB. Best-effort — search results don't carry these.
  let genresJson: string | null = null;
  let runtimeSeconds: number | null = null;
  if (t.getMovie) {
    try {
      const m = await t.getMovie(identity.tmdbId);
      if (m.genres && m.genres.length > 0) {
        genresJson = JSON.stringify(m.genres.map((g) => g.name));
      }
      if (typeof m.runtime === 'number' && m.runtime > 0) {
        runtimeSeconds = Math.round(m.runtime * 60);
      }
    } catch {
      // tolerate missing details
    }
  }

  // 0.1.8: pull IMDb rating from OMDb (one extra request per identified item
  // when an OMDb key is configured). On an incremental scan we skip rows
  // that already have a rating — re-running shouldn't burn quota refetching
  // numbers that change slowly. `--full` (the "Hard refresh" UI button) and
  // the `--refresh-ratings` catch-up CLI bypass this gate.
  let imdbRating: number | null = null;
  let imdbVotes: number | null = null;
  let resolvedImdbId: string | null = existing?.imdb_id ?? null;
  const skipRating = !opts.full && !!(existing && existing.imdb_rating != null);
  if (rating && !skipRating) {
    const r = await resolveImdbRating(identity.tmdbId, 'movie', resolvedImdbId, rating, t, log);
    if (r) {
      resolvedImdbId = r.imdbId;
      imdbRating = r.rating;
      imdbVotes = r.votes;
    }
  }

  // If there's already a movie row for this tmdb_id, reuse it (handles re-scans across runs
  // and prevents duplicate rows when the path key shifts between runs).
  let itemId: number;
  let isNew = false;
  if (existing && existing.type === 'movie') {
    // Use COALESCE on poster/backdrop/overview so a re-identification path
    // that lacks fresh metadata (e.g. library-tiebreaker without TMDB
    // round-trip) doesn't wipe values we already have. Identity-defining
    // fields (title, year, tmdb_id) still overwrite — by the time we get
    // here we trust the new identity.
    db.raw
      .prepare(
        `UPDATE media_items
         SET title = ?, year = ?,
             imdb_id      = COALESCE(?, imdb_id),
             poster_url   = COALESCE(?, poster_url),
             backdrop_url = COALESCE(?, backdrop_url),
             overview     = COALESCE(?, overview),
             confidence = ?, identification_json = ?,
             genres_json = COALESCE(?, genres_json),
             runtime_seconds = COALESCE(?, runtime_seconds),
             imdb_rating = COALESCE(?, imdb_rating),
             imdb_votes  = COALESCE(?, imdb_votes),
             scanned_at = ?
         WHERE id = ?`,
      )
      .run(
        identity.title,
        identity.year,
        resolvedImdbId,
        t.posterUrl(identity.posterPath),
        t.posterUrl(identity.backdropPath),
        identity.overview,
        identity.confidence,
        identificationJson(cohort, identity),
        genresJson,
        runtimeSeconds,
        imdbRating,
        imdbVotes,
        startedAt,
        existing.id,
      );
    itemId = existing.id;
    result.updated++;
  } else {
    const row = db.upsertItem({
      path: itemPath,
      type: 'movie',
      tmdb_id: identity.tmdbId,
      imdb_id: resolvedImdbId,
      title: identity.title,
      year: identity.year,
      poster_url: t.posterUrl(identity.posterPath),
      backdrop_url: t.posterUrl(identity.backdropPath),
      overview: identity.overview,
      confidence: identity.confidence,
      identification_json: identificationJson(cohort, identity),
      genres_json: genresJson,
      runtime_seconds: runtimeSeconds,
      imdb_rating: imdbRating,
      imdb_votes: imdbVotes,
      mtime: cohort.files[0]!.mtime,
      scanned_at: startedAt,
    });
    itemId = row.id;
    isNew = true;
  }

  // Insert one media_files row per cohort file. Existing entries upsert idempotently.
  for (const f of cohort.files) {
    const mfExisting = db.getMediaFileByPath(f.relPosix);
    db.upsertMediaFile({
      item_id: itemId,
      path: f.relPosix,
      mtime: f.mtime,
      scanned_at: startedAt,
    });
    // Clear stale review entries for this path.
    if (db.getReviewItem(f.relPosix)) db.clearReviewItem(f.relPosix);
    if (!mfExisting && !isNew) {
      // New file added to existing movie — count as updated, not added (the item itself
      // didn't change).
    }
  }

  if (isNew) result.added++;
  log.info(
    `+ ${itemPath} → movie tmdb=${identity.tmdbId} (${cohort.files.length} file${cohort.files.length === 1 ? '' : 's'}, conf=${identity.confidence.toFixed(2)})`,
  );
}

async function persistSeriesCohort(
  cohort: Cohort,
  identity: CohortIdentity,
  cohortDeps: IdentifyDeps,
  opts: ScanOptions,
  startedAt: number,
  db: DbHandle,
  t: TmdbDeps,
  _source: Source,
  log: ScanLogger,
  seasonEpisodesCache: Map<string, tmdb.TmdbSeason | null>,
  result: ScanResult,
  rating: RatingDeps | null,
): Promise<void> {
  // Series-level row: keyed on the cohort's series-root path when available, or on the
  // (deterministic) cohort key otherwise. If a row already exists for this tmdb_id, reuse it.
  const seriesPath = cohort.context.commonPath || `__cohort__:${cohort.key}`;
  const existingByTmdbId = db.getByTmdbId(identity.tmdbId, 'series');

  // 0.1.3.2: pull genres from TMDB /tv/:id. Best-effort.
  let genresJson: string | null = null;
  try {
    const s = await t.getSeries(identity.tmdbId);
    if (s.genres && s.genres.length > 0) {
      genresJson = JSON.stringify(s.genres.map((g) => g.name));
    }
  } catch {
    // tolerate missing details
  }

  // 0.1.8: IMDb rating, see persistMovieCohort for rationale. `--full` (Hard
  // refresh) bypasses the "already has rating" skip so the user can recover
  // from an OMDb outage that left rows null.
  let imdbRating: number | null = null;
  let imdbVotes: number | null = null;
  let resolvedImdbId: string | null = existingByTmdbId?.imdb_id ?? null;
  const skipRating = !opts.full && !!(existingByTmdbId && existingByTmdbId.imdb_rating != null);
  if (rating && !skipRating) {
    const r = await resolveImdbRating(identity.tmdbId, 'series', resolvedImdbId, rating, t, log);
    if (r) {
      resolvedImdbId = r.imdbId;
      imdbRating = r.rating;
      imdbVotes = r.votes;
    }
  }

  let seriesRow: MediaItemRow;
  if (existingByTmdbId) {
    // COALESCE on poster/backdrop/overview so a library-tiebreaker
    // re-identification (which has no fresh TMDB metadata for these
    // fields) doesn't wipe values we already have on the row.
    db.raw
      .prepare(
        `UPDATE media_items
         SET title = ?, year = ?,
             imdb_id      = COALESCE(?, imdb_id),
             poster_url   = COALESCE(?, poster_url),
             backdrop_url = COALESCE(?, backdrop_url),
             overview     = COALESCE(?, overview),
             confidence = ?, identification_json = ?,
             genres_json = COALESCE(?, genres_json),
             imdb_rating = COALESCE(?, imdb_rating),
             imdb_votes  = COALESCE(?, imdb_votes),
             scanned_at = ?
         WHERE id = ?`,
      )
      .run(
        identity.title,
        identity.year,
        resolvedImdbId,
        t.posterUrl(identity.posterPath),
        t.posterUrl(identity.backdropPath),
        identity.overview,
        identity.confidence,
        identificationJson(cohort, identity),
        genresJson,
        imdbRating,
        imdbVotes,
        startedAt,
        existingByTmdbId.id,
      );
    seriesRow = { ...existingByTmdbId, scanned_at: startedAt };
  } else {
    seriesRow = db.upsertItem({
      path: seriesPath,
      type: 'series',
      tmdb_id: identity.tmdbId,
      imdb_id: resolvedImdbId,
      title: identity.title,
      year: identity.year,
      poster_url: t.posterUrl(identity.posterPath),
      backdrop_url: t.posterUrl(identity.backdropPath),
      overview: identity.overview,
      confidence: identity.confidence,
      identification_json: identificationJson(cohort, identity),
      genres_json: genresJson,
      imdb_rating: imdbRating,
      imdb_votes: imdbVotes,
      mtime: 0,
      scanned_at: startedAt,
    });
  }

  // Fit each file into the cohort.
  for (const f of cohort.files) {
    const fit = await fitFileIntoCohort(f, cohort, identity, cohortDeps);
    if (fit.kind === 'unfit') {
      recordReview(db, f.relPosix, fit.reason, startedAt, result, log);
      continue;
    }
    if (fit.kind === 'movie') {
      // Shouldn't happen for a series cohort, but guard.
      log.warn(`unexpected movie fit for series cohort: ${f.relPosix}`);
      continue;
    }

    // fit.kind === 'episode'
    const cacheKey = `${identity.tmdbId}/${fit.season}`;
    let seasonData = seasonEpisodesCache.get(cacheKey);
    if (seasonData === undefined) {
      try {
        seasonData = await t.getEpisodes(identity.tmdbId, fit.season);
      } catch (err) {
        log.warn(`could not fetch ${identity.title} S${fit.season}: ${(err as Error).message}`);
        seasonData = null;
      }
      seasonEpisodesCache.set(cacheKey, seasonData);
    }

    const ep = seasonData?.episodes.find((e) => e.episode_number === fit.episode);

    const epExisting = db.getEpisodeByPath(f.relPosix);
    db.upsertEpisode({
      series_id: seriesRow.id,
      path: f.relPosix,
      season: fit.season,
      episode: fit.episode,
      title: ep?.name ?? null,
      overview: ep?.overview ?? null,
      still_url: t.stillUrl(ep?.still_path),
      confidence: fit.confidence,
      identification_json: identificationJson(cohort, identity),
      mtime: f.mtime,
      scanned_at: startedAt,
    });

    if (db.getReviewItem(f.relPosix)) db.clearReviewItem(f.relPosix);
    if (epExisting) result.updated++;
    else result.added++;
    log.info(`+ ${f.relPosix} → series ${identity.title} s${fit.season}e${fit.episode}`);
  }
}

function identificationJson(cohort: Cohort, identity: CohortIdentity): string {
  return JSON.stringify({
    cohort: { key: cohort.key, kind: cohort.kind },
    identity: { source: identity.source, confidence: identity.confidence },
    breakdown: identity.winner?.scoreBreakdown ?? null,
    hypothesis: identity.winner?.hypothesis ?? null,
  });
}

// ---------------------------------------------------------------------------
// Dry run (preview, no I/O on TMDB / DB) — kept from 0.1.1 for the CLI preview.
// ---------------------------------------------------------------------------

export interface DryRunEntry {
  path: string;
  classification: 'movie' | 'series-episode' | 'unidentified';
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  seriesKey: string | null;
}

export interface DryRunResult {
  movies: DryRunEntry[];
  episodes: DryRunEntry[];
  unidentified: DryRunEntry[];
  seriesKeys: Map<string, number>;
}

export async function dryRun(deps: { mediaRoot?: string; share?: typeof shareStatus } = {}): Promise<DryRunResult> {
  const mediaRoot = deps.mediaRoot ?? config.mediaRoot;
  const share = deps.share ?? shareStatus;

  const s = await share(mediaRoot);
  if (!s.online) throw new ShareOfflineError(mediaRoot);

  const result: DryRunResult = {
    movies: [],
    episodes: [],
    unidentified: [],
    seriesKeys: new Map(),
  };

  for await (const file of walk(mediaRoot)) {
    const relPosix = toPosixRelative(file.absPath, mediaRoot);
    if (isUnderExtrasFolder(relPosix)) continue;
    let parsed = parseFilename(relPosix);
    if (parsed.season == null || parsed.episode == null) {
      const parentName = path.posix.basename(path.posix.dirname(relPosix));
      if (parentName && parentName !== '.') {
        const fromParent = parseFilename(parentName);
        if (fromParent.season != null && fromParent.episode != null) {
          parsed = {
            title: fromParent.title || parsed.title,
            year: parsed.year ?? fromParent.year ?? null,
            season: fromParent.season,
            episode: fromParent.episode,
          };
        }
      }
    }

    const isSeries = parsed.season != null && parsed.episode != null;
    if (isSeries) {
      const { key } = findSeriesKey(relPosix, parsed.title);
      result.seriesKeys.set(key, (result.seriesKeys.get(key) ?? 0) + 1);
      result.episodes.push({
        path: relPosix,
        classification: 'series-episode',
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        seriesKey: key,
      });
    } else if (parsed.title) {
      result.movies.push({
        path: relPosix,
        classification: 'movie',
        title: parsed.title,
        year: parsed.year,
        season: null,
        episode: null,
        seriesKey: null,
      });
    } else {
      result.unidentified.push({
        path: relPosix,
        classification: 'unidentified',
        title: '',
        year: null,
        season: null,
        episode: null,
        seriesKey: null,
      });
    }
  }

  return result;
}

export { ShareOfflineError };

// Internal — exported for the test surface. Suppresses unused-warning for ProcessIdentityCacheKey
// in a cleaner way than `// eslint-disable-next-line`.
export type _InternalIdentityCacheKey = ProcessIdentityCacheKey;

// ---------------------------------------------------------------------------
// 0.1.8 — IMDb rating catch-up pass
// ---------------------------------------------------------------------------

export interface RefreshRatingsOptions {
  /** When true, refetch rows that already have a rating. Default: skip. */
  force?: boolean;
}

export interface RefreshRatingsResult {
  /** Rows considered (already-identified movies + series). */
  considered: number;
  /** Rows for which an IMDb id was already known or could be resolved. */
  resolved: number;
  /** Rows we actually wrote a fresh rating to. */
  updated: number;
  /** Rows we skipped because they already had a rating (and `force` is off). */
  skipped: number;
  /** Rows where OMDb returned no rating (or quota was exhausted). */
  missed: number;
}

export interface RefreshRatingsDeps {
  db?: DbHandle;
  tmdb?: TmdbDeps;
  ratingFetcher?: RatingDeps | null;
  logger?: ScanLogger;
}

/** Walk every identified media_items row and pull its IMDb rating from OMDb.
 *  Idempotent — rows that already have a rating are skipped unless `force`
 *  is set. The function never throws on a per-row failure; it logs and moves
 *  on so a single bad imdbID doesn't stop the whole pass. */
export async function refreshRatings(
  opts: RefreshRatingsOptions = {},
  deps: RefreshRatingsDeps = {},
): Promise<RefreshRatingsResult> {
  const db = deps.db ?? getDb();
  const t = deps.tmdb ?? tmdb;
  const log = deps.logger ?? noopLogger;

  const ratingFetcher: RatingDeps | null =
    deps.ratingFetcher !== undefined
      ? deps.ratingFetcher
      : config.omdbApiKey
      ? createOmdbRatingFetcher({
          apiKey: config.omdbApiKey,
          budget: createBudgetTracker(config.omdbBudgetPath, 1000),
        })
      : null;

  const result: RefreshRatingsResult = {
    considered: 0,
    resolved: 0,
    updated: 0,
    skipped: 0,
    missed: 0,
  };

  if (!ratingFetcher) {
    log.warn('refresh-ratings: no OMDB_API_KEY configured — skipping');
    return result;
  }

  // Iterate every identified row. We use the raw DB so we can stream a
  // narrow projection and avoid loading the full library at once.
  const rows = db.raw
    .prepare<[], { id: number; type: 'movie' | 'series'; tmdb_id: number | null; imdb_id: string | null; imdb_rating: number | null; title: string | null }>(
      `SELECT id, type, tmdb_id, imdb_id, imdb_rating, title
       FROM media_items
       WHERE tmdb_id IS NOT NULL`,
    )
    .all();

  const update = db.raw.prepare<[number | null, number | null, string | null, number]>(
    `UPDATE media_items
     SET imdb_rating = ?, imdb_votes = ?, imdb_id = COALESCE(?, imdb_id)
     WHERE id = ?`,
  );

  for (const r of rows) {
    result.considered++;
    if (!opts.force && r.imdb_rating != null) {
      result.skipped++;
      continue;
    }
    if (r.tmdb_id == null) continue;
    const resolved = await resolveImdbRating(
      r.tmdb_id,
      r.type,
      r.imdb_id,
      ratingFetcher,
      t,
      log,
    );
    if (!resolved) {
      result.missed++;
      continue;
    }
    result.resolved++;
    update.run(resolved.rating, resolved.votes, resolved.imdbId, r.id);
    result.updated++;
    log.info(
      `★ ${r.title ?? `id=${r.id}`} → imdb=${resolved.imdbId} rating=${resolved.rating}${resolved.votes != null ? ` (${resolved.votes} votes)` : ''}`,
    );
  }

  return result;
}
