/**
 * HLS segment + teardown routes (post-0.1.9 cleanup).
 *
 * After the 0.1.9 cutover the legacy `/api/hls/master.m3u8?path=…` route is
 * gone — the player layer (`/api/player/:id/open`) owns playlist creation
 * and rewriting. What remains in this file is the bookkeeping the segment
 * fetch path still needs, plus the explicit-teardown surface the
 * `<media-player>` component fires on disconnect.
 *
 *   GET    /api/hls/:sessionId/:segName    — stream one segment
 *   DELETE /api/hls/:sessionId             — explicit teardown (idempotent)
 *   POST   /api/hls/:sessionId/delete      — sendBeacon-friendly DELETE alias
 */

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getHlsSessionManager } from '../streaming/hls-session.js';

export async function registerHlsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hls/:sessionId/:segName', async (req, reply) => {
    const params = req.params as { sessionId?: string; segName?: string };
    const sessionId = params.sessionId ?? '';
    const segName = params.segName ?? '';
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
      return reply.code(400).send({ error: 'bad_session' });
    }
    if (!/^seg-\d+\.ts$/.test(segName)) {
      return reply.code(400).send({ error: 'bad_segment' });
    }

    const mgr = getHlsSessionManager();
    const session = mgr.get(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'session_gone' });
    }

    const segPath = path.join(session.cacheDir, segName);
    let st;
    try {
      st = await fs.stat(segPath);
    } catch {
      st = null;
    }
    if (!st || st.size === 0) {
      const ok = await mgr.waitForSegment(sessionId, segName, 5_000);
      if (!ok) {
        return reply.code(425).send({ error: 'segment_pending' });
      }
      try {
        st = await fs.stat(segPath);
      } catch {
        return reply.code(404).send({ error: 'segment_gone' });
      }
    }

    mgr.touch(sessionId);
    req.log.info(
      { evt: 'hls.segment', sessionId, segName, bytes: st.size },
      'hls segment read',
    );
    reply
      .code(200)
      .header('Content-Type', 'video/mp2t')
      .header('Cache-Control', 'no-store')
      .header('Content-Length', String(st.size));
    return reply.send(createReadStream(segPath));
  });

  app.delete('/api/hls/:sessionId', async (req, reply) => {
    const params = req.params as { sessionId?: string };
    const sessionId = params.sessionId ?? '';
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
      return reply.code(204).send();
    }
    await getHlsSessionManager().delete(sessionId);
    return reply.code(204).send();
  });

  app.post('/api/hls/:sessionId/delete', async (req, reply) => {
    const params = req.params as { sessionId?: string };
    const sessionId = params.sessionId ?? '';
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
      return reply.code(204).send();
    }
    await getHlsSessionManager().delete(sessionId);
    return reply.code(204).send();
  });
}
