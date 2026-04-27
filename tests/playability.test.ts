import { describe, it, expect } from 'vitest';
import { decide } from '../src/playability.js';

describe('decide()', () => {
  it('MP4 + H264 + AAC → direct', () => {
    expect(
      decide({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 100,
      }),
    ).toBe('direct');
  });

  it('MKV + H264 + AAC → remux', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MKV + HEVC + EAC3 → remux (both video and audio are remuxable; audio gets transcoded inline)', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        audioCodec: 'eac3',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MKV + H264 + AC3 → remux (AC3 audio gets transcoded to AAC inline)', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'ac3',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MKV + H264 + DTS → remux', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'dts',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MKV + H264 + UNKNOWN_CODEC → external (audio not in any allowlist)', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'h264',
        audioCodec: 'wmav2',
        durationSeconds: 100,
      }),
    ).toBe('external');
  });

  it('MP4 + VP9 + Opus → direct', () => {
    expect(
      decide({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        durationSeconds: 100,
      }),
    ).toBe('direct');
  });

  it('AVI + H264 + AAC → remux (wrong container)', () => {
    expect(
      decide({
        container: 'avi',
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MP4 + HEVC + AAC → remux (HEVC remuxable; Chrome/Mac plays natively, Windows falls through to NVENC retry)', () => {
    expect(
      decide({
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('MKV + HEVC + AAC → remux', () => {
    expect(
      decide({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        audioCodec: 'aac',
        durationSeconds: 100,
      }),
    ).toBe('remux');
  });

  it('AVI + Xvid (mpeg4) + MP3 → remux (transcode-required video; NVENC handles via fallback)', () => {
    expect(
      decide({
        container: 'avi',
        videoCodec: 'mpeg4',
        audioCodec: 'mp3',
        durationSeconds: 1320,
      }),
    ).toBe('remux');
  });

  it('MPEG-TS + MPEG-2 + AC3 → remux (DVD-rip class)', () => {
    expect(
      decide({
        container: 'mpegts',
        videoCodec: 'mpeg2video',
        audioCodec: 'ac3',
        durationSeconds: 6300,
      }),
    ).toBe('remux');
  });

  it('WMV + VC-1 + WMA → external (audio is the blocker)', () => {
    expect(
      decide({
        container: 'asf',
        videoCodec: 'vc1',
        audioCodec: 'wmav2',
        durationSeconds: 100,
      }),
    ).toBe('external');
  });
});
