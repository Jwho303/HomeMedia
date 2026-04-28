import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { makeConsolePrettyStream, ConsolePrettyStream } from './log/console-pretty.js';
import { StatusBlock } from './log/status-block.js';
import { registerShareRoutes } from './routes/share.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerPlaybackRoutes } from './routes/playback.js';
import { registerRefreshRoutes } from './routes/refresh.js';
import { registerReprobeRoutes } from './routes/reprobe.js';
import { registerHlsRoutes } from './routes/hls.js';
import { registerStreamMetaRoutes } from './routes/stream-meta.js';
import { registerClientLogRoutes } from './routes/client-log.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSubsRoutes } from './routes/subs.js';
import { registerEmbeddedSubsRoutes } from './routes/embedded-subs.js';
import { registerManualIdentifyRoutes } from './routes/manual-identify.js';
import { shareGuard } from './middleware/share-guard.js';
import { getHlsSessionManager } from './streaming/hls-session.js';
import { detectEncoders } from './encoders.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// `src/server.ts` → repo-root/web/dist
const WEB_DIST = path.resolve(here, '..', 'web', 'dist');

export interface BuildServerOptions {
  /** 0.1.7 — when true, plug the console-pretty transport in front of
   *  Pino's stream. Tests and `start()` both opt in; `buildServer()`'s
   *  default leaves Pino raw so existing tests continue to assert on
   *  silent or default JSON output. */
  prettyConsole?: boolean;
  /** 0.1.7 — caller can pre-construct the transport and pass it in (so
   *  `start()` can attach a StatusBlock to the same instance Fastify is
   *  writing into). When unset and `prettyConsole` is true, `buildServer`
   *  constructs its own. */
  prettyConsoleStream?: ConsolePrettyStream;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const isTest = process.env.NODE_ENV === 'test';
  const baseLogger: Record<string, unknown> = {
    level: isTest ? 'silent' : 'info',
  };
  if (opts.prettyConsole) {
    baseLogger.stream = opts.prettyConsoleStream ?? makeConsolePrettyStream();
  }
  const app = Fastify({
    logger: baseLogger,
    // 0.1.7 D3 — Fastify normally emits two log lines per request (one at
    // receive, one at response). The receive-side line carries no info that
    // isn't on the response side; replacing it with our own onResponse hook
    // halves request-stream volume.
    disableRequestLogging: true,
    bodyLimit: 16 * 1024,
  });

  // 0.1.7 D3 — emit one structured `response` event per request, with the
  // status code and timing the rendered console formats into the `← 200` tag.
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        evt: 'response',
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        ms: Number((reply.elapsedTime ?? 0).toFixed(1)),
        remoteAddress: req.ip,
      },
      'request',
    );
  });

  await app.register(registerShareRoutes);
  await app.register(registerConfigRoutes);
  await app.register(registerLibraryRoutes);
  await app.register(registerPlaybackRoutes);
  // Manual-identify routes scope their own share-guard / scan-lock per route.
  await app.register(registerManualIdentifyRoutes);
  // Client-log accepts diagnostic reports from the player UI. Registered
  // outside the share-guard scope on purpose: reports about playback failures
  // are most valuable precisely when the share is offline.
  await app.register(registerClientLogRoutes);
  // Admin routes — currently just `/api/admin/log-tail`. The route enforces
  // loopback-only access internally; no shareGuard needed.
  await app.register(registerAdminRoutes);

  await app.register(async (s) => {
    s.addHook('onRequest', shareGuard);
    await registerRefreshRoutes(s);
    await registerReprobeRoutes(s);
    await registerHlsRoutes(s);
    await registerStreamMetaRoutes(s);
    await registerSubsRoutes(s);
    await registerEmbeddedSubsRoutes(s);
  });

  app.addHook('onClose', async () => {
    await getHlsSessionManager().shutdownAll();
  });

  // When the frontend has been built, serve it from /. The /api/* routes are
  // already registered above, so @fastify/static naturally falls through.
  if (existsSync(path.join(WEB_DIST, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      wildcard: false,
    });
  }

  return app;
}

export async function start(): Promise<void> {
  // Build the transport up front so the StatusBlock can attach to the same
  // instance Fastify writes through.
  const prettyConsoleStream = makeConsolePrettyStream();
  const app = await buildServer({ prettyConsole: true, prettyConsoleStream });
  const host = process.env.HOST ?? '127.0.0.1';

  const status = new StatusBlock({
    tty: process.stdout.isTTY === true,
    host,
    port: config.port,
  });
  status.attach(prettyConsoleStream);
  // Detach the StatusBlock's periodic timer when the process exits.
  // Registering a Fastify onClose hook here is too late — `app.listen()`
  // has already fired below and Fastify rejects post-listen hook addition.
  // `process.on('exit')` is sufficient: the status block just owns an
  // unref'd interval timer with no async work to flush.
  process.once('exit', () => status.detach());

  // Warm the encoder cache so the first stream request doesn't pay the ffmpeg
  // -encoders cost. Also surfaces NVENC/QSV/VideoToolbox availability in the log.
  const caps = await detectEncoders();
  status.setEncoders(caps);
  app.log.info({ evt: 'startup', encoders: caps }, 'hardware encoders detected');
  // 0.1.6 — sweep the HLS cache root at boot. A hard crash leaves session
  // dirs behind; idle GC only touches sessions this process knows about.
  try {
    await getHlsSessionManager().cleanupOrphans();
  } catch (err) {
    app.log.warn({ evt: 'hls.orphanRmFailed', err }, 'hls orphan cleanup failed');
  }
  await app.listen({ host, port: config.port });
  status.configureListening(host, config.port);
  app.log.info(
    { evt: 'startup', host, port: config.port },
    `homemedia listening on http://${host}:${config.port}`,
  );
}

// Re-export so consumers (status-block, admin route) can pick up the live
// transport instance without a separate registry.
export { ConsolePrettyStream };

// Detect direct invocation via `tsx src/server.ts` (tests import buildServer instead).
const entry = process.argv[1] ?? '';
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
