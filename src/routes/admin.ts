/**
 * Admin routes (0.1.7).
 *
 * `GET /api/admin/log-tail?n=200` — return the last N lines of the JSON log
 * file. Loopback-only: rejects any request whose remoteAddress isn't a
 * 127.x or ::1 loopback. The endpoint exists so the rendered console can
 * stay opinionated about what to show without making the JSON harder to
 * reach for `curl ... | jq` workflows.
 *
 * The log file path resolves from `LOG_FILE_PATH` (preferred) or the NSSM
 * convention `%PROGRAMDATA%\HomeMedia\logs\server.log`. When the file is
 * absent (e.g. `npm run dev` outside NSSM), the route returns an empty
 * lines array with a `path` field pointing at where it expected to find it.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const LOOPBACK_RE = /^(127\.|::1$|::ffff:127\.)/;

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip ?? '';
  return LOOPBACK_RE.test(ip);
}

export function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOG_FILE_PATH && env.LOG_FILE_PATH.length > 0) {
    return path.resolve(env.LOG_FILE_PATH);
  }
  const root = env.PROGRAMDATA ?? '/var/log';
  return path.join(root, 'HomeMedia', 'logs', 'server.log');
}

/**
 * Read the last `n` lines of a file. Reads in 64KB chunks from the tail
 * backwards until we have enough newline-separated lines or the file is
 * exhausted. Cheaper than streaming the whole file when only the tail is
 * wanted; for a 10MB rotated log we read at most a few KB.
 */
export async function readLastLines(filePath: string, n: number): Promise<string[]> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) return [];
    const chunkSize = 64 * 1024;
    let pos = size;
    // We accumulate the tail of the file as a single Buffer. When we have at
    // least n+1 newlines (the +1 covers a possible partial first line) or
    // we've read the entire file, we split and return.
    let buf = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await handle.read(chunk, 0, len, pos);
      buf = Buffer.concat([chunk, buf]);
      // Count newlines to decide whether to stop reading.
      let newlines = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlines++;
      }
      if (newlines >= n + 1) break;
    }
    const text = buf.toString('utf8');
    // The first segment may be a partial line if pos > 0 (we started in the
    // middle of a line). Drop it by slicing from the first newline.
    let trimmed = text;
    if (pos > 0) {
      const i = trimmed.indexOf('\n');
      trimmed = i >= 0 ? trimmed.slice(i + 1) : '';
    }
    const lines = trimmed.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  } finally {
    await handle.close();
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/log-tail', async (req, reply) => {
    if (!isLoopback(req)) {
      return reply.code(403).send({ error: 'loopback_only' });
    }
    const query = (req.query ?? {}) as { n?: string };
    let n = 200;
    if (typeof query.n === 'string') {
      const parsed = Number(query.n);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 5_000) {
        n = Math.floor(parsed);
      }
    }
    const filePath = resolveLogFilePath();
    const lines = await readLastLines(filePath, n);
    return { path: filePath, n, lines };
  });
}
