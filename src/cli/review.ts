import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config, loadConfig, ConfigError } from '../config.js';
import { getDb } from '../db.js';
import * as tmdbApi from '../tmdb.js';
import { tmdbSource } from '../identify/sources.js';
import { createOmdbSource } from '../identify/sources/omdb.js';
import { createTvdbSource } from '../identify/sources/tvdb.js';
import { createBudgetTracker } from '../identify/budget.js';
import {
  parseAction,
  candidatesToViews,
  resolveAction,
  parseSeInput,
  extractSeFromPath,
  applyChoice,
  formatCandidateLine,
} from './review-core.js';
import type { ReviewSources } from './review-core.js';

async function fileMtime(absPath: string): Promise<number> {
  try {
    const st = await fs.stat(absPath);
    return Math.floor(st.mtimeMs);
  } catch {
    return 0;
  }
}

async function main(): Promise<number> {
  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const db = getDb();
  const sources: ReviewSources = {
    tmdb: tmdbSource(tmdbApi),
    omdb: config.omdbApiKey
      ? createOmdbSource({ apiKey: config.omdbApiKey, budget: createBudgetTracker(config.omdbBudgetPath, 1000) })
      : null,
    tvdb: config.tvdbApiKey
      ? createTvdbSource({
          apiKey: config.tvdbApiKey,
          budget: createBudgetTracker(config.tvdbBudgetPath, 5000),
          tokenPath: config.tvdbTokenPath,
        })
      : null,
  };

  const rows = db.listReview().slice().sort((a, b) => a.added_at - b.added_at);
  if (rows.length === 0) {
    console.log('Nothing to review. ✓');
    return 0;
  }

  console.log(`There are ${rows.length} item${rows.length === 1 ? '' : 's'} needing review.\n`);
  const rl = readline.createInterface({ input, output });

  let i = 0;
  outer: while (i < rows.length) {
    const row = rows[i]!;
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(row.candidates);
    } catch {
      parsed = [];
    }
    let views = candidatesToViews(parsed);

    console.log(`[${i + 1}/${rows.length}]  ${row.path}`);
    console.log(`  reason: ${row.reason}`);
    if (views.length === 0) {
      console.log('  candidates: (none — Pass B returned nothing)');
    } else {
      console.log('  candidates:');
      for (const v of views) console.log(formatCandidateLine(v));
    }
    console.log(`  Choose: [1..${views.length}] [tmdb:<id>] [imdb:tt<id>] [tvdb:<id>] [t:<title>] [s]kip [q]uit`);
    const ans = await rl.question('  > ');
    const action = parseAction(ans);

    if (action.kind === 'invalid') {
      console.log(`  ! couldn't parse: "${action.raw}"\n`);
      continue;     // re-prompt same row
    }
    if (action.kind === 'skip') {
      console.log('  ↷ skipped\n');
      i++;
      continue;
    }
    if (action.kind === 'quit') {
      console.log('  bye.\n');
      break outer;
    }

    let resolved;
    try {
      resolved = await resolveAction(action, { row, views, sources, tmdb: tmdbApi });
    } catch (err) {
      console.log(`  x lookup failed: ${(err as Error).message}\n`);
      continue;
    }
    if (!resolved) {
      console.log(`  x couldn't resolve that selection.\n`);
      continue;
    }

    // Confirm.
    console.log(`  → ${resolved.identity.title}${resolved.identity.year ? ` (${resolved.identity.year})` : ''} [${resolved.identity.type}] tmdb=${resolved.identity.tmdbId}`);

    // For series: figure out S/E.
    let season: number | undefined;
    let episode: number | undefined;
    if (resolved.identity.type === 'series') {
      // Try extractor first.
      const extracted = extractSeFromPath(row.path, resolved.identity.title, null);
      if (extracted) {
        season = extracted.season;
        episode = extracted.episode;
      } else {
        const seAns = await rl.question('  which season and episode? [s4e2 / 4x2 / etc] > ');
        const parsedSe = parseSeInput(seAns);
        if (!parsedSe) {
          console.log('  x couldn\'t parse season/episode; skipping.\n');
          continue;
        }
        season = parsedSe.season;
        episode = parsedSe.episode;
      }
    }

    const absPath = path.join(config.mediaRoot, ...row.path.split('/'));
    const mtime = await fileMtime(absPath);
    try {
      await applyChoice(
        {
          row,
          identity: resolved.identity,
          reason: resolved.reason,
          season,
          episode,
          mtime,
          decidedAt: Date.now(),
        },
        db,
        { getEpisodes: tmdbApi.getEpisodes, stillUrl: tmdbApi.stillUrl, getSeries: tmdbApi.getSeries },
      );
      const sePart = season != null && episode != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
      console.log(`  ✓ identified as ${resolved.identity.title}${resolved.identity.year ? ` (${resolved.identity.year})` : ''}${sePart} — confidence 1.0 (manual)\n`);
    } catch (err) {
      console.log(`  x apply failed: ${(err as Error).message}\n`);
      continue;
    }
    i++;
  }

  rl.close();
  const remaining = db.listReview().length;
  console.log(`Done. ${remaining} entr${remaining === 1 ? 'y' : 'ies'} still in needs_review.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
