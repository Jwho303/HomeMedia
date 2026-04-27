/**
 * HLS streaming routes (0.1.6).
 *
 *   GET    /api/hls/master.m3u8?path=<relPath>  — find-or-create the session,
 *                                                 wait for the playlist on
 *                                                 disk, return rewritten m3u8
 *   GET    /api/hls/<sessionId>/seg-NNNNN.ts    — stream one segment
 *   DELETE /api/hls/<sessionId>                 — explicit teardown
 *
 * Segment URIs in the playlist are rewritten to absolute paths under
 * `/api/hls/<sessionId>/seg-NNNNN.ts`. The session id is generated
 * server-side; clients never compose it.
 *
 * Note on URL shape: Fastify's router (find-my-way) requires wildcards to be
 * the last segment, so the relPath rides as a query param (`?path=…`) rather
 * than `/api/hls/<relPath>/master.m3u8`. Behavior is otherwise identical.
 */

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { getDb } from '../db.js';
import { probe, ProbeError, type ProbeResult } from '../probe.js';
import { hasV2Fields } from '../prober.js';
import { getHlsSessionManager } from '../streaming/hls-session.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function parseIntQuery(raw: unknown, min = 0): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return undefined;
  return n;
}

function parseStartQuery(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Rewrite the m3u8 so each segment URI points at `/api/hls/<id>/seg-NNNNN.ts`.
 *  ffmpeg writes the segment basename only (since `-hls_segment_filename`
 *  used the full path), so we just prefix every non-empty non-comment line. */
function rewritePlaylist(raw: string, sessionId: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      if (line.length === 0) return line;
      if (line.startsWith('#')) return line;
      // Strip any directory prefix ffmpeg may have written (it writes the
      // basename when `-hls_segment_filename` is an absolute path on the
      // same fs, but leave the defensive normalization in place).
      const base = path.posix.basename(line.split(/[\\/]/).join('/'));
      return `/api/hls/${sessionId}/${base}`;
    })
    .join('\n');
}

