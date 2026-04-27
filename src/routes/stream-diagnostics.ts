import type { FastifyInstance } from 'fastify';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { getDb } from '../db.js';
import { probe, ProbeError, type ProbeResult } from '../probe.js';
import { hasV2Fields } from '../prober.js';
import { decide, isVideoTranscodeRequired } from '../playability.js';
import { detectEncoders } from '../encoders.js';
import { buildPipelineArgs, type PipelineOptions } from '../streaming.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Read-only stream-diagnostics endpoint. Returns the probe + the profile that
 * the next stream request from start=0 would use + the would-be ffmpeg arg
 * list. Doesn't trigger an actual ffmpeg spawn — safe for the player overlay
 * to fetch on-demand without disturbing playback.
 */
export async function registerStreamDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream-diagnostics/*', async (req, reply) => {
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
    // 0.1.4.3 — also re-probe when the cached blob is v1-shaped (missing
    // audioStreams). This is the lazy backfill so users who never click the
    // explicit "Re-probe library" button still get track data on demand.
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

    const decision = decide(probeResult);
    const caps = await detectEncoders();
    const preferNvenc =
      decision === 'remux' && caps.nvenc && isVideoTranscodeRequired(probeResult.videoCodec);

    // Pick the *natural* profile for this source — `pickPipelineProfile()`
    // looks at codec + container only and returns the right answer
    // regardless of whether the route's URL flags would force a remux first.
    // For diagnostics we want what the source actually needs, not what the
    // first speculative attempt would do.
    const pipelineOpts: PipelineOptions = {
      audioCodec: probeResult.audioCodec,
      videoCodec: probeResult.videoCodec,
      container: probeResult.container,
    };
    const includesPipeline = decision !== 'direct';
    const built = includesPipeline
      ? buildPipelineArgs(absPath, pipelineOpts)
      : null;

    return reply.send({
      relPath,
      decision,
      probe: {
        container: probeResult.container,
        videoCodec: probeResult.videoCodec,
        audioCodec: probeResult.audioCodec,
        durationSeconds: probeResult.durationSeconds,
        audioStreams: probeResult.audioStreams ?? [],
        subStreams: probeResult.subStreams ?? [],
        chapters: probeResult.chapters ?? [],
      },
      profile: built
        ? {
            name: built.profile.name,
            accel: built.profile.accel,
            audioStrategy: built.audioStrategy,
          }
        : null,
      ffmpegArgs: built ? built.args : null,
      encoderCaps: caps,
      preferAccel: preferNvenc ? 'nvenc' : null,
    });
  });
}
