/**
 * Stream metadata for the HLS client (0.1.6).
 *
 * The HLS playlist doesn't carry the same probe data the legacy 415-body
 * pre-probe did (audio streams, sub streams, chapters, container info).
 * The HLS player flow needs that for the audio popover, sub picker, and
 * chapter ticks; this endpoint is the thin wrapper that returns it.
 *
 * Read-only — never spawns ffmpeg. Re-uses the cached probe row in the DB
 * and lazily back-fills v2-shaped data on cache miss / stale entry.
 */

import type { FastifyInstance } from 'fastify';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { getDb } from '../db.js';
import { probe, ProbeError, type ProbeResult } from '../probe.js';
import { hasV2Fields } from '../prober.js';
import { discoverSubs } from '../subs.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function registerStreamMetaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream-meta/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    let absPath: string;
    try {
      absPath = await resolveStreamPath(relPath);
    } catch (err) {
      if (err instanceof BadPathError) {
        return reply.code(400).send({ error: 'bad_path' });
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }

    const db = getDb();
    let probeResult: ProbeResult | undefined = db.getProbe(relPath);
    if (!probeResult || !hasV2Fields(probeResult)) {
      try {
        probeResult = await probe(absPath);
        db.setProbe(relPath, probeResult);
      } catch (err) {
        if (err instanceof ProbeError) {
          req.log.warn({ err, path: relPath }, 'ffprobe failed');
          return reply.code(500).send({ error: 'probe_failed' });
        }
        throw err;
      }
    }

    const subs = await discoverSubs(relPath);

    return reply.send({
      relPath,
      absPath,
      container: probeResult.container,
      videoCodec: probeResult.videoCodec,
      audioCodec: probeResult.audioCodec,
      durationSeconds: probeResult.durationSeconds,
      audioStreams: probeResult.audioStreams ?? [],
      subStreams: probeResult.subStreams ?? [],
      chapters: probeResult.chapters ?? [],
      subs,
    });
  });
}
