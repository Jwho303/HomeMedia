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

  it('remux-copy path inserts h264_mp4toannexb BSF (0.1.9.1 — MP4→mpegts NALU framing)', () => {
    // Without this, h264 in MP4's AVCC framing (length-prefix) gets
    // copied as-is into mpegts (which needs Annex-B start codes); the
    // muxer logs "h264 bitstream error, startcode missing" for every
    // NALU and Chrome MSE fails with CHUNK_DEMUXER_ERROR_APPEND_FAILED.
    const { args } = buildHlsArgs(
      input({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 5931,
      }),
      CACHE,
    );
    const bsfIdx = args.indexOf('-bsf:v');
    expect(bsfIdx).toBeGreaterThan(-1);
    expect(args[bsfIdx + 1]).toBe('h264_mp4toannexb');
  });

  it('remux-copy path passes -ignore_editlist 1 BEFORE -i (0.1.9.1 — kill edts PTS shift)', () => {
    // YTS-style MP4s ship with an `edts` edit list whose first entry can
    // be a 90s preroll. The MP4 demuxer applies edit lists by default and
    // emits frames with PTS shifted by the offset → ffmpeg's HLS muxer
    // numbers the first segment seg-NNNNN instead of seg-00000, and
    // hls.js fetches a playlist whose timeline doesn't match the segment
    // filenames → DEMUXER_ERROR_COULD_NOT_PARSE on any out-of-buffer seek.
    const { args } = buildHlsArgs(
      input({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 5931,
      }),
      CACHE,
    );
    const ignoreIdx = args.indexOf('-ignore_editlist');
    const inputIdx = args.indexOf('-i');
    expect(ignoreIdx).toBeGreaterThan(-1);
    expect(ignoreIdx).toBeLessThan(inputIdx);
    expect(args[ignoreIdx + 1]).toBe('1');
    expect(args).not.toContain('-copyts');
  });

  it('remux-copy on Matroska does NOT pass MP4-only flags (0.1.9.2 — ffmpeg crashes if you do)', () => {
    // -ignore_editlist and -bsf:v h264_mp4toannexb are MP4 demuxer /
    // AVCC-framing specific. Passing them to a Matroska/WebM input
    // makes ffmpeg exit at startup with "Option ignore_editlist not
    // found" or worse confuses the muxer with an unnecessary BSF.
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 1320,
      }),
      CACHE,
    );
    expect(args).not.toContain('-ignore_editlist');
    expect(args).not.toContain('-bsf:v');
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

  it('text-sub burn-in on modern source uses hwdownload + subtitles= filter', () => {
    const { args } = buildHlsArgs(
      input({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        burnSubStreamIndex: 0,
        burnSubTextBased: true,
        durationSeconds: 1200,
      }),
      CACHE,
    );
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toContain('hwdownload');
    expect(args[vfIdx + 1]).toContain('subtitles=');
    expect(args[vfIdx + 1]).toContain(':si=0');
    // Default text-sub path keeps -hwaccel cuda for video decode.
    expect(args).toContain('-hwaccel');
  });

  // Image-sub burn-in (PGS / VobSub / DVB) requires a different filter
  // chain because ffmpeg's `subtitles=` filter only handles text codecs.
  // The route layer threads `burnSubTextBased=false` through to hls-args
  // which switches to filter_complex + overlay. Without this branch the
  // ffmpeg process spawns and immediately fails inside the filter graph
  // with "Only text based subtitles are currently supported", the
  // playlist never appears, and we wait 30s on `waitForPlaylist` before
  // surfacing a 415 to the client.
  describe('image-sub burn-in (overlay filter chain)', () => {
    it('PGS burn-in on a modern HEVC source uses filter_complex + overlay, no -hwaccel cuda', () => {
      const { args } = buildHlsArgs(
        input({
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'eac3',
          burnSubStreamIndex: 0,
          burnSubTextBased: false,
          durationSeconds: 7095,
        }),
        CACHE,
      );
      // No -hwaccel: NVDEC can't decode PGS, and mixing CUDA video with a
      // CPU sub stream confuses the auto-scaler.
      expect(args).not.toContain('-hwaccel');
      // -filter_complex appears with the overlay graph.
      const fcIdx = args.indexOf('-filter_complex');
      expect(fcIdx).toBeGreaterThan(-1);
      expect(args[fcIdx + 1]).toBe('[0:v][0:s:0]overlay[outv]');
      // -map [outv] for the labeled output.
      const maps = args.reduce<string[]>((acc, a, i) => {
        if (a === '-map') acc.push(args[i + 1] ?? '');
        return acc;
      }, []);
      expect(maps).toContain('[outv]');
      // No -vf — overlay is in filter_complex.
      expect(args).not.toContain('-vf');
      // NVENC encoder still runs.
      expect(args).toContain('h264_nvenc');
      // Audio still maps to default (0:a:0?) since audioStreamIndex omitted.
      expect(maps).toContain('0:a:0?');
    });

    it('PGS burn-in respects audioStreamIndex when set', () => {
      const { args } = buildHlsArgs(
        input({
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'eac3',
          audioStreamIndex: 1,
          burnSubStreamIndex: 0,
          burnSubTextBased: false,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const maps = args.reduce<string[]>((acc, a, i) => {
        if (a === '-map') acc.push(args[i + 1] ?? '');
        return acc;
      }, []);
      expect(maps).toContain('[outv]');
      expect(maps).toContain('0:a:1');
    });

    it('image-sub burn-in on a legacy AVI source preserves the Xvid bitstream filter', () => {
      const { args } = buildHlsArgs(
        input({
          container: 'avi',
          videoCodec: 'mpeg4',
          audioCodec: 'mp3',
          burnSubStreamIndex: 0,
          burnSubTextBased: false,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const fcIdx = args.indexOf('-filter_complex');
      expect(fcIdx).toBeGreaterThan(-1);
      expect(args[fcIdx + 1]).toBe('[0:v][0:s:0]overlay[outv]');
      // Xvid workaround flag is still present.
      expect(args).toContain('-bsf:v');
      const bsfIdx = args.indexOf('-bsf:v');
      expect(args[bsfIdx + 1]).toBe('mpeg4_unpack_bframes');
    });

    it('image-sub burn-in on legacy TS keeps +genpts and uses overlay', () => {
      const { args } = buildHlsArgs(
        input({
          container: 'mpegts',
          videoCodec: 'mpeg2video',
          audioCodec: 'ac3',
          burnSubStreamIndex: 1,
          burnSubTextBased: false,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const fcIdx = args.indexOf('-filter_complex');
      expect(args[fcIdx + 1]).toBe('[0:v][0:s:1]overlay[outv]');
      // No mpeg4 bitstream filter on the legacy-ts path.
      expect(args).not.toContain('mpeg4_unpack_bframes');
      // +genpts should be present.
      const ffIdx = args.indexOf('-fflags');
      expect(args[ffIdx + 1]).toBe('+genpts');
    });

    it('omitting burnSubTextBased defaults to the text-sub filter (back-compat)', () => {
      // Before the route plumbs the flag through, callers may pass only
      // burnSubStreamIndex. The pipeline must default to the text-sub
      // path so we don't regress text-sub burn-in.
      const { args } = buildHlsArgs(
        input({
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'aac',
          burnSubStreamIndex: 0,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const vfIdx = args.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(-1);
      expect(args[vfIdx + 1]).toContain('subtitles=');
      expect(args).not.toContain('-filter_complex');
    });
  });

  // Burn-in regression coverage for path-escape edge cases that broke playback
  // on Windows real-world libraries. The subtitles= filter wraps the path in
  // single quotes; literal apostrophes in the path must be re-escaped, and
  // backslashes must be normalized so the parser doesn't read them as escapes.
  describe('burn-in subtitle path escaping', () => {
    it("Windows backslashes in the absPath are normalized to forward slashes", () => {
      const { args } = buildHlsArgs(
        input({
          absPath: 'D:\\Torrent\\Completed\\show\\ep.mkv',
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'aac',
          burnSubStreamIndex: 1,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const vfIdx = args.indexOf('-vf');
      const vf = args[vfIdx + 1] ?? '';
      // The colon after D: stays inside the single-quoted region — the parser
      // doesn't see it as a filter-arg separator. Importantly: no backslashes
      // in the inner content.
      expect(vf).toContain("subtitles='D:/Torrent/Completed/show/ep.mkv':si=1");
      expect(vf).not.toMatch(/[a-zA-Z]:\\\\/);
    });

    it("apostrophe in the path is re-escaped with the close-escape-reopen idiom", () => {
      const { args } = buildHlsArgs(
        input({
          absPath: "/media/Show's Edit/ep.mkv",
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'aac',
          burnSubStreamIndex: 0,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const vfIdx = args.indexOf('-vf');
      const vf = args[vfIdx + 1] ?? '';
      // The literal apostrophe becomes '\'' inside the surrounding quotes —
      // close, escaped apostrophe, reopen. Verify the sequence is intact.
      expect(vf).toContain("'/media/Show'\\''s Edit/ep.mkv'");
      expect(vf).toContain(':si=0');
    });

    it("filtergraph-special characters (`,`, `[`, `]`) inside the quoted path don't terminate args", () => {
      const { args } = buildHlsArgs(
        input({
          absPath: '/media/show [2024]/Foo, Bar.mkv',
          container: 'matroska,webm',
          videoCodec: 'hevc',
          audioCodec: 'aac',
          burnSubStreamIndex: 2,
          durationSeconds: 600,
        }),
        CACHE,
      );
      const vfIdx = args.indexOf('-vf');
      const vf = args[vfIdx + 1] ?? '';
      // Path stays intact within the single-quoted region. The downstream
      // `:si=2` is the only filter-arg-level `:` outside the quotes.
      expect(vf).toContain("subtitles='/media/show [2024]/Foo, Bar.mkv':si=2");
    });
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
