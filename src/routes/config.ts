import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/** 0.1.7 — `/api/config` is read-once on app boot and returns server-side
 *  feature flags the client needs to choose its code path. Decoupled from
 *  `/api/share/status` so the share-status poll stops doubling as the
 *  HLS-flag carrier. */
export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', async () => {
    return { hlsPlayer: config.hlsPlayer };
  });
}
