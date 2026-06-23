import type { FastifyInstance } from 'fastify';
import { getHlsSessionManager } from '../streaming/hls-session.js';

/**
 * Receives a diagnostic report from the player UI and writes it into the
 * server log. Used by the player's "Report" button when the user can't
 * easily copy/paste console output between machines (remote shares, mobile
 * browsers, etc.).
 *
 * Registered outside the share-guard scope on purpose: reports about
 * playback failures are most valuable precisely when the share is offline.
 *
 * Body limit is bumped to 2 MB on this route — diagnostic dumps for files
 * with many subtitle streams + console-log ring buffers can be ~50–200 KB
 * and we'd rather log a big report than reject it.
 */
export async function registerClientLogRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/client-log',
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body;
      // Accept anything JSON-shaped. We're not interpreting the payload —
      // just pretty-printing it back out so `tail -f` of the server log shows
      // the report verbatim.
      const ua = req.headers['user-agent'] ?? null;
      const tag = (typeof body === 'object' && body !== null && 'tag' in body
        ? String((body as { tag?: unknown }).tag ?? '')
        : '') || 'player-report';

      // Pull a few high-signal fields up to the structured log line so the
      // console-pretty transport can render a 3-line summary (tag, relPath,
      // top reason) without re-inflating the whole JSON dump every time.
      // The transport never collapses these — they always print (D10).
      const obj = (typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {});

      // 0.1.7 — when the report names an HLS-mode failure (current OR
      // recent), splice in ffmpeg stderr from any live OR recently-disposed
      // session for the same relPath. MSE-side errors like
      // DEMUXER_ERROR_COULD_NOT_PARSE need the encoder's view to diagnose;
      // without this we'd be blind to NVENC warnings, missing IDRs, PTS
      // discontinuities, etc.
      //
      // Note: the player auto-falls-back from HLS to external on the first
      // <video>.error, which means by the time this POST arrives, the
      // top-level playMode is already 'external'. The HLS failure shows up
      // in `failureLog` instead. Check both.
      let augmented: unknown = body;
      const failureLog = Array.isArray(obj.failureLog) ? obj.failureLog : [];
      const hadHlsFailure = failureLog.some(
        (f) => typeof f === 'object' && f !== null && (f as { playMode?: unknown }).playMode === 'hls',
      );
      const isHlsContext = obj.playMode === 'hls' || hadHlsFailure;
      if (typeof obj.relPath === 'string' && isHlsContext) {
        const stderrDumps = getHlsSessionManager().recentStderrFor(obj.relPath);
        if (stderrDumps.length > 0) {
          augmented = { ...obj, ffmpegStderrByLiveSession: stderrDumps };
        }
      }
      const pretty = JSON.stringify(augmented, null, 2);
      const summary: Record<string, unknown> = {
        evt: 'client-report',
        reportTag: tag,
        ua,
        bytes: pretty.length,
      };
      if (typeof obj.relPath === 'string') summary.relPath = obj.relPath;
      if (typeof obj.reason === 'string') summary.reason = obj.reason;
      if (typeof obj.playMode === 'string') summary.playMode = obj.playMode;
      // 0.2.0 (D8) — boot router diagnosis. `boot.js` POSTs
      // { tag:'device.boot', device:{ bucket, inputMode, platform, ... } } on
      // every boot. Hoist the high-signal fields onto the structured line so
      // `tail`-ing the log shows which devices report which bucket without
      // re-inflating the JSON. We don't validate the shape — any JSON-shaped
      // body is accepted (a boot log must never be rejected); we just surface
      // the fields when present.
      const device = (typeof obj.device === 'object' && obj.device !== null
        ? (obj.device as Record<string, unknown>)
        : null);
      if (device) {
        if (typeof device.bucket === 'string') summary.bucket = device.bucket;
        if (typeof device.inputMode === 'string') summary.inputMode = device.inputMode;
        if (typeof device.platform === 'string') summary.platform = device.platform;
      }
      req.log.info(summary, `[client-log] ${tag}`);
      // The full pretty dump still goes to stdout for humans tailing the
      // console — the structured line above is for the log file / scrapers.
      console.log(`\n=== client-log: ${tag} ===\n${pretty}\n=== end ===\n`);

      return reply.code(204).send();
    },
  );
}
