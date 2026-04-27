import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';

const bodySchema = z
  .object({
    position: z.number().nonnegative(),
    duration: z.number().nonnegative(),
    watched: z.boolean().optional(),
  })
  .strict();

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function registerPlaybackRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/playback/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    const db = getDb();
    const row = db.getPlayback(relPath);
    if (!row) {
      return { position: 0, duration: 0, watched: false };
    }
    return {
      position: row.position_seconds,
      duration: row.duration_seconds,
      watched: row.watched === 1,
    };
  });

  app.post('/api/playback/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', issues: parsed.error.issues });
    }

    const db = getDb();
    // Distinguish two POST modes:
    //   - explicit `watched: false` from the client (Mark unwatched / Reset progress)
    //     wipes the playback row entirely so position+watched+watched_at all clear.
    //   - everything else falls through to the standard upsert path.
    if (parsed.data.watched === false && parsed.data.position === 0 && parsed.data.duration === 0) {
      db.clearPlayback(relPath);
      return { position: 0, duration: 0, watched: false };
    }
    if (parsed.data.watched === false) {
      // Caller wants to clear watched flag but keep their submitted position/duration.
      db.setWatched(relPath, false, Date.now());
      const row = db.getPlayback(relPath);
      return {
        position: row?.position_seconds ?? 0,
        duration: row?.duration_seconds ?? 0,
        watched: false,
      };
    }
    const row = db.upsertPlayback({
      path: relPath,
      position: parsed.data.position,
      duration: parsed.data.duration,
      ...(parsed.data.watched !== undefined ? { watched: parsed.data.watched } : {}),
      updated_at: Date.now(),
    });
    return {
      position: row.position_seconds,
      duration: row.duration_seconds,
      watched: row.watched === 1,
    };
  });

  // Wipe playback for a single path. Used by the kebab "Reset progress" action. (0.1.3.2)
  app.delete('/api/playback/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });
    const db = getDb();
    db.clearPlayback(relPath);
    return reply.code(204).send();
  });

  // Set watched flag for a single path, preserving existing position/duration so
  // marking an in-progress episode "watched" doesn't reset its resume point.
  // Used by the per-episode kebab. (0.1.3.2)
  app.post('/api/playback-watched/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });
    const parsed = z.object({ watched: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body' });
    const db = getDb();
    if (parsed.data.watched) {
      db.setWatched(relPath, true, Date.now());
    } else {
      db.clearPlayback(relPath);
    }
    return reply.code(204).send();
  });
}
