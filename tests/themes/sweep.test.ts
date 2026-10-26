import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openDb, type DbHandle } from '../../src/db.js';
import { fingerprintArgs, resetChromaprintCacheForTests, type SpawnFn } from '../../src/themes/fingerprint.js';
import { encodeFp } from '../../src/themes/match.js';
import { FINGERPRINT_VERSION, pickAudioIndex, runSweep } from '../../src/themes/sweep.js';
import { listEpisodesNeedingFingerprint } from '../../src/themes/store.js';
import { items, randomFp, rng, windowWith } from './fixtures.js';

/** Fake ffmpeg: `-muxers` lists chromaprint (or not); fingerprint calls emit `fpFor(args)`. */
function fakeSpawn(opts: { chromaprint: boolean; fpFor: (args: string[]) => Uint32Array | null }): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = ((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough };
    child.stdout = new PassThrough();
    setImmediate(() => {
      if (args.includes('-muxers')) {
        child.stdout.end(opts.chromaprint ? ' E  chromaprint     Chromaprint\n' : ' E  mp4\n');
        child.stdout.on('end', () => child.emit('close', 0));
        child.stdout.resume();
        return;
      }
      const fp = opts.fpFor(args);
      child.stdout.end(fp ? encodeFp(fp) : Buffer.alloc(0));
      child.stdout.on('end', () => child.emit('close', fp ? 0 : 1));
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

let db: DbHandle;
let seriesId: number;

const probe = {
  container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 1400,
  audioStreams: [{ index: 1, audioIndex: 0, codec: 'aac', language: null, title: null, channels: 2, default: true, forced: false }],
};

function addEpisode(n: number, probeBlob: object | null, mtime = 1): number {
  const ep = db.upsertEpisode({ series_id: seriesId, path: `Show/S01E0${n}.mkv`, season: 1, episode: n, title: null, overview: null, still_url: null, mtime, scanned_at: 1 });
  if (probeBlob) db.setProbe(ep.path, probeBlob as never);
  return ep.id;
}

beforeEach(() => {
  resetChromaprintCacheForTests();
  db = openDb(':memory:');
  seriesId = db.upsertItem({ path: 'Show', type: 'series', tmdb_id: 1, title: 'Show', year: 2000, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 }).id;
});

describe('pickAudioIndex', () => {
  it('uses the first audio stream, like playback', () => {
    expect(pickAudioIndex(probe as never)).toBe(0);
  });
  it('returns null when the file has no audio', () => {
    expect(pickAudioIndex({ ...probe, audioStreams: [] } as never)).toBeNull();
  });
  it('falls back to stream 0 when not probed', () => {
    expect(pickAudioIndex(null)).toBe(0);
  });
});

describe('fingerprintArgs', () => {
  it('decodes only the chosen audio stream into raw chromaprint', () => {
    const a = fingerprintArgs('/m/x.mkv', { audioIndex: 1, startS: 920, durationS: 480 });
    expect(a).toEqual(expect.arrayContaining(['-ss', '920.000', '-t', '480.000', '-map', '0:a:1', '-vn', '-f', 'chromaprint', '-fp_format', 'raw']));
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
  });
});

describe('runSweep', () => {
  it('fingerprints head + tail, then writes markers', async () => {
    const r = rng(1);
    const op = randomFp(items(40), r);
    for (let i = 1; i <= 3; i++) addEpisode(i, probe);
    const { spawn, calls } = fakeSpawn({
      chromaprint: true,
      fpFor: (args) => (args.includes('-ss') ? windowWith(480, r) : windowWith(600, r, op, 20)),
    });
    const res = await runSweep({ db, mediaRoot: '/m', spawn });
    expect(res.fingerprinted).toBe(3);
    expect(res.series).toBe(1);
    // 1 muxer check + 2 windows × 3 episodes.
    expect(calls.length).toBe(7);
    const tailCall = calls.find((c) => c.includes('-ss'))!;
    expect(tailCall[tailCall.indexOf('-ss') + 1]).toBe('920.000');
    const row = db.raw.prepare('SELECT intro_start FROM episodes WHERE episode = 2').get() as { intro_start: number };
    expect(Math.abs(row.intro_start - 20)).toBeLessThan(1);
    expect(listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION)).toHaveLength(0);
  });

  it('records a no-audio file so it is not retried, without failing the sweep', async () => {
    addEpisode(1, { ...probe, audioStreams: [] });
    const { spawn, calls } = fakeSpawn({ chromaprint: true, fpFor: () => null });
    const res = await runSweep({ db, mediaRoot: '/m', spawn });
    expect(res.failed).toBe(1);
    expect(calls.length).toBe(1); // muxer check only
    expect(listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION)).toHaveLength(0);
  });

  it('re-fingerprints a file whose mtime changed', async () => {
    addEpisode(1, probe, 1);
    const { spawn } = fakeSpawn({ chromaprint: true, fpFor: () => randomFp(100, rng(2)) });
    await runSweep({ db, mediaRoot: '/m', spawn });
    expect(listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION)).toHaveLength(0);
    addEpisode(1, probe, 2);
    expect(listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION)).toHaveLength(1);
  });

  it('does nothing when ffmpeg has no chromaprint muxer', async () => {
    addEpisode(1, probe);
    const warnings: string[] = [];
    const { spawn, calls } = fakeSpawn({ chromaprint: false, fpFor: () => null });
    const res = await runSweep({ db, mediaRoot: '/m', spawn, logger: { info: () => {}, warn: (_o, m) => warnings.push(m) } });
    expect(res.fingerprinted).toBe(0);
    expect(calls.length).toBe(1);
    expect(warnings.length).toBe(1);
  });

  it('never fingerprints movies', () => {
    db.upsertItem({ path: 'Film.mkv', type: 'movie', tmdb_id: 2, title: 'Film', year: 2000, poster_url: null, backdrop_url: null, overview: null, mtime: 1, scanned_at: 1 });
    expect(listEpisodesNeedingFingerprint(db, FINGERPRINT_VERSION)).toHaveLength(0);
  });
});
