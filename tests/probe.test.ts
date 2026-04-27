import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { probe } from '../src/probe.js';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

function makeFakeSpawn(stdout: string, stderr = '', exitCode = 0): typeof import('node:child_process').spawn {
  return ((..._args: unknown[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([stderr]);
    queueMicrotask(() => {
      // Drain streams before emitting close so the data handlers run.
      child.stdout.on('end', () => {
        queueMicrotask(() => child.emit('close', exitCode));
      });
      child.stdout.resume();
      child.stderr.resume();
    });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as typeof import('node:child_process').spawn;
}

describe('probe()', () => {
  it('parses container, codecs and duration from ffprobe JSON', async () => {
    const fakeOut = JSON.stringify({
      format: { format_name: 'matroska,webm', duration: '1547.20' },
      streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'subtitle', codec_name: 'subrip' },
      ],
    });
    const result = await probe('/fake/path.mkv', { spawn: makeFakeSpawn(fakeOut) });
    expect(result.container).toBe('matroska,webm');
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(result.durationSeconds).toBeCloseTo(1547.2);
  });

  it('throws ProbeError on non-zero exit', async () => {
    await expect(
      probe('/fake/path.mkv', {
        spawn: makeFakeSpawn('', 'No such file', 1),
      }),
    ).rejects.toThrow(/ffprobe exited 1/);
  });

  it('throws ProbeError on invalid JSON', async () => {
    await expect(
      probe('/fake/path.mkv', { spawn: makeFakeSpawn('not json') }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it('returns empty codec strings when streams are missing', async () => {
    const fakeOut = JSON.stringify({
      format: { format_name: 'mp4', duration: '60' },
      streams: [],
    });
    const result = await probe('/fake/path.mp4', { spawn: makeFakeSpawn(fakeOut) });
    expect(result.videoCodec).toBe('');
    expect(result.audioCodec).toBe('');
    expect(result.container).toBe('mp4');
    expect(result.audioStreams).toEqual([]);
    expect(result.subStreams).toEqual([]);
    expect(result.chapters).toEqual([]);
  });

  it('parses every audio + subtitle stream with local indices and tags', async () => {
    const fakeOut = JSON.stringify({
      format: { format_name: 'matroska,webm', duration: '7200' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'eac3',
          channels: 2,
          tags: { language: 'jpn', title: 'Japanese 2.0 EAC3' },
          disposition: { default: 1, forced: 0 },
        },
        {
          index: 2,
          codec_type: 'audio',
          codec_name: 'truehd',
          channels: 6,
          tags: { language: 'eng', title: 'English 5.1 TrueHD' },
          disposition: { default: 0, forced: 0 },
        },
        {
          index: 3,
          codec_type: 'subtitle',
          codec_name: 'subrip',
          tags: { language: 'eng', title: 'English' },
          disposition: { default: 1, forced: 0 },
        },
        {
          index: 4,
          codec_type: 'subtitle',
          codec_name: 'pgs',
          tags: { language: 'eng' },
          disposition: { default: 0, forced: 0 },
        },
      ],
    });
    const result = await probe('/fake/path.mkv', { spawn: makeFakeSpawn(fakeOut) });
    expect(result.audioStreams).toHaveLength(2);
    expect(result.audioStreams?.[0]).toMatchObject({
      index: 1,
      audioIndex: 0,
      codec: 'eac3',
      language: 'jpn',
      title: 'Japanese 2.0 EAC3',
      channels: 2,
      default: true,
      forced: false,
    });
    expect(result.audioStreams?.[1]).toMatchObject({
      audioIndex: 1,
      codec: 'truehd',
      language: 'eng',
      channels: 6,
      default: false,
    });
    expect(result.subStreams).toHaveLength(2);
    expect(result.subStreams?.[0]).toMatchObject({
      subIndex: 0,
      codec: 'subrip',
      language: 'eng',
      textBased: true,
      default: true,
    });
    expect(result.subStreams?.[1]).toMatchObject({
      subIndex: 1,
      codec: 'pgs',
      textBased: false,
    });
    // Back-compat: first audio still surfaces in `audioCodec`.
    expect(result.audioCodec).toBe('eac3');
  });

  it('parses chapters with time_base scaling and titles', async () => {
    const fakeOut = JSON.stringify({
      format: { format_name: 'matroska,webm', duration: '300' },
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      chapters: [
        { id: 0, time_base: '1/1000', start: 0, end: 60000, tags: { title: 'Opening' } },
        { id: 1, time_base: '1/1000', start: 60000, end: 180000, tags: { title: 'Act 1' } },
        { id: 2, time_base: '1/1000', start: 180000, end: 300000 },
      ],
    });
    const result = await probe('/fake/path.mkv', { spawn: makeFakeSpawn(fakeOut) });
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters?.[0]).toEqual({
      index: 0,
      startSeconds: 0,
      endSeconds: 60,
      title: 'Opening',
    });
    expect(result.chapters?.[1]).toMatchObject({ startSeconds: 60, endSeconds: 180, title: 'Act 1' });
    expect(result.chapters?.[2]?.title).toBeNull();
  });
});
