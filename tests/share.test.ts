import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set required env BEFORE importing modules that read config.
process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-share-test-default');

const { status } = await import('../src/share.js');

describe('share.status', () => {
  let goodDir: string;
  let badDir: string;

  beforeAll(async () => {
    goodDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-share-'));
    badDir = path.join(os.tmpdir(), `homemedia-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  it('returns online for an existing readable directory', async () => {
    const s = await status(goodDir);
    expect(s.online).toBe(true);
    expect(s.mountPath).toBe(goodDir);
    expect(s.lastSeen).toBeTypeOf('number');
  });

  it('returns offline for a non-existent directory and does not throw', async () => {
    const s = await status(badDir);
    expect(s.online).toBe(false);
    expect(s.mountPath).toBe(badDir);
  });
});
