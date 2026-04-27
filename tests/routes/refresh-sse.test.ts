/**
 * 0.1.5.1 — POST /api/refresh + GET /api/refresh-progress (SSE) integration.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mediaRoot: string;

beforeAll(async () => {
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-refresh-sse-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = mediaRoot;
});

afterAll(async () => {
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

function parseSseFrames(payload: string): unknown[] {
  return payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.slice('data:'.length).trim()));
}

describe('SSE refresh-progress', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
    process.env.MEDIA_ROOT = mediaRoot;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();
    const { _resetJobsForTests } = await import('../../src/scan-progress.js');
    _resetJobsForTests();
  });

  afterEach(async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    setScanForTests(null);
    const { _resetJobsForTests } = await import('../../src/scan-progress.js');
    _resetJobsForTests();
  });

  it('GET /api/refresh-progress returns 204 when no scan is active', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/refresh-progress' });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it('SSE replays buffered events to a late connect and emits done', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    // A scan that emits events synchronously then completes.
    setScanForTests(async (_opts, deps) => {
      deps?.progress?.emit({ type: 'walk', scanned: 3 });
      deps?.progress?.emit({ type: 'diff', dirty: 2, disappeared: 0, total: 3 });
      deps?.progress?.emit({ type: 'file', i: 1, n: 2, path: 'a.mkv', phase: 'identify' });
      deps?.progress?.emit({ type: 'file', i: 2, n: 2, path: 'b.mkv', phase: 'identify' });
      return {
        added: 1, updated: 0, stale: 0, errors: 0, scanned: 3, needsReview: 0,
      };
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const post = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(post.statusCode).toBe(202);
      // Yield a few times so the background scan finishes synchronously.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const sse = await app.inject({ method: 'GET', url: '/api/refresh-progress' });
      expect(sse.statusCode).toBe(200);
      const events = parseSseFrames(sse.payload) as Array<{ type: string }>;
      const types = events.map((e) => e.type);
      expect(types).toContain('walk');
      expect(types).toContain('diff');
      expect(types).toContain('file');
      expect(types[types.length - 1]).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('SSE done event payload matches the ScanResult shape', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    setScanForTests(async () => ({
      added: 5, updated: 1, stale: 0, errors: 0, scanned: 6, needsReview: 0,
    }));
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({ method: 'POST', url: '/api/refresh' });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const sse = await app.inject({ method: 'GET', url: '/api/refresh-progress' });
      const events = parseSseFrames(sse.payload) as Array<{ type: string; result?: unknown }>;
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect(done?.result).toMatchObject({ added: 5, updated: 1, scanned: 6 });
    } finally {
      await app.close();
    }
  });

  it('SSE emits error event when scan throws', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    setScanForTests(async () => {
      throw new Error('boom');
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      await app.inject({ method: 'POST', url: '/api/refresh' });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const sse = await app.inject({ method: 'GET', url: '/api/refresh-progress' });
      const events = parseSseFrames(sse.payload) as Array<{ type: string; message?: string }>;
      const err = events.find((e) => e.type === 'error');
      expect(err?.message).toBe('boom');
    } finally {
      await app.close();
    }
  });

  it('two simultaneous POSTs: first 202, second 409', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    setScanForTests(async () => {
      await slow;
      return { added: 0, updated: 0, stale: 0, errors: 0, scanned: 0, needsReview: 0 };
    });
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const a = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(a.statusCode).toBe(202);
      const b = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(b.statusCode).toBe(409);
      release();
      await new Promise((r) => setImmediate(r));
    } finally {
      await app.close();
    }
  });
});
