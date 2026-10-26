/**
 * Skip intro / credits routes (0.2.1).
 *
 *   PUT  /api/series/:id/skip-prefs       { autoIntro?, autoCredits? } → prefs
 *   POST /api/series/:id/relearn-themes   forget learned themes, rebuild markers
 *                                         from stored fingerprints (no ffmpeg)
 *   GET  /api/themes/status               background fingerprint/matching progress
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { runThemePass } from '../themes/pass.js';
import { clearSeriesThemes, setSkipPrefs } from '../themes/store.js';
import { getSweepStatus } from '../themes/sweep.js';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const prefsSchema = z
  .object({ autoIntro: z.boolean().optional(), autoCredits: z.boolean().optional() })
  .strict();

function seriesExists(id: number): boolean {
  const row = getDb().raw.prepare(`SELECT type FROM media_items WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | { type: string }
    | undefined;
  return row?.type === 'series';
}

export async function registerSkipRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/themes/status', async () => {
    const db = getDb();
    const counts = db.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM episodes WHERE deleted_at IS NULL) AS episodes,
           (SELECT COUNT(*) FROM episodes WHERE deleted_at IS NULL AND markers_version IS NOT NULL) AS processed,
           (SELECT COUNT(*) FROM episodes WHERE deleted_at IS NULL AND intro_start IS NOT NULL) AS withIntro,
           (SELECT COUNT(*) FROM episodes WHERE deleted_at IS NULL AND credits_start IS NOT NULL) AS withCredits`,
      )
      .get() as { episodes: number; processed: number; withIntro: number; withCredits: number };
    return { ...getSweepStatus(), library: counts };
  });

  app.put('/api/series/:id/skip-prefs', async (req, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_id' });
    const body = prefsSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_body', issues: body.error.issues });
    if (!seriesExists(p.data.id)) return reply.code(404).send({ error: 'not_found' });
    const patch: { autoIntro?: boolean; autoCredits?: boolean } = {};
    if (body.data.autoIntro !== undefined) patch.autoIntro = body.data.autoIntro;
    if (body.data.autoCredits !== undefined) patch.autoCredits = body.data.autoCredits;
    return setSkipPrefs(getDb(), p.data.id, patch);
  });

  app.post('/api/series/:id/relearn-themes', async (req, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_id' });
    if (!seriesExists(p.data.id)) return reply.code(404).send({ error: 'not_found' });
    const db = getDb();
    clearSeriesThemes(db, p.data.id);
    return runThemePass(db, p.data.id, { force: true });
  });
}
