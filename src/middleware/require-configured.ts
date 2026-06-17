import type { FastifyRequest, FastifyReply } from 'fastify';
import { isConfigured } from '../config.js';

/**
 * 0.1.13 — gate library / scan / playback routes until the install is set up.
 *
 * A fresh clone boots in "needs setup" mode: the static UI, `/api/setup-state`,
 * and the settings routes serve normally so the FTUE wizard can collect the
 * TMDB key + media folder. Everything that actually touches the library is
 * closed behind this guard, returning `503 not_configured` until both exist.
 *
 * `isConfigured()` reads the live config, so the moment the wizard saves valid
 * settings (which triggers `reloadConfig()`), these routes open — no restart.
 */
export async function requireConfigured(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isConfigured()) {
    reply.code(503).send({ error: 'not_configured' });
  }
}
