import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveStreamPath, BadPathError } from '../paths.js';
import { discoverSubs, srtToVtt } from '../subs.js';

function decodePathParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function registerSubsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/subs/*', async (req, reply) => {
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

    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.srt' && ext !== '.vtt') {
      return reply.code(415).send({ error: 'unsupported_subtitle_format' });
    }

    let text: string;
    try {
      text = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }

    const body = ext === '.srt' ? srtToVtt(text) : text;
    return reply
      .code(200)
      .header('Content-Type', 'text/vtt; charset=utf-8')
      .send(body);
  });

  app.get('/api/subs-list/*', async (req, reply) => {
    const params = req.params as { '*'?: string };
    const relPath = decodePathParam(params['*']);
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    try {
      // Validate the media path exists & is inside MEDIA_ROOT before scanning siblings.
      await resolveStreamPath(relPath);
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

    const subs = await discoverSubs(relPath);
    return { subs };
  });
}
