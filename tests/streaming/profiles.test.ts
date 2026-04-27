import { describe, it, expect } from 'vitest';
import {
  pickPipelineProfile,
  PROFILE_REMUX_MODERN,
  PROFILE_NVENC_MODERN,
  PROFILE_NVENC_LEGACY_AVI,
  PROFILE_NVENC_LEGACY_TS,
  type PipelineInput,
} from '../../src/streaming/profiles.js';

const ABS = '/media/example.mkv';

function input(overrides: Partial<PipelineInput>): PipelineInput {
  return {
    absPath: ABS,
    container: '',
    videoCodec: '',
    audioCodec: '',
    ...overrides,
  };
}

describe('pickPipelineProfile()', () => {
  it('h264 + matroska → remux-modern', () => {
    const profile = pickPipelineProfile(input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' }));
    expect(profile.name).toBe('remux-modern');
  });

  it('hevc + matroska → nvenc-modern', () => {
    const profile = pickPipelineProfile(input({ container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac' }));
    expect(profile.name).toBe('nvenc-modern');
  });

  it('mpeg4 + avi → nvenc-legacy-avi', () => {
    const profile = pickPipelineProfile(input({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }));
    expect(profile.name).toBe('nvenc-legacy-avi');
  });

  it('mpeg2video → nvenc-legacy-ts', () => {
    const profile = pickPipelineProfile(input({ container: 'mpeg', videoCodec: 'mpeg2video', audioCodec: 'mp2' }));
    expect(profile.name).toBe('nvenc-legacy-ts');
  });

  it('vc1 → nvenc-legacy-ts', () => {
    const profile = pickPipelineProfile(input({ container: 'asf', videoCodec: 'vc1', audioCodec: 'wmav2' }));
    expect(profile.name).toBe('nvenc-legacy-ts');
  });
});

describe('PROFILE_REMUX_MODERN.buildArgs()', () => {
  it('uses -c:v copy and no input-side workaround flags', () => {
    const args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' }),
    );
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    // No legacy / Xvid flags should appear here.
    expect(args).not.toContain('-re');
    expect(args).not.toContain('+genpts');
    expect(args).not.toContain('-bsf:v');
    expect(args).not.toContain('mpeg4_unpack_bframes');
    expect(args).not.toContain('-fps_mode');
    // No NVENC flags either.
    expect(args).not.toContain('h264_nvenc');
    expect(args).not.toContain('cuda');
  });

  it('copies AAC audio, transcodes other audio to AAC', () => {
    const aacArgs = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' }),
    );
    const aacIdx = aacArgs.indexOf('-c:a');
    expect(aacIdx).toBeGreaterThan(-1);
    expect(aacArgs[aacIdx + 1]).toBe('copy');

    const ac3Args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'ac3' }),
    );
    expect(ac3Args).toContain('aac');
    expect(ac3Args).toContain('-af');
  });

  it('audioStrategy() reflects audio codec', () => {
    expect(PROFILE_REMUX_MODERN.audioStrategy(input({ audioCodec: 'aac' }))).toBe('copy');
    expect(PROFILE_REMUX_MODERN.audioStrategy(input({ audioCodec: 'ac3' }))).toBe('transcode');
  });
});

describe('PROFILE_NVENC_MODERN.buildArgs()', () => {
  it('invokes NVENC with on-GPU yuv420p conversion + g=60 and no Xvid workarounds', () => {
    const args = PROFILE_NVENC_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac' }),
    );
    expect(args).toContain('-hwaccel');
    expect(args).toContain('cuda');
    expect(args).toContain('h264_nvenc');
    // Pixel-format conversion happens on the GPU via scale_cuda — pinning
    // `-pix_fmt yuv420p` at the encoder while `-hwaccel_output_format cuda`
    // is set makes ffmpeg insert an auto-scaler that can't bridge cuda → CPU
    // formats and aborts before any frame reaches NVENC.
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(args[vfIdx + 1]).toBe('scale_cuda=format=yuv420p');
    expect(args).not.toContain('-pix_fmt');
    expect(args).toContain('-g');
    expect(args).toContain('60');
    // CRITICAL: none of the legacy workarounds.
    expect(args).not.toContain('-re');
    expect(args).not.toContain('+genpts');
    expect(args).not.toContain('-bsf:v');
    expect(args).not.toContain('-fps_mode');
  });
});

