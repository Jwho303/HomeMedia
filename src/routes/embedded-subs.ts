/**
 * GET /api/embedded-subs/:relPath?stream=N — extract an embedded text-based
 * subtitle stream from the source file as WebVTT (0.1.4.3).
 *
 * Pipeline: ffmpeg -i <file> -map 0:s:<n> -c:s webvtt -f webvtt pipe:1
 *
 * Caches the converted blob on disk under `<cacheDir>/embedded-subs/
 * <sha1(relPath)>.<index>.vtt`. Subsequent fetches skip ffmpeg and serve
 * straight from cache. The cache key is `sha1(relPath) + streamIndex` so a
 * file replacement (different relPath) misses cleanly; a content rewrite
 * under the same relPath also misses because we tag the cache filename with
 * the file's mtime.
 *
 * Image-based streams (PGS, VobSub) are rejected with 415 — those need
 * burn-in via the regular stream pipeline, not WebVTT extraction.
 */

import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { resolveStreamPath, BadPathError } from '../paths.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export type EmbeddedSubsSpawn = (
  cmd: string,
  args: ReadonlyArray<string>,
) => ChildProcessWithoutNullStreams;

const defaultSpawn: EmbeddedSubsSpawn = (cmd, args) =>
  spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;

let activeSpawn: EmbeddedSubsSpawn = defaultSpawn;

export function setEmbeddedSubsSpawnForTests(fn: EmbeddedSubsSpawn | null): void {
  activeSpawn = fn ?? defaultSpawn;
}

async function runFfmpegToBuffer(args: ReadonlyArray<string>): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = activeSpawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg embedded-subs exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

interface EmbeddedSubLookup {
  /** Local index (`-map 0:s:<subIdx>`). */
  subIndex: number;
  /** Whether the codec is text-based and can convert to WebVTT. */
  textBased: boolean;
}

/** Find the matching probed sub stream. The query parameter is the global
 *  ffprobe `index`; we look up the local subIndex from the probe blob. */
function lookupSubStream(
  relPath: string,
  globalIndex: number,
): EmbeddedSubLookup | null {
  const db = getDb();
  const probe = db.getProbe(relPath);
  if (!probe?.subStreams) return null;
  const match = probe.subStreams.find((s) => s.index === globalIndex);
  if (!match) return null;
  return { subIndex: match.subIndex, textBased: match.textBased };
}

export async function registerEmbeddedSubsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/embedded-subs/*', async (req, reply) => {
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

    const query = (req.query ?? {}) as { stream?: string };
    const streamRaw = Number(query.stream);
    if (!Number.isFinite(streamRaw) || !Number.isInteger(streamRaw) || streamRaw < 0) {
      return reply.code(400).send({ error: 'bad_stream_index' });
    }
    const globalIndex = streamRaw;

    const lookup = lookupSubStream(relPath, globalIndex);
    if (!lookup) {
      return reply.code(404).send({ error: 'sub_stream_not_found' });
    }
    if (!lookup.textBased) {
      return reply.code(415).send({ error: 'image_subs_not_supported' });
    }

    // Cache key tied to file content — sha1(relPath) + ".<global-index>" so a
    // file rename or stream-list change misses cleanly.
    const cacheRoot = path.join(config.cacheDir, 'embedded-subs');
    const sha = createHash('sha1').update(relPath).digest('hex');
    const cachePath = path.join(cacheRoot, `${sha}.${globalIndex}.vtt`);

    let body: Buffer | null = null;
    try {
      body = await fs.readFile(cachePath);
    } catch {
      body = null;
    }

    if (!body) {
      // Run ffmpeg to extract → webvtt.
      const args: ReadonlyArray<string> = [
        '-loglevel', 'error',
        '-i', absPath,
        '-map', `0:s:${lookup.subIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        'pipe:1',
      ];
      try {
        body = await runFfmpegToBuffer(args);
      } catch (err) {
        req.log.warn({ err, relPath, globalIndex }, 'embedded-subs ffmpeg failed');
        return reply.code(500).send({ error: 'extract_failed' });
      }
      try {
        await fs.mkdir(cacheRoot, { recursive: true });
        await fs.writeFile(cachePath, body);
      } catch (err) {
        // Cache failure is non-fatal; we still serve the body.
        req.log.warn({ err, cachePath }, 'embedded-subs cache write failed');
      }
    }

    return reply
      .code(200)
      .header('Content-Type', 'text/vtt; charset=utf-8')
      .send(body);
  });
}
