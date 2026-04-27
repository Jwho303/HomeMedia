/**
 * 0.1.5.1 — scan ↔ prober integration. Asserts the contract from D12:
 *   - smart refresh probes only newOrChanged
 *   - smart refresh on a clean library makes ZERO probeFile calls
 *   - hard refresh probes every file (mtime-gated, no force)
 *   - probe failure is non-fatal
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-probe-wiring-default');
process.env.OMDB_API_KEY = '';
process.env.TVDB_API_KEY = '';

const { openDb } = await import('../src/db.js');
const { scan } = await import('../src/scan.js');

function makeTmdb() {
  const searchMulti = vi.fn(async (query: string) => {
    if (/dune/i.test(query)) {
      return {
        page: 1,
        total_results: 1,
        results: [
          { id: 438631, media_type: 'movie' as const, title: 'Dune', release_date: '2021-10-22', overview: null, poster_path: null, backdrop_path: null },
        ],
      };
    }
    if (/inception/i.test(query)) {
      return {
        page: 1,
        total_results: 1,
        results: [
          { id: 27205, media_type: 'movie' as const, title: 'Inception', release_date: '2010-07-15', overview: null, poster_path: null, backdrop_path: null },
        ],
      };
    }
    return { page: 1, total_results: 0, results: [] };
  });
  return {
    searchMulti, getEpisodes: vi.fn(), getSeries: vi.fn(),
    posterUrl: () => null, stillUrl: () => null,
  };
}

async function makeFixture(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homemedia-probe-wiring-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return root;
}

const onlineShare = async () => ({ online: true, mountPath: '', lastSeen: Date.now() });
const v2 = (): unknown => ({
  container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac',
  durationSeconds: 60, audioStreams: [], subStreams: [], chapters: [],
});

describe('smart refresh probe wiring', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('initial scan → probeFile is called for every newOrChanged file', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    const probeFn = vi.fn(async () => v2() as never);
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('no-change smart refresh → ZERO probeFile calls', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    const probeFn = vi.fn(async () => v2() as never);
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    probeFn.mockClear();
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('add-one-file smart refresh → probeFile called exactly once for the new file', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    const probeFn = vi.fn(async () => v2() as never);
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    probeFn.mockClear();
    await fs.writeFile(path.join(root, 'Inception.2010.mkv'), 'i');
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    expect(probeFn).toHaveBeenCalledTimes(1);
    const calledAbs = (probeFn.mock.calls[0] as unknown as [string])[0];
    expect(calledAbs).toContain('Inception');
  });

  it('hard refresh on a fresh library → probeFile mtime-gated; no ffprobe spawned', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    const probeFn = vi.fn(async () => v2() as never);
    await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    probeFn.mockClear();
    // Hard refresh — re-runs identification but each file's prober call is
    // mtime-gated, so probeFn (the underlying ffprobe spawn) does not fire.
    await scan(
      { full: true },
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('probe failure for one file does NOT abort the scan', async () => {
    const root = await makeFixture({
      'Dune.2021.mkv': 'd',
      'Inception.2010.mkv': 'i',
    });
    const t = makeTmdb();
    let calls = 0;
    const probeFn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return v2() as never;
    });
    const r = await scan(
      {},
      { db, mediaRoot: root, tmdb: t, share: onlineShare, proberDeps: { probe: probeFn } },
    );
    expect(r.errors).toBe(0);
    // One probe failed → only one of the two ticks `probed`.
    expect(r.probed).toBe(1);
    // Both rows still got persisted.
    expect(
      (db.raw.prepare(`SELECT COUNT(*) AS c FROM media_items WHERE type='movie'`).get() as { c: number }).c,
    ).toBe(2);
  });

  it('progress emitter sees probe events alongside file events', async () => {
    const root = await makeFixture({ 'Dune.2021.mkv': 'd' });
    const t = makeTmdb();
    const probeFn = vi.fn(async () => v2() as never);
    const events: Array<{ type: string }> = [];
    const progress = { emit: (e: { type: string }): void => { events.push(e); } };
    await scan(
      {},
      {
        db,
        mediaRoot: root,
        tmdb: t,
        share: onlineShare,
        proberDeps: { probe: probeFn },
        progress,
      },
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('walk');
    expect(types).toContain('diff');
    expect(types).toContain('file');
    expect(types).toContain('probe');
  });
});
