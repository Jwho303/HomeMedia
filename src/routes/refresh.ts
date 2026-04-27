import type { FastifyInstance, FastifyReply } from 'fastify';
import { scan as defaultScan, type ScanDeps, type ScanOptions, type ScanResult } from '../scan.js';
import { tryAcquire, currentJobId } from '../scan-lock.js';
import {
  attach,
  markDone,
  markError,
  registerJob,
  type ProgressEvent,
} from '../scan-progress.js';

type ScanFn = (opts?: ScanOptions, deps?: ScanDeps) => Promise<ScanResult>;

let injectedScan: ScanFn | null = null;

/** Tests inject a fake scan to control timing / avoid hitting TMDB. */
export function setScanForTests(fn: ScanFn | null): void {
  injectedScan = fn;
}

export async function registerRefreshRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/refresh', async (req, reply) => {
    const release = tryAcquire();
    if (!release) {
      return reply.code(409).send({ error: 'scan_in_progress' });
    }
    const query = (req.query ?? {}) as { full?: string };
    const full = query.full === 'true';
    const { meta, emitter } = registerJob(full ? 'refresh-hard' : 'refresh-smart');
    const fn = injectedScan ?? ((opts, deps) => defaultScan(opts, deps));
    // Kick off the scan but DO NOT await — the POST returns 202 immediately
    // and the SSE channel delivers progress + completion.
    void Promise.resolve()
      .then(() => fn({ full }, { progress: emitter }))
      .then(
        (result) => {
          markDone(meta.jobId, result);
        },
        (err: Error) => {
          markError(meta.jobId, err.message ?? 'scan_failed');
        },
      )
      .finally(() => {
        release();
      });
    return reply.code(202).send({ jobId: meta.jobId, full });
  });

  app.get('/api/refresh-progress', async (_req, reply) => {
    const jobId = currentJobId();
    if (!jobId) {
      return reply.code(204).send();
    }
    const attachment = attach(jobId);
    if (!attachment) {
      return reply.code(204).send();
    }
    streamSse(reply, attachment.history, (handler) => attachment.subscribe(handler));
    // Returning the reply tells Fastify we're handling the response manually.
    return reply;
  });
}

/** Stream the buffered events, then live ones, as SSE `data: <json>\n\n`. */
function streamSse(
  reply: FastifyReply,
  history: ProgressEvent[],
  subscribe: (handler: (event: ProgressEvent) => void) => () => void,
): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event: ProgressEvent): void => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* socket likely gone — unsubscribe handles it */
    }
  };
  for (const event of history) write(event);
  // If history already ended the stream, close immediately so a slow client
  // that connected after `done` still gets the result then EOF.
  const last = history[history.length - 1];
  if (last && (last.type === 'done' || last.type === 'error')) {
    reply.raw.end();
    return;
  }
  let unsubscribe: () => void = () => {};
  unsubscribe = subscribe((event) => {
    write(event);
    if (event.type === 'done' || event.type === 'error') {
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    }
  });
  reply.raw.on('close', () => {
    unsubscribe();
  });
}
