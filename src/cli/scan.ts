import { loadConfig, ConfigError } from '../config.js';
import { scan, dryRun, refreshRatings, ShareOfflineError } from '../scan.js';

const consoleLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(`! ${msg}`),
  error: (msg: string) => console.error(`x ${msg}`),
};

interface CliOptions {
  full: boolean;
  dryRun: boolean;
  /** 0.1.8 — refresh-ratings catch-up pass: walks the existing library and
   *  populates `imdb_rating` for any identified row that doesn't already
   *  have one. Doesn't touch identification. */
  refreshRatings: boolean;
  /** With --refresh-ratings, refetch even rows that already have a rating. */
  refreshRatingsForce: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    full: argv.includes('--full'),
    dryRun: argv.includes('--dry-run'),
    refreshRatings: argv.includes('--refresh-ratings'),
    refreshRatingsForce: argv.includes('--refresh-ratings-force'),
  };
}

async function runDryRun(mediaRoot: string): Promise<number> {
  console.log(`dry-run: ${mediaRoot}`);
  console.log('(no TMDB calls, no DB writes — preview only)\n');

  try {
    const result = await dryRun();

    console.log(`MOVIES (${result.movies.length}):`);
    for (const m of result.movies.slice().sort((a, b) => a.title.localeCompare(b.title))) {
      const yr = m.year ? ` (${m.year})` : '';
      console.log(`  ${m.title}${yr}    ← ${m.path}`);
    }

    console.log(`\nSERIES (${result.seriesKeys.size} shows, ${result.episodes.length} episodes):`);
    const grouped = new Map<string, typeof result.episodes>();
    for (const e of result.episodes) {
      if (!e.seriesKey) continue;
      const arr = grouped.get(e.seriesKey) ?? [];
      arr.push(e);
      grouped.set(e.seriesKey, arr);
    }
    const orderedKeys = [...grouped.keys()].sort();
    for (const key of orderedKeys) {
      const eps = grouped.get(key)!.slice().sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
      console.log(`  ${key}  (${eps.length} episodes)`);
      for (const e of eps) {
        const code = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
        console.log(`    ${code}  ← ${e.path}`);
      }
    }

    if (result.unidentified.length > 0) {
      console.log(`\nUNIDENTIFIED (${result.unidentified.length}):`);
      for (const u of result.unidentified) console.log(`  ${u.path}`);
    }

    console.log(`\nsummary: ${result.movies.length} movies, ${result.seriesKeys.size} series (${result.episodes.length} episodes), ${result.unidentified.length} unidentified`);
    console.log('(series count is pre-TMDB; same-show folders are merged after identification.)');
    return 0;
  } catch (err) {
    if (err instanceof ShareOfflineError) {
      console.error(`share offline: ${err.mountPath} is not readable`);
      return 2;
    }
    console.error(`dry-run failed: ${(err as Error).message}`);
    return 1;
  }
}

async function main(): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      console.error('\nCopy .env.example to .env and fill in the required values.');
      return 2;
    }
    throw err;
  }

  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    return runDryRun(cfg.mediaRoot);
  }

  if (opts.refreshRatings) {
    console.log(`refreshing IMDb ratings${opts.refreshRatingsForce ? ' (force)' : ''}...`);
    try {
      const r = await refreshRatings(
        { force: opts.refreshRatingsForce },
        { logger: consoleLogger },
      );
      console.log(
        `${r.considered} considered, ${r.updated} updated, ${r.skipped} already had a rating, ${r.missed} no rating, ${r.resolved} imdb ids resolved.`,
      );
      return 0;
    } catch (err) {
      console.error(`refresh-ratings failed: ${(err as Error).message}`);
      return 1;
    }
  }

  console.log(`scanning ${cfg.mediaRoot}${opts.full ? ' (full)' : ''}...`);

  try {
    const result = await scan(opts, { logger: consoleLogger });
    const passBPart = result.rescuedByPassB ? `, ${result.rescuedByPassB} rescued by pass-B` : '';
    const overridePart = result.manualOverridesApplied ? `, ${result.manualOverridesApplied} via manual override` : '';
    console.log(
      `${result.scanned} scanned, ${result.added} added, ${result.updated} updated, ${result.stale} stale, ${result.needsReview} needs-review${passBPart}${overridePart}, ${result.errors} errors. ${cfg.dbPath} updated.`,
    );
    return result.errors > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof ShareOfflineError) {
      console.error(`share offline: ${err.mountPath} is not readable`);
      return 2;
    }
    console.error(`scan failed: ${(err as Error).message}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
