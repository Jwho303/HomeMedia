import type { ProbeResult } from './db.js';

export type Decision = 'direct' | 'remux' | 'external';

// ffprobe `format_name` is a comma-joined list of demuxers that match the input.
// Browsers play MP4 and WebM containers natively; the Matroska demuxer is reported
// as `matroska,webm`, which we explicitly exclude — the file would still need a
// remux into fragmented MP4 even though `webm` appears in the joint name.
const BROWSER_CONTAINERS = new Set(['mp4', 'm4a', 'mov', '3gp', '3g2', 'mj2', 'webm']);
// Codecs the bare `<video>` element decodes universally without remux.
const BROWSER_VIDEO_DIRECT = new Set(['h264', 'vp8', 'vp9', 'av1']);
// Codecs *some* browsers can decode when delivered in fragmented MP4 — Chrome
// on Mac (VideoToolbox), Safari, and Edge-with-extension all decode HEVC, but
// Chrome on Windows can't. We attempt remux first; the frontend falls back to
// `?accel=nvenc` on <video> error.
const BROWSER_VIDEO_OPPORTUNISTIC = new Set(['hevc', 'h265']);
// Codecs that no browser decodes natively but ffmpeg can transcode to H.264
// via the NVENC pipeline. Older P2P/DivX-era video lives here. We skip remux
// entirely and signal `preferAccel: 'nvenc'` in the 415 body so the frontend
// starts in NVENC mode and doesn't waste 8s on a guaranteed-fail remux.
const TRANSCODE_REQUIRED_VIDEO = new Set([
  'mpeg4',     // MPEG-4 Part 2 (Xvid / DivX)
  'mpeg2video', // DVD-rips
  'vc1',        // Windows Media VC-1, Blu-ray
  'wmv3', 'wmv2', 'wmv1', // older Windows Media
  'theora',     // Ogg Theora
  'msmpeg4v3', 'msmpeg4v2', // pre-Xvid Microsoft variants
  'rv40', 'rv30', // RealVideo
]);
const BROWSER_VIDEO_REMUX = new Set([
  ...BROWSER_VIDEO_DIRECT,
  ...BROWSER_VIDEO_OPPORTUNISTIC,
  ...TRANSCODE_REQUIRED_VIDEO,
]);

/** True iff the source video codec needs server-side transcode regardless of
 *  browser — used to skip the remux attempt and go straight to `?accel=nvenc`. */
export function isVideoTranscodeRequired(codec: string): boolean {
  return TRANSCODE_REQUIRED_VIDEO.has(codec);
}
const BROWSER_AUDIO_DIRECT = new Set(['aac', 'mp3', 'opus', 'vorbis']);
// Audio codecs ffmpeg can cheaply re-encode to AAC at remux time. Audio
// transcoding is ~1-2% of one CPU core in real time so we don't gate it on
// hardware availability the way HEVC video transcode is gated on NVENC.
export const TRANSCODABLE_AUDIO = new Set(['ac3', 'eac3', 'dts', 'truehd', 'flac', 'pcm_s16le', 'pcm_s24le']);

/** True iff the audio codec is something the remux pipeline can handle —
 *  either copying directly into the output MP4 or transcoding to AAC inline. */
export function isAudioRemuxable(codec: string): boolean {
  return BROWSER_AUDIO_DIRECT.has(codec) || TRANSCODABLE_AUDIO.has(codec);
}

function isBrowserContainer(format: string): boolean {
  if (!format) return false;
  const parts = format.split(',').map((s) => s.trim());
  // Matroska's joint name contains `webm`; treat it as non-browser by exact membership check.
  if (parts.includes('matroska')) return false;
  return parts.some((p) => BROWSER_CONTAINERS.has(p));
}

export function decide(p: ProbeResult): Decision {
  const browserContainer = isBrowserContainer(p.container);
  const directVideo = BROWSER_VIDEO_DIRECT.has(p.videoCodec);
  const remuxableVideo = BROWSER_VIDEO_REMUX.has(p.videoCodec);
  const directAudio = BROWSER_AUDIO_DIRECT.has(p.audioCodec);
  const remuxableAudio = isAudioRemuxable(p.audioCodec);

  if (browserContainer && directVideo && directAudio) return 'direct';
  if (remuxableVideo && remuxableAudio) return 'remux';
  return 'external';
}
