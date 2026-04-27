import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mediaRoot: string;

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-subs-'));
  await fs.mkdir(path.join(mediaRoot, 'show'), { recursive: true });
  await fs.writeFile(path.join(mediaRoot, 'show', 'Foo.mkv'), Buffer.alloc(64));
  await fs.writeFile(
    path.join(mediaRoot, 'show', 'Foo.srt'),
    '1\n00:00:01,500 --> 00:00:04,250\nHello\n',
  );
  await fs.writeFile(
    path.join(mediaRoot, 'show', 'Foo.en.vtt'),
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
  );
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
  process.env.OMDB_API_KEY = '';
  process.env.TVDB_API_KEY = '';
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const { openDb, setDb } = await import('../../src/db.js');
  setDb(openDb(':memory:'));
  process.env.MEDIA_ROOT = mediaRoot;
  const { resetConfigForTests } = await import('../../src/config.js');
  resetConfigForTests();
});

describe('subs routes', () => {
  it('GET /api/subs/<srt> returns text/vtt with WEBVTT header and dot separator', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subs/' + encodeURIComponent('show/Foo.srt'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/vtt');
      expect(res.body.startsWith('WEBVTT')).toBe(true);
      expect(res.body).toContain('00:00:01.500 --> 00:00:04.250');
    } finally {
      await app.close();
    }
  });

  it('GET /api/subs/<vtt> returns the raw file unchanged with text/vtt', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subs/' + encodeURIComponent('show/Foo.en.vtt'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/vtt');
      expect(res.body).toContain('WEBVTT');
    } finally {
      await app.close();
    }
  });

  it('GET /api/subs-list/<media> lists sibling subs', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subs-list/' + encodeURIComponent('show/Foo.mkv'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { subs: Array<{ path: string; lang: string | null; ext: string }> };
      expect(body.subs.length).toBe(2);
      // .vtt sorts before .srt
      expect(body.subs[0]!.ext).toBe('vtt');
      expect(body.subs[0]!.lang).toBe('en');
      expect(body.subs[1]!.ext).toBe('srt');
    } finally {
      await app.close();
    }
  });

  it('GET /api/subs/missing returns 404', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subs/' + encodeURIComponent('show/nope.srt'),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('GET /api/subs traversal returns 400 or 404', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/subs/..%2F..%2Fetc%2Fpasswd',
      });
      expect([400, 404]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});
