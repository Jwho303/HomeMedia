import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildHlsArgs } from '../../src/streaming/hls-args.js';
import type { PipelineInput } from '../../src/streaming/profiles.js';

const ABS = '/media/show/episode.mkv';
const CACHE = path.join('/var/tmp', 'homemedia', 'hls', 'sess-1');

function input(overrides: Partial<PipelineInput> & { durationSeconds?: number }): PipelineInput {
  return {
    absPath: ABS,
    container: '',
    videoCodec: '',
    audioCodec: '',
    ...overrides,
  };
}

describe('buildHlsArgs()', () => {
  it('h264/aac + matroska → remux-copy HLS pipeline (no NVENC; mpegts segments)', () => {
    // 0.1.7 — clean h264/aac sources go straight from `-c:v copy -c:a copy`
    // into mpegts segments. NVENC re-encoding these produces segments Chrome's
    // MSE intermittently rejects with DEMUXER_ERROR_COULD_NOT_PARSE.
    const { profile, args } = buildHlsArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 1200 }),
      CACHE,
    );
    expect(profile.name).toBe('remux-modern');
    // No NVENC / hwaccel for the copy path.
    expect(args).not.toContain('h264_nvenc');
    expect(args).not.toContain('-hwaccel');
    // -c:v copy + -c:a copy
    const cvIdx = args.indexOf('-c:v');
    expect(cvIdx).toBeGreaterThan(-1);
    expect(args[cvIdx + 1]).toBe('copy');
    const caIdx = args.indexOf('-c:a');
    expect(caIdx).toBeGreaterThan(-1);
    expect(args[caIdx + 1]).toBe('copy');
    // Still mpegts segments via the hls muxer.
    expect(args).toContain('-f');
    expect(args).toContain('hls');
    const modeIdx = args.indexOf('-hls_playlist_type');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(args[modeIdx + 1]).toBe('event');
    const timeIdx = args.indexOf('-hls_time');
    expect(args[timeIdx + 1]).toBe('6');
    expect(args).toContain('independent_segments+temp_file');
    const segIdx = args.indexOf('-hls_segment_filename');
    expect(args[segIdx + 1]).toBe(path.join(CACHE, 'seg-%05d.ts'));
    expect(args[args.length - 1]).toBe(path.join(CACHE, 'index.m3u8'));
  });

  it('h264/mp3 + matroska → remux-copy (mp3 is also browser-friendly in mpegts)', () => {
    const { args } = buildHlsArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'mp3', durationSeconds: 1200 }),
      CACHE,
    );
    const cvIdx = args.indexOf('-c:v');
    expect(args[cvIdx + 1]).toBe('copy');
    const caIdx = args.indexOf('-c:a');
    expect(args[caIdx + 1]).toBe('copy');
  });

  it('h264 + opus (not mpegts-friendly) → falls through to NVENC modern pipeline', () => {
    // Opus survives mpegts only via marginal browser support; transcoding
    // back to AAC is the safe path.
    const { args } = buildHlsArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'opus', durationSeconds: 1200 }),
      CACHE,
    );
    expect(args).toContain('h264_nvenc');
  });

  it('h264/aac with burnSubStreamIndex → NVENC modern (burn requires re-encode)', () => {
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        burnSubStreamIndex: 0,
        durationSeconds: 1200,
      }),
      CACHE,
    );
    expect(args).toContain('h264_nvenc');
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toContain('subtitles=');
  });

  it('hevc input → modern HLS with scale_cuda=format=yuv420p (10-bit safety)', () => {
    const { args } = buildHlsArgs(
      input({ container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'eac3', durationSeconds: 3000 }),
      CACHE,
    );
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe('scale_cuda=format=yuv420p');
  });

  it('xvid AVI → legacy-avi HLS pipeline (sw decode, mpeg4_unpack_bframes)', () => {
    const { profile, args } = buildHlsArgs(
      input({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3', durationSeconds: 1500 }),
      CACHE,
    );
    expect(profile.name).toBe('nvenc-legacy-avi');
    expect(args).toContain('mpeg4_unpack_bframes');
    expect(args).toContain('+genpts');
    // No -hwaccel cuda on the input side (sw decode).
    const inputIdx = args.indexOf('-i');
    expect(args.slice(0, inputIdx)).not.toContain('-hwaccel');
    expect(args).toContain('h264_nvenc');
    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
  });

  it('mpeg2video → legacy-ts HLS pipeline', () => {
    const { profile, args } = buildHlsArgs(
      input({ container: 'mpeg', videoCodec: 'mpeg2video', audioCodec: 'mp2', durationSeconds: 2000 }),
      CACHE,
    );
    expect(profile.name).toBe('nvenc-legacy-ts');
    expect(args).toContain('+genpts');
    expect(args).not.toContain('mpeg4_unpack_bframes');
  });

  it('remux-copy path uses naive input-side seek (no lead/lag, -c:v copy cannot drop frames)', () => {
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        startSeconds: 620,
        durationSeconds: 3000,
      }),
      CACHE,
    );
    // h264/aac → remux-copy. No NVENC, no output-side lag.
    const cvIdx = args.indexOf('-c:v');
    expect(args[cvIdx + 1]).toBe('copy');
    const ssIdx = args.indexOf('-ss');
    const inputIdx = args.indexOf('-i');
    expect(ssIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeLessThan(inputIdx);
    expect(args[ssIdx + 1]).toBe('620');
    // Only ONE -ss (the input-side one).
    const allSs = args.filter((a) => a === '-ss');
    expect(allSs.length).toBe(1);
  });

  it('all paths zero the muxer PTS preload (-muxdelay 0 -muxpreload 0)', () => {
    // 0.1.7 — without these flags, input-side `-ss N` leaves the first
    // encoded frame's PTS at its source-relative value (~1.42s for a
    // typical HEVC GOP). seg-00000 is then unparseable by Chrome's MSE
    // because the first 1.42s of segment-time has no decodable picture.
    // Verified empirically with ffprobe.
    for (const codec of ['hevc', 'h264', 'mpeg4', 'mpeg2video']) {
      const cont = codec === 'mpeg4' ? 'avi' : codec === 'mpeg2video' ? 'mpeg' : 'matroska,webm';
      const audio = codec === 'mpeg4' ? 'mp3' : codec === 'mpeg2video' ? 'mp2' : 'aac';
      const burnSubStreamIndex = codec === 'h264' ? 0 : undefined; // force NVENC for h264 too
      const opts: Partial<PipelineInput> & { durationSeconds?: number } = {
        container: cont,
        videoCodec: codec,
        audioCodec: audio,
        startSeconds: 113,
        durationSeconds: 3000,
      };
      if (burnSubStreamIndex !== undefined) opts.burnSubStreamIndex = burnSubStreamIndex;
      const { args } = buildHlsArgs(input(opts), CACHE);
      expect(args).toContain('-muxdelay');
      expect(args).toContain('-muxpreload');
      const mdIdx = args.indexOf('-muxdelay');
      const mpIdx = args.indexOf('-muxpreload');
      expect(args[mdIdx + 1]).toBe('0');
      expect(args[mpIdx + 1]).toBe('0');
    }
  });

  it('NVENC modern path uses input-side seek only (output-side -ss leaves NVENC on a non-keyframe)', () => {
    // 0.1.7 — earlier we tried lead/lag (input -ss target-5, output -ss 5)
    // for sub-frame accuracy. With NVENC that lands on a P-frame at the
    // encoder's first output, and Chrome's MSE rejects seg-00000 with
    // DEMUXER_ERROR_COULD_NOT_PARSE. Input-side seek snaps to the
    // nearest preceding keyframe, which guarantees seg-00000 starts on a
    // real picture.
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        startSeconds: 113,
        durationSeconds: 3662,
      }),
      CACHE,
    );
    const inputIdx = args.indexOf('-i');
    const inputSide = args.slice(0, inputIdx);
    const outputSide = args.slice(inputIdx + 2); // skip '-i' + path
    // Input-side: -ss target.
    const inSsIdx = inputSide.indexOf('-ss');
    expect(inSsIdx).toBeGreaterThan(-1);
    expect(inputSide[inSsIdx + 1]).toBe('113');
    // Output-side: no -ss.
    expect(outputSide).not.toContain('-ss');
  });

  it('audioStreamIndex maps to 0:a:N', () => {
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        audioStreamIndex: 2,
        durationSeconds: 1200,
      }),
      CACHE,
    );
    const mapIndices: number[] = [];
    args.forEach((a, i) => { if (a === '-map') mapIndices.push(i); });
    const mapValues = mapIndices.map((i) => args[i + 1]);
    expect(mapValues).toContain('0:v:0');
    expect(mapValues).toContain('0:a:2');
  });

  it('burnSubStreamIndex on modern source switches vf to hwdownload+subtitles', () => {
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        burnSubStreamIndex: 0,
        durationSeconds: 1200,
      }),
      CACHE,
    );
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toContain('hwdownload');
    expect(args[vfIdx + 1]).toContain('subtitles=');
    expect(args[vfIdx + 1]).toContain(':si=0');
  });

  it('event playlist mode regardless of known duration', () => {
    const { args } = buildHlsArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' }),
      CACHE,
    );
    const modeIdx = args.indexOf('-hls_playlist_type');
    expect(args[modeIdx + 1]).toBe('event');
  });
});
