import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import { resolveStreamPath, BadPathError } from '../paths.js';
import {
  parseRange,
  streamFile,
  runPipeline,
  type PipelineOptions,
} from '../streaming.js';
import { resolveProfile } from '../streaming.js';
import { getDb } from '../db.js';
import { probe, ProbeError } from '../probe.js';
import { hasV2Fields } from '../prober.js';
import { decide, isVideoTranscodeRequired } from '../playability.js';
import { discoverSubs } from '../subs.js';
import { detectEncoders } from '../encoders.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream/*', async (req, reply) => {
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

    // Defend against two stream targets that would otherwise reach parseRange
    // and return a confusing 416: a directory (the library normally points at
    // the playable file, but a stale row could still resolve to a folder), or
    // a 0-byte file (incomplete download / torrent stub).
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return reply.code(404).send({ error: 'not_a_file' });
      }
      if (st.size === 0) {
        return reply.code(404).send({ error: 'empty_file' });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }

    const query = (req.query ?? {}) as {
      remux?: string;
      accel?: string;
      start?: string;
      audio?: string;
      burnSub?: string;
    };
    const wantRemux = query.remux === 'true';
    const wantAccel = query.accel === 'nvenc';
    const startSeconds = (() => {
      const raw = Number(query.start);
      if (!Number.isFinite(raw) || raw <= 0) return 0;
      return raw;
    })();
    const audioStreamIndex = (() => {
      if (query.audio === undefined) return undefined;
      const raw = Number(query.audio);
      if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) return undefined;
      return raw;
    })();
    const burnSubStreamIndex = (() => {
      if (query.burnSub === undefined) return undefined;
      const raw = Number(query.burnSub);
      if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) return undefined;
      return raw;
    })();

    const db = getDb();
    let probeResult = db.getProbe(relPath);
    // 0.1.4.3 — also re-probe when the cached blob is v1-shaped (missing
    // audioStreams). Backfills track + chapter data lazily for files probed
    // before 0.1.4.3 landed, without needing the explicit re-probe button.
    if (!probeResult || !hasV2Fields(probeResult)) {
      try {
        probeResult = await probe(absPath);
        db.setProbe(relPath, probeResult);
      } catch (err) {
        if (err instanceof ProbeError) {
          req.log.warn({ err, path: relPath }, 'ffprobe failed');
          if (wantRemux || wantAccel) {
            return reply.code(500).send({ error: 'probe_failed' });
          }
        } else {
          throw err;
        }
      }
    }

    const decision = probeResult ? decide(probeResult) : 'direct';

    const pipelineOpts: PipelineOptions = { startSeconds };
    if (probeResult?.audioCodec) pipelineOpts.audioCodec = probeResult.audioCodec;
    if (probeResult?.videoCodec) pipelineOpts.videoCodec = probeResult.videoCodec;
    if (probeResult?.container) pipelineOpts.container = probeResult.container;
    if (audioStreamIndex !== undefined) pipelineOpts.audioStreamIndex = audioStreamIndex;
    if (burnSubStreamIndex !== undefined) pipelineOpts.burnSubStreamIndex = burnSubStreamIndex;
    // 0.1.4.3 — picking a non-default audio track on a `direct` source forces
    // a remux upgrade (the bytes-as-file path can't honor `-map 0:a:N`). Same
    // for burn-in subs, which require an NVENC re-encode.
    const wantAudioOverride = audioStreamIndex !== undefined;
    const wantBurnSub = burnSubStreamIndex !== undefined;

    if (wantAccel || wantBurnSub) {
      const caps = await detectEncoders();
      if (!caps.nvenc) {
        return reply.code(415).send({ error: 'nvenc_unavailable' });
      }
      runPipeline(absPath, reply, relPath, { ...pipelineOpts, forceNvenc: true });
      return reply;
    }

    if (wantRemux) {
      if (decision === 'external') {
        return reply.code(415).send({ decision: 'external' });
      }
      runPipeline(absPath, reply, relPath, { ...pipelineOpts, forceRemux: true });
      return reply;
    }

    // Audio-track override on a `direct` source: silently upgrade to a remux
    // pipeline, since the raw file bytes can't honor `-map 0:a:N`.
    if (wantAudioOverride && decision === 'direct' && probeResult) {
      runPipeline(absPath, reply, relPath, { ...pipelineOpts, forceRemux: true });
      return reply;
    }

    if (decision === 'remux' || decision === 'external') {
      const subs = await discoverSubs(relPath);
      const caps = await detectEncoders();
      const body: {
        decision: 'remux' | 'external';
        subs: typeof subs;
        durationSeconds?: number;
        absPath?: string;
        container?: string;
        videoCodec?: string;
        audioCodec?: string;
        accel?: { nvenc: boolean };
        preferAccel?: 'nvenc';
        /** 0.1.4.2 — name of the profile that would be selected if the
         *  client now opens a remux/accel stream. Lets the player overlay
         *  show the profile without a separate diagnostics fetch. */
        profile?: string;
        audioStreams?: NonNullable<typeof probeResult>['audioStreams'];
        subStreams?: NonNullable<typeof probeResult>['subStreams'];
        chapters?: NonNullable<typeof probeResult>['chapters'];
      } = {
        decision,
        subs,
      };
      if (probeResult && probeResult.durationSeconds > 0) {
        body.durationSeconds = probeResult.durationSeconds;
      }
      if (probeResult) {
        body.container = probeResult.container;
        body.videoCodec = probeResult.videoCodec;
        body.audioCodec = probeResult.audioCodec;
        if (probeResult.audioStreams) body.audioStreams = probeResult.audioStreams;
        if (probeResult.subStreams) body.subStreams = probeResult.subStreams;
        if (probeResult.chapters) body.chapters = probeResult.chapters;
      }
      if (decision === 'external') {
        body.absPath = absPath;
      }
      body.accel = { nvenc: caps.nvenc };
      const preferNvenc =
        decision === 'remux' &&
        caps.nvenc &&
        probeResult &&
        isVideoTranscodeRequired(probeResult.videoCodec);
      if (preferNvenc) {
        body.preferAccel = 'nvenc';
      }
      if (decision === 'remux' && probeResult) {
        // Predict the profile the next stream request would use. When the
        // server is hinting NVENC, predict against the NVENC override —
        // otherwise predict the natural remux choice.
        const predicted = resolveProfile(absPath, {
          ...pipelineOpts,
          forceNvenc: preferNvenc ? true : false,
          forceRemux: !preferNvenc,
        });
        body.profile = predicted.name;
      }
      return reply.code(415).send(body);
    }

    // direct: stream bytes with Range support.
    let size: number;
    try {
      size = (await fs.stat(absPath)).size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }

    const range = parseRange(req.headers.range, size);
    await streamFile(reply, absPath, range);
    return reply;
  });
}
