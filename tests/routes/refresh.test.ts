import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let goodDir: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-refresh-'));
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
});

describe('refresh routes', () => {
  beforeEach(async () => {
    const { openDb, setDb } = await import('../../src/db.js');
    setDb(openDb(':memory:'));
    process.env.MEDIA_ROOT = goodDir;
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

  it('POST /api/refresh returns 503 when share is offline', async () => {
    const missing = path.join(os.tmpdir(), `homemedia-missing-${Date.now()}`);
    process.env.MEDIA_ROOT = missing;
    const { resetConfigForTests } = await import('../../src/config.js');
    resetConfigForTests();

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'share_offline' });
    } finally {
      await app.close();
    }
  });

  it('POST /api/refresh returns 202 + jobId; SSE delivers the ScanResult via done event', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    setScanForTests(async (opts) => ({
      added: 1,
      updated: 0,
      stale: 0,
      errors: 0,
      scanned: 1,
      needsReview: 0,
      _full: opts?.full ?? false,
    } as never));

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/refresh?full=true' });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(typeof body.jobId).toBe('string');
      expect(body.full).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('POST /api/refresh returns 409 when another scan is in flight', async () => {
    const { setScanForTests } = await import('../../src/routes/refresh.js');
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    setScanForTests(async () => {
      await slow;
      return {
        added: 0,
        updated: 0,
        stale: 0,
        errors: 0,
        scanned: 0,
        needsReview: 0,
        disappeared: 0,
        resurrected: 0,
        runId: 1,
      };
    });

    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const first = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(first.statusCode).toBe(202);
      // Yield so the background scan promise begins.
      await new Promise((r) => setImmediate(r));
      const second = await app.inject({ method: 'POST', url: '/api/refresh' });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'scan_in_progress' });
      release();
      // Allow the background scan to settle so the lock releases before next test.
      await new Promise((r) => setImmediate(r));
    } finally {
      await app.close();
    }
  });
});
