/**
 * Server-driven player routes (0.1.9).
 *
 * Replaces the URL-driven /api/hls/master.m3u8 flow. The client carries a
 * `playerId` (UUID minted on <media-player> mount) on every request; the
 * server owns ffmpeg, the encoded window, and the seek decision.
 *
 *   POST   /api/player/:playerId/open      attach to a relPath
 *   POST   /api/player/:playerId/seek      move to absolute time
 *   POST   /api/player/:playerId/state     heartbeat + position + paused
 *   POST   /api/player/:playerId/tracks    change audio / burn-in / start
 *   DELETE /api/player/:playerId           explicit teardown
 *   POST   /api/player/:playerId/delete    sendBeacon-friendly DELETE alias
 *
 * All endpoints check the identity-owns-playerId rule (D7) — a request can
 * only act on its own player. Mismatch returns 404 (treat as unknown).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { getDb } from '../db.js';
import { probe, ProbeError, type ProbeResult } from '../probe.js';
import { hasV2Fields } from '../prober.js';
import { discoverSubs } from '../subs.js';
import { getHlsSessionManager } from '../streaming/hls-session.js';
import {
  getPlayerInstanceManager,
  CapacityExceededError,
  type PlayerInstance,
} from '../player/instance.js';
import { decideAction } from '../player/seek-decision.js';
import { buildOpenBundle, type PlayerOpenResponse } from '../player/bundle.js';
import { getIdentityResolver, type Identity } from '../identity/resolver.js';
import { PaceController } from '../player/pace-controller.js';

const PLAYER_ID_RE = /^[a-f0-9-]{8,}$/i;

const openBodySchema = z
  .object({
    relPath: z.string().min(1),
    audioStreamIndex: z.number().int().nonnegative().optional(),
    burnSubStreamIndex: z.number().int().nonnegative().optional(),
    /** Resume target in absolute source-seconds. When unset, the server
     *  uses the playback_state row (or 0). */
    startSeconds: z.number().nonnegative().optional(),
  })
  .strict();

const seekBodySchema = z
  .object({
    absoluteSeconds: z.number().nonnegative(),
  })
  .strict();

const stateBodySchema = z
  .object({
    currentLocalSeconds: z.number().nonnegative(),
    paused: z.boolean(),
  })
  .strict();

const tracksBodySchema = z
  .object({
    audioStreamIndex: z.number().int().nonnegative().optional(),
    burnSubStreamIndex: z.number().int().nonnegative().nullable().optional(),
    startSeconds: z.number().nonnegative().optional(),
  })
  .strict();

interface ProbeReady {
  probe: ProbeResult;
  absPath: string;
  burnSubTextBased?: boolean;
}

async function getProbeAndPath(
  relPath: string,
): Promise<ProbeReady | { error: 'bad_path' | 'not_found' | 'probe_failed' | 'not_a_file' | 'empty_file' }> {
  let absPath: string;
  try {
    absPath = await resolveStreamPath(relPath);
  } catch (err) {
    if (err instanceof BadPathError) return { error: 'bad_path' };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'not_found' };
    throw err;
  }
  const fs = await import('node:fs');
  let st;
  try {
    st = await fs.promises.stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'not_found' };
    throw err;
  }
  if (st.isDirectory()) return { error: 'not_a_file' };
  if (st.size === 0) return { error: 'empty_file' };

  const db = getDb();
  let probeResult: ProbeResult | undefined = db.getProbe(relPath);
  if (!probeResult || !hasV2Fields(probeResult)) {
    try {
      probeResult = await probe(absPath);
      db.setProbe(relPath, probeResult);
    } catch (err) {
      if (err instanceof ProbeError) return { error: 'probe_failed' };
      throw err;
    }
  }
  return { probe: probeResult, absPath };
}

/** Validate burnSubStreamIndex against the probe; return null when not set,
 *  or true/false (textBased flag) when valid, or 'invalid' on out-of-range. */
