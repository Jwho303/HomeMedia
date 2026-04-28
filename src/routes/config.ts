import type { FastifyInstance } from 'fastify';

/** 0.1.7 — `/api/config` is read-once on app boot and returns server-side
 *  feature flags the client needs to choose its code path. Decoupled from
 *  `/api/share/status` so the share-status poll stops doubling as the
 *  HLS-flag carrier.
 *
 *  Phase 4 (post-0.1.6): HLS is the only player path; the flag is hardcoded
 *  true so older cached client bundles (still gating on it) keep working. */
export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', async () => {
    return { hlsPlayer: true };
  });
}
