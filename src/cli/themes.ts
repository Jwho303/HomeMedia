/**
 * `npm run themes` — skip intro / credits from the terminal (0.2.1).
 *
 *   npm run themes                       fingerprint anything new, refresh markers, print a summary
 *   npm run themes -- "naruto"           ...then print every episode's markers for matching shows
 *   npm run themes -- "naruto" --relearn forget those shows' themes and learn them again first
 */

import { config, isConfigured } from '../config.js';
import { getDb } from '../db.js';
import { runThemePass } from '../themes/pass.js';
import { clearSeriesThemes } from '../themes/store.js';
import { runSweep } from '../themes/sweep.js';

const fmt = (s: number | null): string => {
  if (s == null) return '   -   ';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, ' ')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

async function main(): Promise<number> {
  if (!isConfigured()) {
    console.error('not configured: set MEDIA_ROOT and TMDB key first');
    return 1;
  }
  const args = process.argv.slice(2);
  const relearn = args.includes('--relearn');
  const query = args.find((a) => !a.startsWith('--'))?.toLowerCase();
  const db = getDb();

  const logger = {
    info: (o: object, msg: string) => console.log(msg, JSON.stringify(o)),
    warn: (o: object, msg: string) => console.warn(msg, JSON.stringify(o)),
  };
  const t0 = Date.now();
  const r = await runSweep({ db, mediaRoot: config.mediaRoot, logger });
  console.log(`sweep: ${r.fingerprinted} fingerprinted, ${r.failed} without audio/failed, ${r.series} shows updated, ${r.themesLearned} themes learned (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  if (!query) return 0;
  const shows = db.raw
    .prepare(`SELECT id, title FROM media_items WHERE type = 'series' AND deleted_at IS NULL AND lower(title) LIKE ?`)
    .all(`%${query}%`) as Array<{ id: number; title: string }>;
  for (const show of shows) {
    if (relearn) {
      clearSeriesThemes(db, show.id);
      const p = runThemePass(db, show.id, { force: true });
      console.log(`relearned ${show.title}: ${p.themesLearned} themes`);
    }
    const themes = db.raw
      .prepare(`SELECT t.id, t.kind, t.duration_s AS d, group_concat(st.season) AS seasons FROM theme_fingerprints t LEFT JOIN season_themes st ON st.fingerprint_id = t.id WHERE t.series_id = ? GROUP BY t.id`)
      .all(show.id) as Array<{ id: number; kind: string; d: number; seasons: string | null }>;
    console.log(`\n${show.title}`);
    for (const t of themes) console.log(`  theme #${t.id} ${t.kind.padEnd(7)} ${t.d.toFixed(1)} s  seasons ${t.seasons ?? '-'}`);
    const eps = db.raw
      .prepare(`SELECT season, episode, intro_start a, intro_end b, credits_start c, credits_end d, json_extract(probe_json,'$.durationSeconds') dur FROM episodes WHERE series_id = ? AND deleted_at IS NULL ORDER BY season, episode`)
      .all(show.id) as Array<{ season: number; episode: number; a: number | null; b: number | null; c: number | null; d: number | null; dur: number | null }>;
    console.log('  ep        intro              credits            after credits');
    for (const e of eps) {
      const after = e.d != null && e.dur != null ? `${(e.dur - e.d).toFixed(0)} s` : '';
      console.log(`  S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(3, '0')}  ${fmt(e.a)}-${fmt(e.b)}  ${fmt(e.c)}-${fmt(e.d)}  ${after}`);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
