import type { FastifyInstance } from 'fastify';
import { status, reconnect } from '../share.js';

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/share/status', async () => {
    // 0.1.7 — `hlsPlayer` moved to `/api/config` (read-once on app boot).
    // The status response is now liveness-only.
    return status();
  });

  app.post('/api/share/reconnect', async () => {
    return reconnect();
  });
}