export async function registerHlsRoutes(app: FastifyInstance): Promise<void> {
  // Master playlist — actually `index.m3u8`. The route name is `master.m3u8`
  // so future ABR ladders can grow into it without a URL break.
  app.get('/api/hls/master.m3u8', async (req, reply) => {
    const query = (req.query ?? {}) as {
      path?: string;
      start?: string;
      audio?: string;
      burnSub?: string;
    };
    const relPath = decodePathParam(query.path);
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

    const startSeconds = parseStartQuery(query.start);
    const audioStreamIndex = parseIntQuery(query.audio);
    const burnSubStreamIndex = parseIntQuery(query.burnSub);

    const db = getDb();
    let probeResult: ProbeResult | undefined = db.getProbe(relPath);
    if (!probeResult || !hasV2Fields(probeResult)) {
      try {
        probeResult = await probe(absPath);
        db.setProbe(relPath, probeResult);
      } catch (err) {
        if (err instanceof ProbeError) {
          req.log.warn({ evt: 'probe.error', err, path: relPath }, 'ffprobe failed');
          return reply.code(415).send({ decision: 'external', absPath, error: 'probe_failed' });
        }
        throw err;
      }
    }

    // 0.1.7 — burn-in pre-flight. ffmpeg's `subtitles=` filter only handles
    // text-based subs (subrip/ass/ssa/webvtt). Image-based subs (PGS,
    // dvd_subtitle/VobSub, dvb_subtitle) need overlay+filter_complex which
    // we don't support yet. Without this guard ffmpeg spawns, fails inside
    // `[Parsed_subtitles_2] Only text based subtitles are currently
    // supported`, the playlist never appears, and we wait 30s on
    // `waitForPlaylist` before timing out — confusing UX. Reject early.
    if (burnSubStreamIndex !== undefined) {
      const subStreams = (probeResult as { subStreams?: { subIndex: number; textBased: boolean }[] }).subStreams ?? [];
      const target = subStreams.find((s) => s.subIndex === burnSubStreamIndex);
      if (!target) {
        req.log.warn(
          { evt: 'hls.burnInvalid', relPath, burnSubStreamIndex, reason: 'no_such_sub' },
          'burn-in target sub stream not found',
        );
        return reply.code(415).send({ decision: 'external', absPath, error: 'burn_target_not_found' });
      }
      if (!target.textBased) {
        req.log.warn(
          { evt: 'hls.burnInvalid', relPath, burnSubStreamIndex, reason: 'image_based' },
          'burn-in requested for image-based sub (unsupported by `subtitles=` filter)',
        );
        return reply.code(415).send({
          decision: 'external',
          absPath,
          error: 'burn_image_sub_unsupported',
        });
      }
    }

    const mgr = getHlsSessionManager();
    const opts: {
      startSeconds?: number;
      audioStreamIndex?: number;
      burnSubStreamIndex?: number;
    } = {};
    if (startSeconds > 0) opts.startSeconds = startSeconds;
    if (audioStreamIndex !== undefined) opts.audioStreamIndex = audioStreamIndex;
    if (burnSubStreamIndex !== undefined) opts.burnSubStreamIndex = burnSubStreamIndex;

    let session;
    try {
      session = await mgr.getOrCreate(
        {
          relPath,
          absPath,
          videoCodec: probeResult.videoCodec,
          audioCodec: probeResult.audioCodec,
          container: probeResult.container,
          ...(probeResult.durationSeconds > 0
            ? { durationSeconds: probeResult.durationSeconds }
            : {}),
        } as Parameters<typeof mgr.getOrCreate>[0],
        opts,
      );
    } catch (err) {
      req.log.error({ evt: 'hls.spawnError', err, relPath }, 'hls session create failed');
      return reply.code(500).send({ error: 'session_create_failed' });
    }

    // 30s — enough for HEVC NVENC startup on slow seeks. The legacy
    // pipeline tolerated 4-5s of demuxer probe before the first byte;
    // HLS adds segment-write overhead on top.
    const ok = await mgr.waitForPlaylist(session.id, 30_000);
    if (!ok) {
      req.log.error(
        {
          evt: 'hls.spawnError',
          sessionId: session.id,
          relPath,
          state: session.state,
          stderrTail: session.recentStderr.slice(-15),
          ffmpegArgs: session.ffmpegArgs,
        },
        'hls playlist did not appear in time',
      );
      await mgr.delete(session.id);
      return reply.code(415).send({ decision: 'external', absPath, error: 'hls_unavailable' });
    }

    let playlistText: string;
    try {
      playlistText = await fs.readFile(path.join(session.cacheDir, 'index.m3u8'), 'utf8');
    } catch (err) {
      req.log.error({ evt: 'hls.spawnError', err, sessionId: session.id }, 'hls playlist read failed');
      return reply.code(500).send({ error: 'playlist_read_failed' });
    }
    const rewritten = rewritePlaylist(playlistText, session.id);
    mgr.touch(session.id);
    reply
      .code(200)
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-store')
      // Surface the session id so the client can call DELETE on teardown
      // without parsing the playlist body.
      .header('X-HLS-Session-Id', session.id);
    return reply.send(rewritten);
  });

  // Segment fetch.
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
      req.log.warn(
        { evt: 'hls.segmentMiss', sessionId, segName, reason: 'session_gone' },
        'segment requested for unknown session (likely GCed during pause)',
      );
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
      req.log.info(
        { evt: 'hls.segmentWait', sessionId, segName, sessionState: session.state },
        'segment not yet on disk; waiting',
      );
      // Segment hasn't appeared yet but is expected. Poll for ~5s.
      const ok = await mgr.waitForSegment(sessionId, segName, 5_000);
      if (!ok) {
        req.log.warn(
          { evt: 'hls.segmentMiss', sessionId, segName, reason: 'segment_pending', sessionState: session.state },
          'segment never appeared within 5s',
        );
        return reply.code(425).send({ error: 'segment_pending' });
      }
      try {
        st = await fs.stat(segPath);
      } catch {
        req.log.warn(
          { evt: 'hls.segmentMiss', sessionId, segName, reason: 'segment_gone' },
          'segment vanished after appearing',
        );
        return reply.code(404).send({ error: 'segment_gone' });
      }
    }

    mgr.touch(sessionId);
    // 0.1.7 — emit a tagged event so the console-pretty transport can render
    // segment fetches under the `hls.segment` tag (collapsed in default view,
    // visible in verbose mode).
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

  // Explicit teardown — the player fires this on disconnectedCallback /
  // pagehide via navigator.sendBeacon. Idempotent: 204 even when the session
  // doesn't exist (already torn down by GC, etc.).
  app.delete('/api/hls/:sessionId', async (req, reply) => {
    const params = req.params as { sessionId?: string };
    const sessionId = params.sessionId ?? '';
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
      return reply.code(204).send();
    }
    await getHlsSessionManager().delete(sessionId);
    return reply.code(204).send();
  });

  // sendBeacon defaults to POST and doesn't let you set the method without
  // a fetch fallback. Accept POST as an alias so the beacon works.
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
