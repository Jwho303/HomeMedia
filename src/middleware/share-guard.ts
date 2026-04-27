import type { FastifyRequest, FastifyReply } from 'fastify';
import { status as shareStatus } from '../share.js';

export async function shareGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const s = await shareStatus();
  if (!s.online) {
    reply.code(503).send({ error: 'share_offline' });
  }
}
