import path from 'node:path';
import { parseFilename } from '../parse.js';
import { extractEpisode, type KnownSeason } from './episode.js';
import { generateHypotheses, isSubFolderMarker, pathContext } from './hypotheses.js';
import { ABSOLUTE_THRESHOLD, MARGIN, scoreCandidate } from './score.js';
import { indexOfFirstTag } from './release-tags.js';
import { normalize, similarity } from './strings.js';
import { identify, type IdentifyOptions } from './identify.js';
import type { Source } from './sources.js';
import type { Candidate, Hypothesis, PathContext, SourceResult } from './types.js';

export interface FileEntry {
  relPosix: string;
  mtime: number;
}

export type CohortKind = 'series-root' | 'lone-season' | 'lexical-cluster' | 'singleton';

export interface CohortContext {
  /** Common path prefix across cohort members (e.g. the cohort folder). Empty for top-level clusters. */
  commonPath: string;
  /** Whether the cohort lives under a Season-marker folder (lone-season cohorts). */
  underSeasonFolder: boolean;
}

export interface Cohort {
  /** Stable identifier within a scan. Used for logs + identification_json. */
  key: string;
  kind: CohortKind;
  files: FileEntry[];
  /** Best-guess label before TMDB; used as the search seed. */
  seedTitle: string;
  /** S/E density across members — strong signal for series-vs-movie. */
  sePatternRatio: number;
  context: CohortContext;
}

const SEASON_FOLDER_RE = /^(?:season|series)[\s._-]*(\d{1,2})$/i;
const SE_ONLY_FOLDER_RE = /^s\d{1,2}([\s._-]*e\d{1,3})?$/i;
const LEXICAL_SIMILARITY_THRESHOLD = 0.7;

function withoutExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function cleanedPrefix(name: string): string {
  const noExt = withoutExt(name);
  let cut = indexOfFirstTag(noExt);
  if (cut < 0) cut = noExt.length;
  let prefix = noExt.slice(0, cut);
  prefix = prefix.replace(/[\s._\-\[\(\{]+$/g, '').trim();
  return prefix;
}

/**
 * Walk up the directory tree from `relPosix` skipping season/episode markers and return
 * the first non-marker ancestor segment + the path to it. Returns null if no such
 * ancestor exists (file lives at root, or every ancestor is a marker).
 */
function findSeriesRoot(
  relPosix: string,
): { rootPath: string; rootName: string; underSeason: boolean } | null {
  const segments = relPosix.split('/');
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return null;
  let underSeason = false;
  for (let i = 0; i < dirSegments.length; i++) {
    const seg = dirSegments[i]!;
    if (isSubFolderMarker(seg)) {
      if (SEASON_FOLDER_RE.test(seg) || SE_ONLY_FOLDER_RE.test(seg)) underSeason = true;
      continue;
    }
    return {
      rootPath: dirSegments.slice(0, i + 1).join('/'),
      rootName: seg,
      underSeason: underSeason || dirSegments.slice(i + 1).some((s) => SEASON_FOLDER_RE.test(s) || SE_ONLY_FOLDER_RE.test(s)),
    };
  }
  return null;
}

function detectLoneSeason(relPosix: string): boolean {
  const segments = relPosix.split('/');
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return false;
  // Lone-season: every dir segment is a marker AND at least one segment matches Season N.
  let hasSeason = false;
  for (const seg of dirSegments) {
    if (!isSubFolderMarker(seg)) return false;
    if (SEASON_FOLDER_RE.test(seg)) hasSeason = true;
  }
  return hasSeason;
}

function parsedSeOf(relPosix: string): { season: number | null; episode: number | null; title: string } {
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
  return { season: parsed.season, episode: parsed.episode, title: parsed.title };
}

function mostCommonParsedTitle(files: FileEntry[]): string {
  const counts = new Map<string, { display: string; count: number }>();
  for (const f of files) {
    const p = parseFilename(f.relPosix);
    const t = (p.title ?? '').trim();
    if (!t) continue;
    const key = normalize(t);
    if (!key) continue;
    const ex = counts.get(key);
    if (ex) ex.count++;
    else counts.set(key, { display: t, count: 1 });
  }
  let best: { display: string; count: number } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best?.display ?? '';
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  if (strs.length === 1) return strs[0]!;
  let prefix = strs[0]!;
  for (let i = 1; i < strs.length; i++) {
    const s = strs[i]!;
    let j = 0;
    const max = Math.min(prefix.length, s.length);
    while (j < max && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

function makeCohort(
  key: string,
  kind: CohortKind,
  files: FileEntry[],
  seedTitle: string,
  context: CohortContext,
): Cohort {
  const sorted = files.slice().sort((a, b) => a.relPosix.localeCompare(b.relPosix));
  let withSe = 0;
  for (const f of sorted) {
    const p = parsedSeOf(f.relPosix);
    if (p.season != null && p.episode != null) withSe++;
  }
  const ratio = sorted.length > 0 ? withSe / sorted.length : 0;
  return { key, kind, files: sorted, seedTitle, sePatternRatio: ratio, context };
}

// ---------------------------------------------------------------------------
// Collection-folder detection (post-0.1.5.1).
//
// User report: a folder named like "Scary Movie Collection 1-5 2000-2013 ..."
// containing 5 distinct movies got treated as ONE series-root cohort and
// identified as a single TMDB entry. The fix is to detect "this is a packaged
// collection of independent items" and split into singletons BEFORE
// identification runs.
//
// We split when ALL of these hold for a series-root bucket:
//   1. the folder name carries a collection marker (keyword OR year-range),
//   2. the cohort has ≥ 2 files,
//   3. NO file has an S/E pattern (filename or parent folder),
//   4. the files' parsed titles disagree among themselves (i.e. each file
//      represents a different movie, not different rips of the same one).
//
// (1) + (2) gate the check (avoid scanning intent on every cohort).
// (3) protects legit "Complete" series folders that don't put S/E in
// filenames.
// (4) is the load-bearing signal: real series have one parsed title across
// the whole folder; collections have many.
// ---------------------------------------------------------------------------

const COLLECTION_KEYWORD_RE = /\b(collection|anthology|trilogy|quadrilogy|saga|complete\s+(?:set|movies|films|series)|box[ _-]?set|movie\s+pack|movies\s+pack|the\s+(?:complete|essential)\s+(?:collection|movies))\b/i;
// Year-range patterns: "2000-2013", "1980-2010", "1-5" (sequel range), "I-V", "1 to 5".
const COLLECTION_RANGE_RE = /\b(?:\d{4}\s*[-–]\s*\d{4}|\d{1,2}\s*[-–]\s*\d{1,2}|[IVX]+\s*[-–]\s*[IVX]+|\d{1,2}\s+to\s+\d{1,2})\b/i;

function looksLikeCollectionFolder(folderName: string): boolean {
  return COLLECTION_KEYWORD_RE.test(folderName) || COLLECTION_RANGE_RE.test(folderName);
}

/** True iff the cohort's files parse to ≥ 2 distinct titles. Uses the
 *  same `parseFilename` the identifier uses, so the heuristic agrees with
 *  what TMDB will actually be searched for. */
function filesHaveDistinctTitles(files: FileEntry[]): boolean {
  const seen = new Set<string>();
  for (const f of files) {
    const t = normalize((parseFilename(f.relPosix).title ?? '').trim());
    if (!t) continue;
    seen.add(t);
    if (seen.size >= 2) return true;
  }
  return false;
}

/** Decide whether a series-root bucket is actually a packaged collection
 *  of independent items that should be split into per-file singletons. */
export function shouldSplitCollectionBucket(
  folderName: string,
  files: FileEntry[],
): boolean {
  if (files.length < 2) return false;
  if (!looksLikeCollectionFolder(folderName)) return false;
  // Reject if any file has an S/E pattern — that's a real series.
  for (const f of files) {
    const p = parsedSeOf(f.relPosix);
    if (p.season != null && p.episode != null) return false;
  }
  // Confirm via title disagreement.
  return filesHaveDistinctTitles(files);
}

interface ClusterEntry {
  file: FileEntry;
  cleaned: string;
  normalized: string;
}

/**
 * Group top-level loose files by lexical similarity of their cleaned basenames.
 * Files whose normalized cleaned-basenames are >= 0.7 similar form a cluster.
 * Returns clusters with 2+ members; singletons are returned separately.
 */
function clusterByLexicalSimilarity(entries: ClusterEntry[]): { clusters: ClusterEntry[][]; singletons: ClusterEntry[] } {
  const sortedEntries = entries.slice().sort((a, b) => a.normalized.localeCompare(b.normalized));
  const visited = new Set<number>();
  const clusters: ClusterEntry[][] = [];
  const singletons: ClusterEntry[] = [];

  for (let i = 0; i < sortedEntries.length; i++) {
    if (visited.has(i)) continue;
    const seed = sortedEntries[i]!;
    const cluster: ClusterEntry[] = [seed];
    visited.add(i);
    for (let j = i + 1; j < sortedEntries.length; j++) {
      if (visited.has(j)) continue;
      const cand = sortedEntries[j]!;
      // Compare against the seed (anchor-based clustering — deterministic and sufficient
      // for our use case, where members of a real cluster share a long common prefix).
      if (similarity(seed.normalized, cand.normalized) >= LEXICAL_SIMILARITY_THRESHOLD) {
        cluster.push(cand);
        visited.add(j);
      }
    }
    if (cluster.length >= 2) clusters.push(cluster);
    else singletons.push(seed);
  }

  return { clusters, singletons };
}

/**
 * Group a list of files into cohorts. Pure: no I/O.
 *
 * Strategy:
 *   1. Files under a non-marker series-root folder cohort by that root path.
 *   2. Files whose only ancestor is a Season N folder (no series root) cohort by their
 *      shared Season N path with kind 'lone-season'.
 *   3. Top-level loose files (no ancestor at all) cohort by lexical similarity of their
 *      cleaned basenames; clusters of 2+ become 'lexical-cluster' cohorts, isolated files
 *      become 'singleton' cohorts.
 *
 * Output is deterministic and stable across input shuffling.
 */
export function groupIntoCohorts(files: FileEntry[], _mediaRoot?: string): Cohort[] {
  // Bucket by group key (series-root path, lone-season common path, or "__loose__" for root).
  interface Bucket {
    kind: CohortKind;
    files: FileEntry[];
    seedRootName: string | null;
    commonPath: string;
    underSeason: boolean;
  }

  const buckets = new Map<string, Bucket>();
  const looseFiles: FileEntry[] = [];

  for (const f of files) {
    const root = findSeriesRoot(f.relPosix);
    if (root) {
      const bucketKey = `series-root::${root.rootPath}`;
      let b = buckets.get(bucketKey);
      if (!b) {
        b = {
          kind: 'series-root',
          files: [],
          seedRootName: root.rootName,
          commonPath: root.rootPath,
          underSeason: false,
        };
        buckets.set(bucketKey, b);
      }
      b.files.push(f);
      continue;
    }

    if (detectLoneSeason(f.relPosix)) {
      // Lone-season cohort key is the season folder path itself (the dirname of the file).
      const dir = path.posix.dirname(f.relPosix);
      const bucketKey = `lone-season::${dir}`;
      let b = buckets.get(bucketKey);
      if (!b) {
        b = {
          kind: 'lone-season',
          files: [],
          seedRootName: null,
          commonPath: dir,
          underSeason: true,
        };
        buckets.set(bucketKey, b);
      }
      b.files.push(f);
      continue;
    }

    // Top-level / no-ancestor file: defer to lexical clustering.
    looseFiles.push(f);
  }

  const cohorts: Cohort[] = [];

  for (const [, bucket] of buckets) {
    // Collection-folder split: when a series-root bucket is actually a
    // packaged collection of independent items (e.g. "Scary Movie Collection
    // 1-5/..."), emit one singleton per file so each gets identified
    // individually instead of being collapsed into one TMDB identity.
    if (
      bucket.kind === 'series-root' &&
      bucket.seedRootName &&
      shouldSplitCollectionBucket(bucket.seedRootName, bucket.files)
    ) {
      for (const f of bucket.files) {
        const base = path.posix.basename(f.relPosix);
        const cleaned = cleanedPrefix(base) || withoutExt(base);
        cohorts.push(
          makeCohort(
            `singleton::${f.relPosix}`,
            'singleton',
            [f],
            cleaned,
            { commonPath: '', underSeasonFolder: false },
          ),
        );
      }
      continue;
    }

    const seed =
      bucket.kind === 'series-root' && bucket.seedRootName
        ? cleanedPrefix(bucket.seedRootName) || bucket.seedRootName
        : mostCommonParsedTitle(bucket.files);
    const key = bucket.kind === 'lone-season'
      ? `lone-season::${bucket.commonPath}`
      : `series-root::${bucket.commonPath}`;
    cohorts.push(
      makeCohort(key, bucket.kind, bucket.files, seed, {
        commonPath: bucket.commonPath,
        underSeasonFolder: bucket.underSeason || bucket.kind === 'lone-season',
      }),
    );
  }

  // Cluster loose files by lexical similarity.
  const clusterEntries: ClusterEntry[] = looseFiles.map((f) => {
    const base = path.posix.basename(f.relPosix);
    const cleaned = cleanedPrefix(base) || withoutExt(base);
    return { file: f, cleaned, normalized: normalize(cleaned) };
  });

  const { clusters, singletons } = clusterByLexicalSimilarity(clusterEntries);

  for (const cluster of clusters) {
    const sortedCluster = cluster.slice().sort((a, b) => a.normalized.localeCompare(b.normalized));
    const seedFromMostCommon = mostCommonParsedTitle(sortedCluster.map((c) => c.file));
    const seed = seedFromMostCommon || longestCommonPrefix(sortedCluster.map((c) => c.cleaned)).trim();
    const firstFile = sortedCluster[0]!.file.relPosix;
    cohorts.push(
      makeCohort(
        `lexical-cluster::${firstFile}`,
        'lexical-cluster',
        sortedCluster.map((c) => c.file),
        seed || sortedCluster[0]!.cleaned,
        { commonPath: '', underSeasonFolder: false },
      ),
    );
  }

  for (const single of singletons) {
    cohorts.push(
      makeCohort(
        `singleton::${single.file.relPosix}`,
        'singleton',
        [single.file],
        single.cleaned || withoutExt(path.posix.basename(single.file.relPosix)),
        { commonPath: '', underSeasonFolder: false },
      ),
    );
  }

  // Stable order: by key.
  cohorts.sort((a, b) => a.key.localeCompare(b.key));
  return cohorts;
}

// ---------------------------------------------------------------------------
// Identification & fitting
// ---------------------------------------------------------------------------

export interface CohortIdentity {
  tmdbId: number;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  confidence: number;
  source: 'cohort-folder' | 'cohort-most-common' | 'cohort-prefix' | 'library-tiebreaker' | 'singleton-identify';
  /** Full winning candidate breakdown for audit. */
  winner?: Candidate;
}

export interface IdentifyDeps {
  source: Source;
  /** Look up a non-stale series in the library by parsed title (for D5 tiebreaker). */
  libraryLookup?: LibraryLookup;
  /** Fetch known seasons for episode validation. */
  getKnownSeasons?: (tmdbId: number) => Promise<KnownSeason[] | null>;
}

export interface LibraryMatch {
  tmdbId: number;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
}

export type LibraryLookup = (seedTitle: string) => LibraryMatch[];

const COHORT_TIEBREAKER_BOOST = 0.1;

/**
 * Cohort-level path context: aggregates the cohort's signal into a single PathContext
 * the scorer can consume. `hasExplicitSE` mirrors `sePatternRatio >= 0.5`.
 */
function cohortPathContext(cohort: Cohort): PathContext {
  const segments = cohort.context.commonPath
    ? cohort.context.commonPath.split('/').concat([''])
    : [''];
  return {
    segments,
    underSeasonFolder: cohort.context.underSeasonFolder,
    hasExplicitSE: cohort.sePatternRatio >= 0.5,
    siblingNames: cohort.files.map((f) => path.posix.basename(f.relPosix)),
  };
}

interface CohortHypothesis extends Hypothesis {
  source:
    | 'basename'
    | 'parent-folder'
    | 'series-root'
    | 'cleaned-prefix'
    | 'normalized'
    | 'fallback-stripped';
  identitySource: CohortIdentity['source'];
}

function buildCohortHypotheses(cohort: Cohort): CohortHypothesis[] {
  const out: CohortHypothesis[] = [];
  const seen = new Set<string>();
  const expectedType: Hypothesis['expectedType'] = cohort.sePatternRatio >= 0.5 ? 'series' : 'unknown';

  function push(title: string, year: number | null, prior: number, identitySource: CohortIdentity['source']): void {
    const t = title.trim();
    if (!t) return;
    const key = `${normalize(t)}|${year ?? ''}|${expectedType}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      source: identitySource === 'cohort-folder' ? 'parent-folder' : 'cleaned-prefix',
      title: t,
      year,
      season: null,
      episode: null,
      expectedType,
      prior,
      identitySource,
    });
  }

  // Series-root folder name (for series-root cohorts).
  if (cohort.kind === 'series-root' && cohort.context.commonPath) {
    const folder = path.posix.basename(cohort.context.commonPath);
    const cleaned = cleanedPrefix(folder);
    if (cleaned) {
      const parsed = parseFilename(folder);
      const year = parsed.year ?? null;
      push(parsed.title || cleaned, year, 0.85, 'cohort-folder');
    }
  }

  // Most-common parsed title across cohort siblings.
  const common = mostCommonParsedTitle(cohort.files);
  if (common) {
    // Try to infer year from cohort folder name when present.
    let year: number | null = null;
    if (cohort.context.commonPath) {
      const folder = path.posix.basename(cohort.context.commonPath);
      year = parseFilename(folder).year ?? null;
    }
    if (year == null) {
      // Try year from the first file's parsed result.
      for (const f of cohort.files) {
        const p = parseFilename(f.relPosix);
        if (p.year != null) {
          year = p.year;
          break;
        }
      }
    }
    push(common, year, 0.82, 'cohort-most-common');
  }

  // Longest common prefix of cohort file basenames (cleaned).
  if (cohort.files.length >= 2) {
    const prefixes = cohort.files.map((f) => cleanedPrefix(path.posix.basename(f.relPosix)));
    const lcp = longestCommonPrefix(prefixes).trim();
    if (lcp.length >= 3) {
      const parsed = parseFilename(lcp);
      const title = (parsed.title || lcp).replace(/[\s._\-]+$/g, '').trim();
      push(title, parsed.year ?? null, 0.7, 'cohort-prefix');
    }
  }

  // Fallback: cohort seedTitle.
  if (out.length === 0 && cohort.seedTitle) {
    push(cohort.seedTitle, null, 0.6, 'cohort-most-common');
  }

  return out;
}

function libraryToSourceResult(m: LibraryMatch): SourceResult {
  return {
    id: m.tmdbId,
    type: m.type === 'series' ? 'tv' : 'movie',
    title: m.title,
    year: m.year,
    posterPath: m.posterPath,
    backdropPath: m.backdropPath,
    overview: m.overview,
  };
}

/**
 * Identify a cohort as a unit. Picks the strongest cohort-level hypothesis and runs ONE
 * TMDB search through it; the returned identity applies to every member of the cohort.
 *
 * Singleton cohorts delegate directly to per-file identify().
 */
export async function identifyCohort(
  cohort: Cohort,
  deps: IdentifyDeps,
  opts: IdentifyOptions = {},
): Promise<CohortIdentity | null> {
  if (cohort.kind === 'singleton') {
    const f = cohort.files[0]!;
    const ctx = pathContext(f.relPosix);
    const r = await identify(f.relPosix, ctx, deps.source, opts);
    if (!r.winner) return null;
    const w = r.winner;
    return {
      tmdbId: w.tmdb.tmdbId ?? (typeof w.tmdb.id === 'number' ? w.tmdb.id : 0),
      type: w.tmdb.type === 'tv' ? 'series' : 'movie',
      title: w.tmdb.title,
      year: w.tmdb.year,
      posterPath: w.tmdb.posterPath,
      backdropPath: w.tmdb.backdropPath,
      overview: w.tmdb.overview,
      confidence: w.score,
      source: 'singleton-identify',
      winner: w,
    };
  }

  const hypotheses = buildCohortHypotheses(cohort);
  if (hypotheses.length === 0) return null;

  const ctx = cohortPathContext(cohort);
  const candidates: Array<Candidate & { identitySource: CohortIdentity['source'] }> = [];

  for (const h of hypotheses) {
    let results: SourceResult[];
    try {
      results = await deps.source.search(h.title, h.year ?? undefined);
    } catch {
      continue;
    }
    const top = results.slice(0, 3);
    for (let i = 0; i < top.length; i++) {
      const c = scoreCandidate(h, top[i]!, ctx, i);
      candidates.push({ ...c, identitySource: h.identitySource });
    }
  }

  if (candidates.length === 0) return null;

  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  let winner = sorted[0]!;
  let identitySource: CohortIdentity['source'] = winner.identitySource;
  const runnerUp = sorted[1];

  // D5 library-history tiebreaker: when ambiguous AND library has exactly one strong match.
  if (deps.libraryLookup && runnerUp && winner.score - runnerUp.score < MARGIN) {
    const matches = deps.libraryLookup(cohort.seedTitle);
    const strong = matches.filter((m) => similarity(cohort.seedTitle, m.title) >= 0.7);
    if (strong.length === 1) {
      const lib = strong[0]!;
      // Find the candidate among existing scored candidates that matches this library row, or
      // fall back to building a synthetic candidate. Boost it.
      const matched = sorted.find((c) => c.tmdb.id === lib.tmdbId && c.tmdb.type === (lib.type === 'series' ? 'tv' : 'movie'));
      if (matched) {
        winner = { ...matched, score: matched.score + COHORT_TIEBREAKER_BOOST };
        identitySource = 'library-tiebreaker';
      } else {
        // Library row didn't appear in TMDB results; use it directly as the winner.
        const synthetic = scoreCandidate(hypotheses[0]!, libraryToSourceResult(lib), ctx, 0);
        winner = { ...synthetic, score: synthetic.score + COHORT_TIEBREAKER_BOOST, identitySource: 'library-tiebreaker' };
        identitySource = 'library-tiebreaker';
      }
    }
  }

  if (winner.score < ABSOLUTE_THRESHOLD) return null;

  // Decide cohort type. The cohort's structural signal trumps TMDB's classification when
  // the two disagree — sePatternRatio >= 0.5 means "this folder is full of episodes",
  // regardless of how TMDB ranked the search.
  const type: 'movie' | 'series' = cohort.sePatternRatio >= 0.5 ? 'series' : winner.tmdb.type === 'tv' ? 'series' : 'movie';

  return {
    tmdbId: winner.tmdb.tmdbId ?? (typeof winner.tmdb.id === 'number' ? winner.tmdb.id : 0),
    type,
    title: winner.tmdb.title,
    year: winner.tmdb.year,
    posterPath: winner.tmdb.posterPath,
    backdropPath: winner.tmdb.backdropPath,
    overview: winner.tmdb.overview,
    confidence: winner.score,
    source: identitySource,
    winner,
  };
}

// ---------------------------------------------------------------------------
// File fitting
// ---------------------------------------------------------------------------

export type FileFit =
  | { kind: 'movie'; tmdbId: number; confidence: number }
  | { kind: 'episode'; tmdbId: number; season: number; episode: number; confidence: number }
  | { kind: 'unfit'; reason: 'episode_unresolved' | 'low_score' };

export async function fitFileIntoCohort(
  file: FileEntry,
  _cohort: Cohort,
  identity: CohortIdentity,
  deps: IdentifyDeps,
): Promise<FileFit> {
  if (identity.type === 'movie') {
    return { kind: 'movie', tmdbId: identity.tmdbId, confidence: identity.confidence * 0.95 };
  }

  let known: KnownSeason[] | null = null;
  if (deps.getKnownSeasons) {
    try {
      known = await deps.getKnownSeasons(identity.tmdbId);
    } catch {
      known = null;
    }
  }

  const ep = extractEpisode(file.relPosix, identity.title, known);
  if (!ep) return { kind: 'unfit', reason: 'episode_unresolved' };

  return {
    kind: 'episode',
    tmdbId: identity.tmdbId,
    season: ep.season,
    episode: ep.episode,
    confidence: 0.85,
  };
}

// Re-export internal helpers for tests.
export const __test = {
  findSeriesRoot,
  detectLoneSeason,
  cleanedPrefix,
  mostCommonParsedTitle,
  longestCommonPrefix,
};
