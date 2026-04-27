import type { FastifyInstance, FastifyReply } from 'fastify';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { toNativeAbsolute } from '../paths.js';
import { probeFile, type ProbeFileDeps, type ProbeStatus } from '../prober.js';
import { tryAcquire } from '../scan-lock.js';
import { markDone, markError, registerJob } from '../scan-progress.js';

let injectedProberDeps: ProbeFileDeps | null = null;

/** Tests inject a fake probe() to avoid spawning ffprobe. */
export function setProberDepsForTests(deps: ProbeFileDeps | null): void {
  injectedProberDeps = deps;
}

interface ReprobeRow {
  path: string;
  source: 'media_files' | 'episodes';
}

interface ReprobeResult {
  probed: number;
  fresh: number;
  failed: number;
  skipped: number;
}

/**
 * `POST /api/reprobe-library` — explicit, library-wide catch-up. Walks every
 * media_files row + every episodes row and force-probes each file. Returns
 * `{ probed, fresh, failed, skipped }` totals after completion. Holds the
 * shared scan-lock for the duration; concurrent calls return 409.
 *
 * `force: true` is passed to every probeFile() call so the mtime gate is
 * bypassed — this is the action the user takes to bring v1 (0.1.4) probe
 * blobs forward to the v2 (0.1.4.3) shape.
 */
export async function registerReprobeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/reprobe-library', async (_req, reply) => {
    const release = tryAcquire();
    if (!release) {
      return reply.code(409).send({ error: 'scan_in_progress' });
    }
    try {
      const db = getDb();
      const rows = db.raw
        .prepare<[], { path: string; mtime: number; source: string }>(`
          SELECT path, mtime, 'media_files' AS source FROM media_files
          UNION ALL
          SELECT path, mtime, 'episodes' AS source FROM episodes
        `)
        .all();
      return await runReprobe(reply, db, rows.map((r) => r.path), 'reprobe-library');
    } finally {
      release();
    }
  });

  // 0.1.5.1 — per-item Re-probe. Pure file-info refresh: walks every
  // playable file under the item and force-probes it. Does NOT touch
  // identity (tmdb_id, title, poster_url, scanned_at). Shares the same
  // scan-lock + SSE channel as smart/hard refresh.
  app.post<{ Params: { id: string } }>('/api/reprobe-item/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const release = tryAcquire();
    if (!release) {
      return reply.code(409).send({ error: 'scan_in_progress' });
    }
    try {
      const db = getDb();
      const item = db.raw
        .prepare<[number], { id: number; type: 'movie' | 'series' }>(
          `SELECT id, type FROM media_items WHERE id = ?`,
        )
        .get(id);
      if (!item) return reply.code(404).send({ error: 'not_found' });
      let paths: string[];
      if (item.type === 'movie') {
        paths = db.raw
          .prepare<[number], { path: string }>(
            `SELECT path FROM media_files WHERE item_id = ? ORDER BY path`,
          )
          .all(item.id)
          .map((r) => r.path);
      } else {
        paths = db.raw
          .prepare<[number], { path: string }>(
            `SELECT path FROM episodes WHERE series_id = ? ORDER BY path`,
          )
          .all(item.id)
          .map((r) => r.path);
      }
      return await runReprobe(reply, db, paths, 'reprobe-item');
    } finally {
      release();
    }
  });

  // 0.1.5.1 — single-episode Re-probe. One file.
  app.post<{ Params: { id: string } }>('/api/reprobe-episode/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const release = tryAcquire();
    if (!release) {
      return reply.code(409).send({ error: 'scan_in_progress' });
    }
    try {
      const db = getDb();
      const ep = db.raw
        .prepare<[number], { path: string }>(`SELECT path FROM episodes WHERE id = ?`)
        .get(id);
      if (!ep) return reply.code(404).send({ error: 'not_found' });
      return await runReprobe(reply, db, [ep.path], 'reprobe-episode');
    } finally {
      release();
    }
  });
}

/** Shared body for all three reprobe endpoints. Returns `202 { jobId, kind, files }`
 *  immediately and runs the actual work in the background, emitting `probe`
 *  events to the SSE channel. */
async function runReprobe(
  reply: FastifyReply,
  db: ReturnType<typeof getDb>,
  paths: string[],
  kind: 'reprobe-library' | 'reprobe-item' | 'reprobe-episode',
): Promise<FastifyReply> {
  const { meta, emitter } = registerJob(kind);
  const proberDeps = injectedProberDeps ?? {};
  const total = paths.length;
  // Run the actual work without blocking the response — the SSE channel is
  // the completion signal.
  void (async () => {
    const result: ReprobeResult = { probed: 0, fresh: 0, failed: 0, skipped: 0 };
    for (let i = 0; i < paths.length; i++) {
      const relPath = paths[i]!;
      const absPath = toNativeAbsolute(relPath, config.mediaRoot);
      let mtime = 0;
      try {
        const st = await fs.stat(absPath);
        mtime = Math.floor(st.mtimeMs);
      } catch {
        result.skipped++;
        emitter.emit({ type: 'probe', i: i + 1, n: total, path: relPath, status: 'skipped' });
        continue;
      }
      let status: ProbeStatus;
      try {
        status = await probeFile(absPath, relPath, mtime, db, { force: true }, proberDeps);
      } catch {
        result.failed++;
        emitter.emit({ type: 'probe', i: i + 1, n: total, path: relPath, status: 'failed' });
        continue;
      }
      if (status === 'reprobed') result.probed++;
      else if (status === 'fresh') result.fresh++;
      else if (status === 'failed') result.failed++;
      else if (status === 'skipped') result.skipped++;
      emitter.emit({ type: 'probe', i: i + 1, n: total, path: relPath, status });
    }
    markDone(meta.jobId, result as unknown as Record<string, unknown>);
  })().catch((err: Error) => {
    markError(meta.jobId, err.message ?? 'reprobe_failed');
  });
  return reply.code(202).send({ jobId: meta.jobId, kind, files: total });
}

export type { ReprobeResult, ReprobeRow };