function resolveBurnSub(
  probeResult: ProbeResult,
  burnSubStreamIndex: number | undefined,
): boolean | null | 'invalid' {
  if (burnSubStreamIndex === undefined) return null;
  const target = (probeResult.subStreams ?? []).find((s) => s.subIndex === burnSubStreamIndex);
  if (!target) return 'invalid';
  return target.textBased;
}

interface ActiveTracks {
  audioStreamIndex?: number;
  burnSubStreamIndex?: number;
  burnSubTextBased?: boolean;
  startSeconds?: number;
}

function attachPace(player: PlayerInstance): void {
  if (!player.activeSession) return;
  player.pace?.dispose?.();
  player.pace = new PaceController({
    session: player.activeSession,
    initialPosition: player.lastClientAbsolutePosition,
  });
}

async function spawnSession(
  _player: PlayerInstance | { playerId: string },
  relPath: string,
  ready: ProbeReady,
  tracks: ActiveTracks,
) {
  const mgr = getHlsSessionManager();
  // 0.1.9.1 — each ffmpeg session writes to its own <cacheRoot>/<sessionId>/
  // dir and that dir is wiped on session dispose. The originally-spec'd
  // shared <playerId>/<relPathHash>/<paramsHash>/ layout had a fatal bug:
  // a respawn at a different startSeconds inherited the previous spawn's
  // index.m3u8, which encodedWindow parsing then read as an honest segment
  // map under the new offset → bogus reuse decisions and corrupted MSE
  // append windows. Cross-spawn retention is reopened as a follow-up.
  const opts: Parameters<typeof mgr.getOrCreate>[1] = {};
  if (tracks.startSeconds !== undefined && tracks.startSeconds > 0) {
    opts.startSeconds = Math.floor(tracks.startSeconds);
  }
  if (tracks.audioStreamIndex !== undefined) opts.audioStreamIndex = tracks.audioStreamIndex;
  if (tracks.burnSubStreamIndex !== undefined) opts.burnSubStreamIndex = tracks.burnSubStreamIndex;
  if (tracks.burnSubTextBased !== undefined) opts.burnSubTextBased = tracks.burnSubTextBased;

  const input: Parameters<typeof mgr.getOrCreate>[0] = {
    relPath,
    absPath: ready.absPath,
    videoCodec: ready.probe.videoCodec,
    audioCodec: ready.probe.audioCodec,
    container: ready.probe.container,
  };
  if (ready.probe.durationSeconds > 0) {
    (input as Parameters<typeof mgr.getOrCreate>[0] & { durationSeconds?: number }).durationSeconds =
      ready.probe.durationSeconds;
  }
  return mgr.getOrCreate(input, opts);
}

async function buildBundle(
  player: PlayerInstance,
  relPath: string,
  reused: boolean,
  ready: ProbeReady,
  tracks: ActiveTracks,
): Promise<PlayerOpenResponse> {
  const db = getDb();
  const session = player.activeSession!;
  const siblingSubs = await discoverSubs(relPath);
  const item = db.getByPath(relPath);
  let library: { title: string | null; posterUrl: string | null; backdropUrl: string | null; imdbRating: number | null } | null =
    null;
  if (item) {
    library = {
      title: item.title,
      posterUrl: item.poster_url,
      backdropUrl: item.backdrop_url,
      imdbRating: item.imdb_rating,
    };
  } else {
    const ep = db.getEpisodeByPath(relPath);
    if (ep) {
      const stmt = db.raw.prepare<[number], { title: string | null; poster_url: string | null; backdrop_url: string | null; imdb_rating: number | null }>(
        'SELECT title, poster_url, backdrop_url, imdb_rating FROM media_items WHERE id = ?',
      );
      const series = stmt.get(ep.series_id);
      if (series) {
        library = {
          title: series.title,
          posterUrl: series.poster_url,
          backdropUrl: series.backdrop_url,
          imdbRating: series.imdb_rating,
        };
      }
    }
  }
  const override = db.getManualOverride(relPath);
  const playback = db.getPlayback(relPath);
  const resume = playback
    ? {
        position: playback.position_seconds,
        duration: playback.duration_seconds,
        watched: playback.watched === 1,
      }
    : { position: 0, duration: 0, watched: false };

  return buildOpenBundle({
    playerId: player.playerId,
    relPath,
    reused,
    session: {
      sessionId: session.id,
      playlistUrl: `/api/hls/${session.id}/master.m3u8`,
      encodedWindow: session.encodedWindow,
      startSeconds: session.startSeconds,
    },
    probe: ready.probe,
    siblingSubs,
    library,
    manualOverride: override !== undefined,
    activeAudioStreamIndex: tracks.audioStreamIndex ?? null,
    activeBurnSubStreamIndex: tracks.burnSubStreamIndex ?? null,
    resume,
  });
}

