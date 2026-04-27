import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveLogFilePath,
  readLastLines,
} from '../../src/routes/admin.js';

let goodDir: string;
let logFile: string;

beforeAll(async () => {
  goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-routes-admin-'));
  logFile = path.join(goodDir, 'server.log');
  process.env.TMDB_API_KEY ??= 'test-key';
  process.env.MEDIA_ROOT = goodDir;
  process.env.LOG_FILE_PATH = logFile;
});

afterAll(async () => {
  await fs.rm(goodDir, { recursive: true, force: true });
  delete process.env.LOG_FILE_PATH;
});

describe('readLastLines()', () => {
  beforeEach(async () => {
    try { await fs.unlink(logFile); } catch { /* fine */ }
  });

  it('returns an empty array when the file is missing', async () => {
    const out = await readLastLines(path.join(goodDir, 'nope.log'), 10);
    expect(out).toEqual([]);
  });

  it('returns the last N lines when the file has more than N', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `{"i":${i}}`);
    await fs.writeFile(logFile, lines.join('\n') + '\n');
    const out = await readLastLines(logFile, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('{"i":45}');
    expect(out[4]).toBe('{"i":49}');
  });

  it('returns every line when the file has fewer than N', async () => {
    const lines = ['{"i":0}', '{"i":1}', '{"i":2}'];
    await fs.writeFile(logFile, lines.join('\n') + '\n');
    const out = await readLastLines(logFile, 100);
    expect(out).toEqual(lines);
  });

  it('handles a file with no trailing newline', async () => {
    await fs.writeFile(logFile, '{"i":0}\n{"i":1}');
    const out = await readLastLines(logFile, 5);
    expect(out).toEqual(['{"i":0}', '{"i":1}']);
  });
});

describe('resolveLogFilePath()', () => {
  it('honors LOG_FILE_PATH when set', () => {
    expect(resolveLogFilePath({ LOG_FILE_PATH: '/tmp/x.log' })).toBe(path.resolve('/tmp/x.log'));
  });

  it('falls back to PROGRAMDATA on Windows', () => {
    expect(
      resolveLogFilePath({ PROGRAMDATA: 'C:\\ProgramData' }),
    ).toBe(path.join('C:\\ProgramData', 'HomeMedia', 'logs', 'server.log'));
  });
});

describe('GET /api/admin/log-tail', () => {
  beforeEach(async () => {
    try { await fs.unlink(logFile); } catch { /* fine */ }
  });

  it('returns the tail when called from loopback', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `{"i":${i}}`);
    await fs.writeFile(logFile, lines.join('\n') + '\n');
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/log-tail?n=3',
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lines).toHaveLength(3);
      expect(body.lines[2]).toBe('{"i":9}');
      expect(body.path).toBe(logFile);
    } finally {
      await app.close();
    }
  });

  it('rejects non-loopback callers with 403', async () => {
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/log-tail',
        remoteAddress: '192.168.1.50',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'loopback_only' });
    } finally {
      await app.close();
    }
  });

  it('caps n at 5000 and rejects negative / non-numeric values', async () => {
    await fs.writeFile(logFile, 'a\nb\nc\n');
    const { buildServer } = await import('../../src/server.js');
    const app = await buildServer();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: '/api/admin/log-tail?n=-1',
        remoteAddress: '127.0.0.1',
      });
      expect(r1.json().n).toBe(200); // default
      const r2 = await app.inject({
        method: 'GET',
        url: '/api/admin/log-tail?n=99999',
        remoteAddress: '127.0.0.1',
      });
      expect(r2.json().n).toBe(200); // out-of-range falls back to default
      const r3 = await app.inject({
        method: 'GET',
        url: '/api/admin/log-tail?n=abc',
        remoteAddress: '127.0.0.1',
      });
      expect(r3.json().n).toBe(200);
    } finally {
      await app.close();
    }
  });
});