describe('PROFILE_NVENC_LEGACY_AVI.buildArgs()', () => {
  it('includes ALL Xvid workaround flags', () => {
    const args = PROFILE_NVENC_LEGACY_AVI.buildArgs(
      input({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }),
    );
    expect(args).toContain('-re');
    expect(args).toContain('-fflags');
    expect(args).toContain('+genpts');
    expect(args).toContain('-bsf:v');
    expect(args).toContain('mpeg4_unpack_bframes');
    expect(args).toContain('-fps_mode');
    expect(args).toContain('cfr');
    // And the universal NVENC + MSE compatibility flags.
    expect(args).toContain('h264_nvenc');
    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
    expect(args).toContain('-g');
    expect(args).toContain('60');
  });

  it('always transcodes audio to AAC with the resync filter', () => {
    const args = PROFILE_NVENC_LEGACY_AVI.buildArgs(
      input({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }),
    );
    const aIdx = args.indexOf('-c:a');
    expect(aIdx).toBeGreaterThan(-1);
    expect(args[aIdx + 1]).toBe('aac');
    const afIdx = args.indexOf('-af');
    expect(afIdx).toBeGreaterThan(-1);
    expect(args[afIdx + 1]).toMatch(/aresample=async=1/);
  });

  it('audioStrategy() always reports transcode', () => {
    expect(PROFILE_NVENC_LEGACY_AVI.audioStrategy(input({ audioCodec: 'mp3' }))).toBe('transcode');
    expect(PROFILE_NVENC_LEGACY_AVI.audioStrategy(input({ audioCodec: 'aac' }))).toBe('transcode');
  });
});

describe('PROFILE_NVENC_LEGACY_TS.buildArgs()', () => {
  it('includes -re and +genpts but not the Xvid bsf', () => {
    const args = PROFILE_NVENC_LEGACY_TS.buildArgs(
      input({ container: 'mpegts', videoCodec: 'mpeg2video', audioCodec: 'mp2' }),
    );
    expect(args).toContain('-re');
    expect(args).toContain('+genpts');
    expect(args).toContain('-fps_mode');
    expect(args).not.toContain('mpeg4_unpack_bframes');
  });
});

describe('audio stream -map (0.1.4.3)', () => {
  it('default audio (audioStreamIndex undefined) emits an optional map for stream 0', () => {
    const args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' }),
    );
    const mapIndices = args.map((a, i) => (a === '-map' ? i : -1)).filter((i) => i >= 0);
    expect(mapIndices.length).toBeGreaterThanOrEqual(2);
    // Always maps the first video stream and the (optional) default audio.
    expect(args[mapIndices[0]! + 1]).toBe('0:v:0');
    expect(args[mapIndices[1]! + 1]).toBe('0:a:0?');
  });

  it('explicit audio index emits -map 0:a:N for every profile', () => {
    for (const profile of [
      PROFILE_REMUX_MODERN,
      PROFILE_NVENC_MODERN,
      PROFILE_NVENC_LEGACY_AVI,
      PROFILE_NVENC_LEGACY_TS,
    ]) {
      const args = profile.buildArgs(
        input({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3', audioStreamIndex: 2 }),
      );
      const mapIndices = args.map((a, i) => (a === '-map' ? i : -1)).filter((i) => i >= 0);
      expect(mapIndices.length).toBe(2);
      expect(args[mapIndices[0]! + 1]).toBe('0:v:0');
      expect(args[mapIndices[1]! + 1]).toBe('0:a:2');
    }
  });
});

describe('subtitle burn-in (0.1.4.3)', () => {
  it('nvenc-modern with burnSubStreamIndex adds -vf with subtitles=...:si=N', () => {
    const args = PROFILE_NVENC_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac', burnSubStreamIndex: 1 }),
    );
    const vfIdx = args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    // Filter chain pulls GPU frames down to CPU (`hwdownload,format=nv12`)
    // before the subtitles= filter, which only operates in CPU memory, then
    // re-converts to yuv420p for NVENC.
    expect(args[vfIdx + 1]).toMatch(/subtitles=.*:si=1/);
  });

  it('remux-modern stays without -vf because remux can\'t burn', () => {
    const args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', burnSubStreamIndex: 0 }),
    );
    expect(args).not.toContain('-vf');
  });
});

describe('seek arg splicing', () => {
  it('start=0 → no -ss anywhere', () => {
    const args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', startSeconds: 0 }),
    );
    expect(args).not.toContain('-ss');
  });

  it('start within 5s → output-side -ss only', () => {
    const args = PROFILE_REMUX_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac', startSeconds: 3 }),
    );
    const inputIdx = args.indexOf('-i');
    const ssIndices = args.map((a, i) => (a === '-ss' ? i : -1)).filter((i) => i >= 0);
    expect(ssIndices).toHaveLength(1);
    expect(ssIndices[0]).toBeGreaterThan(inputIdx);
    expect(args[ssIndices[0]! + 1]).toBe('3');
  });

  it('start past lead → split seek (input + output)', () => {
    const args = PROFILE_NVENC_MODERN.buildArgs(
      input({ container: 'matroska,webm', videoCodec: 'hevc', audioCodec: 'aac', startSeconds: 600 }),
    );
    const inputIdx = args.indexOf('-i');
    const ssIndices = args.map((a, i) => (a === '-ss' ? i : -1)).filter((i) => i >= 0);
    expect(ssIndices).toHaveLength(2);
    expect(ssIndices[0]).toBeLessThan(inputIdx);
    expect(args[ssIndices[0]! + 1]).toBe('595');
    expect(ssIndices[1]).toBeGreaterThan(inputIdx);
    expect(args[ssIndices[1]! + 1]).toBe('5');
  });
});