function getIdentity(req: FastifyRequest): Identity {
  if (req.identity) return req.identity;
  const id = getIdentityResolver().resolve(req);
  req.identity = id;
  return id;
}

function paramsId(req: FastifyRequest): string | null {
  const params = req.params as { playerId?: string };
  const id = params.playerId ?? '';
  if (!PLAYER_ID_RE.test(id)) return null;
  return id;
}

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  // Populate req.identity once per request.
  app.addHook('onRequest', async (req) => {
    if (!req.identity) req.identity = getIdentityResolver().resolve(req);
  });

  app.post('/api/player/:playerId/open', async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = paramsId(req);
    if (!playerId) return reply.code(400).send({ error: 'bad_player_id' });

    const parsed = openBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_body', issues: parsed.error.issues });
    }

    const ready = await getProbeAndPath(parsed.data.relPath);
    if ('error' in ready) {
      const map: Record<string, number> = {
        bad_path: 400,
        not_found: 404,
        not_a_file: 404,
        empty_file: 404,
        probe_failed: 415,
      };
      return reply.code(map[ready.error] ?? 500).send({ error: ready.error });
    }

    const burnRes = resolveBurnSub(ready.probe, parsed.data.burnSubStreamIndex);
    if (burnRes === 'invalid') {
      return reply.code(400).send({ error: 'burn_target_not_found' });
    }
    const burnSubTextBased = burnRes === null ? undefined : burnRes;

    // Resume position when client didn't override startSeconds.
    let startSeconds = parsed.data.startSeconds ?? 0;
    if (parsed.data.startSeconds === undefined) {
      const pb = getDb().getPlayback(parsed.data.relPath);
      if (pb && pb.position_seconds > 0) startSeconds = pb.position_seconds;
    }

    const identity = getIdentity(req);
    const mgr = getPlayerInstanceManager();

    const tracks: ActiveTracks = {};
    if (parsed.data.audioStreamIndex !== undefined) tracks.audioStreamIndex = parsed.data.audioStreamIndex;
    if (parsed.data.burnSubStreamIndex !== undefined) tracks.burnSubStreamIndex = parsed.data.burnSubStreamIndex;
    if (burnSubTextBased !== undefined) tracks.burnSubTextBased = burnSubTextBased;
    if (startSeconds > 0) tracks.startSeconds = startSeconds;

    let opened: { player: PlayerInstance; reused: boolean };
    try {
      opened = await mgr.open({
        playerId,
        identity,
        relPath: parsed.data.relPath,
        ...(tracks.audioStreamIndex !== undefined ? { audioStreamIndex: tracks.audioStreamIndex } : {}),
        ...(tracks.burnSubStreamIndex !== undefined
          ? { burnSubStreamIndex: tracks.burnSubStreamIndex }
          : {}),
        ...(tracks.burnSubTextBased !== undefined
          ? { burnSubTextBased: tracks.burnSubTextBased }
          : {}),
        ...(tracks.startSeconds !== undefined ? { startSeconds: tracks.startSeconds } : {}),
        // The manager doesn't read player state from us — the spawn fn
        // has all the inputs it needs (probe, paths, tracks). The callback
        // shape is just a deferred handle for the manager to invoke once
        // it's resolved the open vs media-swap decision.
        spawn: () => spawnSession({ playerId } as unknown as PlayerInstance, parsed.data.relPath, ready, tracks),
      });
    } catch (err) {
      if (err instanceof CapacityExceededError) {
        return reply.code(503).send({
          error: 'capacity_exceeded',
          kind: err.kind === 'global-busy' ? 'global' : 'per_ip',
          limit: err.limit,
          active: err.active,
          retryAfterSeconds: null,
        });
      }
      throw err;
    }

    // Wait for first segment so the bundle's encodedWindow reflects something.
    const hlsMgr = getHlsSessionManager();
    const session = opened.player.activeSession!;
    const ok = await hlsMgr.waitForPlaylist(session.id, 30_000);
    if (!ok) {
      req.log.error(
        {
          evt: 'player.openSpawnError',
          playerId,
          relPath: parsed.data.relPath,
          sessionId: session.id,
          state: session.state,
          ffmpegArgs: session.ffmpegArgs,
          stderrTail: session.recentStderr.slice(-20),
        },
        'hls playlist did not appear in time',
      );
      await mgr.retireSession(opened.player);
      return reply.code(415).send({ error: 'hls_unavailable' });
    }
    await hlsMgr.refreshEncodedWindow(opened.player.activeSession!.id).catch(() => undefined);
    attachPace(opened.player);

    const bundle = await buildBundle(
      opened.player,
      parsed.data.relPath,
      opened.reused,
      ready,
      tracks,
    );
    return reply.code(200).send(bundle);
  });

  app.post('/api/player/:playerId/seek', async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = paramsId(req);
    if (!playerId) return reply.code(400).send({ error: 'bad_player_id' });
    const parsed = seekBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', issues: parsed.error.issues });

    const identity = getIdentity(req);
    const mgr = getPlayerInstanceManager();
    const player = mgr.ownedBy(playerId, identity);
    if (!player || !player.relPath || !player.activeSession) {
      return reply.code(404).send({ error: 'player_not_found' });
    }

    const hlsMgr = getHlsSessionManager();
    await hlsMgr.refreshEncodedWindow(player.activeSession.id).catch(() => undefined);
    // 'finished' means ffmpeg encoded the whole stream and exited; segments
    // are still on disk and the playlist is complete. Treat as running for
    // seek-decision purposes — the in-window check is what matters.
    const sessionState =
      player.activeSession.state === 'errored' || player.activeSession.state === 'killed'
        ? 'gone'
        : 'running';
    const decision = decideAction({
      targetSeconds: parsed.data.absoluteSeconds,
      encodedWindow: player.activeSession.encodedWindow,
      sessionState,
    });

    if (decision.mode === 'reuse') {
      mgr.recordPing(player, parsed.data.absoluteSeconds, false);
      player.pace?.tick(parsed.data.absoluteSeconds);
      return reply.code(200).send({
        sessionId: player.activeSession.id,
        playlistUrl: `/api/hls/${player.activeSession.id}/master.m3u8`,
        encodedWindow: player.activeSession.encodedWindow,
        mode: 'reuse',
        action: { kind: 'set-current-time', localSeconds: decision.localSeconds! },
      });
    }

    // Respawn path. Retire current ffmpeg, spawn at target.
    const ready = await getProbeAndPath(player.relPath);
    if ('error' in ready) {
      return reply.code(500).send({ error: ready.error });
    }
    const tracks: ActiveTracks = {
      startSeconds: parsed.data.absoluteSeconds,
    };
    if (player.activeSession.audioStreamIndex !== undefined) {
      tracks.audioStreamIndex = player.activeSession.audioStreamIndex;
    }
    if (player.activeSession.burnSubStreamIndex !== undefined) {
      tracks.burnSubStreamIndex = player.activeSession.burnSubStreamIndex;
      const burnRes = resolveBurnSub(ready.probe, tracks.burnSubStreamIndex);
      if (burnRes !== null && burnRes !== 'invalid') tracks.burnSubTextBased = burnRes;
    }
    await mgr.retireSession(player);
    const session = await spawnSession(player, player.relPath, ready, tracks);
    mgr.setActiveSession(player, session);
    const ok = await hlsMgr.waitForPlaylist(session.id, 30_000);
    if (!ok) {
      req.log.error(
        {
          evt: 'player.seekSpawnError',
          playerId,
          relPath: player.relPath,
          sessionId: session.id,
          state: session.state,
          ffmpegArgs: session.ffmpegArgs,
          stderrTail: session.recentStderr.slice(-20),
        },
        'hls playlist did not appear in time after seek-respawn',
      );
      await mgr.retireSession(player);
      return reply.code(500).send({ error: 'hls_unavailable' });
    }
    await hlsMgr.refreshEncodedWindow(session.id).catch(() => undefined);
    mgr.recordPing(player, parsed.data.absoluteSeconds, false);
    attachPace(player);
    return reply.code(200).send({
      sessionId: session.id,
      playlistUrl: `/api/hls/${session.id}/master.m3u8`,
      encodedWindow: session.encodedWindow,
      mode: 'respawn',
      action: { kind: 'reattach', pendingResumeAt: 0 },
    });
  });

  app.post('/api/player/:playerId/state', async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = paramsId(req);
    if (!playerId) return reply.code(400).send({ error: 'bad_player_id' });
    const parsed = stateBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', issues: parsed.error.issues });

    const identity = getIdentity(req);
    const mgr = getPlayerInstanceManager();
    const player = mgr.ownedBy(playerId, identity);
    if (!player) {
      return reply.code(410).send({ status: 'gone' });
    }
    if (!player.activeSession) {
      return reply.code(410).send({ status: 'gone' });
    }

    const hlsMgr = getHlsSessionManager();
    await hlsMgr.refreshEncodedWindow(player.activeSession.id).catch(() => undefined);
    // A 'finished' ffmpeg is still serving — segments are on disk and
    // playable. Only 'errored' or 'killed' constitute gone-ness, plus
    // the missing-session case handled above.
    const sessionAlive = player.activeSession.state !== 'errored' && player.activeSession.state !== 'killed';
    const absolute =
      player.activeSession.encodedWindow.from + parsed.data.currentLocalSeconds;
    mgr.recordPing(player, absolute, parsed.data.paused);
    player.pace?.tick(absolute);
    // Touch the underlying HLS session so its idle GC doesn't reap it
    // out from under us when buffered playback skips segment fetches.
    hlsMgr.touch(player.activeSession.id);
    return reply.code(200).send({
      status: sessionAlive ? 'alive' : 'gone',
      encodedWindow: player.activeSession.encodedWindow,
      encodePaused: player.activeSession.encodePaused,
    });
  });

  app.post('/api/player/:playerId/tracks', async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = paramsId(req);
    if (!playerId) return reply.code(400).send({ error: 'bad_player_id' });
    const parsed = tracksBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_body', issues: parsed.error.issues });

    const identity = getIdentity(req);
    const mgr = getPlayerInstanceManager();
    const player = mgr.ownedBy(playerId, identity);
    if (!player || !player.relPath || !player.activeSession) {
      return reply.code(404).send({ error: 'player_not_found' });
    }

    // Always respawn — track changes are destructive.
    const ready = await getProbeAndPath(player.relPath);
    if ('error' in ready) return reply.code(500).send({ error: ready.error });

    const newAudio =
      parsed.data.audioStreamIndex !== undefined
        ? parsed.data.audioStreamIndex
        : player.activeSession.audioStreamIndex;
    const newBurn =
      parsed.data.burnSubStreamIndex === null
        ? undefined
        : parsed.data.burnSubStreamIndex !== undefined
          ? parsed.data.burnSubStreamIndex
          : player.activeSession.burnSubStreamIndex;
    let burnSubTextBased: boolean | undefined;
    if (newBurn !== undefined) {
      const r = resolveBurnSub(ready.probe, newBurn);
      if (r === 'invalid') return reply.code(400).send({ error: 'burn_target_not_found' });
      if (r !== null) burnSubTextBased = r;
    }

    // 0.1.9.1 — each ffmpeg session owns its own <sessionId>/ dir (wiped
    // on retireSession), so a track change just retires-and-respawns; no
    // per-params subtree to clean up.
    const startSeconds =
      parsed.data.startSeconds ?? player.lastClientAbsolutePosition;

    await mgr.retireSession(player);

    const tracks: ActiveTracks = { startSeconds };
    if (newAudio !== undefined) tracks.audioStreamIndex = newAudio;
    if (newBurn !== undefined) tracks.burnSubStreamIndex = newBurn;
    if (burnSubTextBased !== undefined) tracks.burnSubTextBased = burnSubTextBased;

    const session = await spawnSession(player, player.relPath, ready, tracks);
    mgr.setActiveSession(player, session);
    const hlsMgr = getHlsSessionManager();
    const ok = await hlsMgr.waitForPlaylist(session.id, 30_000);
    if (!ok) {
      req.log.error(
        {
          evt: 'player.tracksSpawnError',
          playerId,
          relPath: player.relPath,
          sessionId: session.id,
          state: session.state,
          ffmpegArgs: session.ffmpegArgs,
          stderrTail: session.recentStderr.slice(-20),
        },
        'hls playlist did not appear in time after tracks-respawn',
      );
      await mgr.retireSession(player);
      return reply.code(500).send({ error: 'hls_unavailable' });
    }
    await hlsMgr.refreshEncodedWindow(session.id).catch(() => undefined);
    mgr.recordPing(player, startSeconds, false);
    attachPace(player);

    const bundle = await buildBundle(player, player.relPath, true, ready, tracks);
    return reply.code(200).send(bundle);
  });

  const closeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const playerId = paramsId(req);
    if (!playerId) return reply.code(204).send();
    const identity = getIdentity(req);
    const mgr = getPlayerInstanceManager();
    const player = mgr.ownedBy(playerId, identity);
    if (player) await mgr.close(playerId);
    return reply.code(204).send();
  };

  app.delete('/api/player/:playerId', closeHandler);
  // sendBeacon is POST-only; mirror the legacy /touch alias pattern.
  app.post('/api/player/:playerId/delete', closeHandler);

  // Per-session HLS playlist (so the client can hit the same URL the bundle
  // returned without poking at the legacy ?path= surface). Reads the
  // current segment timings off disk and rewrites segment URIs to absolute
  // paths under /api/hls/<sessionId>/.
  app.get('/api/hls/:sessionId/master.m3u8', async (req, reply) => {
    const params = req.params as { sessionId?: string };
    const sessionId = params.sessionId ?? '';
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) {
      return reply.code(400).send({ error: 'bad_session' });
    }
    const hlsMgr = getHlsSessionManager();
    const session = hlsMgr.get(sessionId);
    if (!session) return reply.code(410).send({ error: 'session_gone' });
    const fs = await import('node:fs');
    const path = await import('node:path');
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(session.cacheDir, 'index.m3u8'), 'utf8');
    } catch {
      return reply.code(425).send({ error: 'playlist_pending' });
    }
    const rewritten = raw
      .split(/\r?\n/)
      .map((line) => {
        if (line.length === 0 || line.startsWith('#')) return line;
        const base = path.posix.basename(line.split(/[\\/]/).join('/'));
        return `/api/hls/${sessionId}/${base}`;
      })
      .join('\n');
    hlsMgr.touch(sessionId);
    reply
      .code(200)
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-store')
      .header('X-HLS-Session-Id', sessionId);
    return reply.send(rewritten);
  });
}
