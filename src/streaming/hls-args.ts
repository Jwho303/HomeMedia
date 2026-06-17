/**
 * HLS output flags + per-profile arg builders (0.1.6).
 *
 * The 0.1.4.2 `PipelineProfile` machinery already picks the right *decoder*
 * side of an ffmpeg invocation for a given source class (modern HEVC, Xvid
 * AVI, MPEG-2 TS, etc.). HLS reuses that pick and swaps the output side from
 * fragmented MP4 → an HLS muxer that writes mpegts segments + an `index.m3u8`
 * playlist into a session-scoped cache directory.
 *
 * `hlsArgs(input, cacheDir)` returns the full ffmpeg arg list — the caller
 * spawns it and lets it write segments to disk while the route layer serves
 * them on demand.
 */

import path from 'node:path';
import {
  pickPipelineProfile,
  type PipelineInput,
  type PipelineProfile,
} from './profiles.js';

/** Standard HLS output for a VOD-like single rendition. Assembled inline by
 *  each builder so the segment-filename pattern can be templated against the
 *  per-session cache dir. */
function hlsOutputFlags(cacheDir: string, _mode: 'vod' | 'event'): ReadonlyArray<string> {
  const segPattern = path.join(cacheDir, 'seg-%05d.ts');
  const playlist = path.join(cacheDir, 'index.m3u8');
  // `event` mode unconditionally — VOD mode buffers the playlist write
  // until ffmpeg has the full duration committed, which makes the first
  // fetch wait unbounded for long sources. Event mode writes the playlist
  // after the first segment lands, then appends as more segments are
  // produced. The mode arg stays in the signature for future use.
  return [
    // 0.1.7 — zero the muxer's PTS preload. Without these, an input-side
    // seek (`-ss N`) leaves the first encoded frame's PTS at its
    // source-time-relative value (e.g. 1.42s into the segment instead of
    // 0). The HLS muxer then writes seg-00000 with a 1.42s "gap" before
    // the first decodable picture, and Chrome's MSE rejects the segment
    // with DEMUXER_ERROR_COULD_NOT_PARSE on the very first parse pass.
    // Verified by ffprobe: with these flags, seg-00000's first frame
    // lands at pts_time≈0.02s; without, it's pts_time≈1.42s.
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    // independent_segments: each segment starts on a keyframe, decodable
    // without earlier ones (required for proper seek). temp_file: ffmpeg
    // writes seg-NNNNN.ts.tmp first then renames, so the route layer never
    // serves a torn write. (Player would otherwise occasionally read a
    // half-written segment and stall.)
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segPattern,
    '-hls_playlist_type', 'event',
    playlist,
  ];
}

/** GPU-side pixel-format conversion — pinned at yuv420p for NVENC. Used by
 *  the modern HLS path; legacy paths handle pixfmt on the CPU. */
const SCALE_CUDA_TO_YUV420P: ReadonlyArray<string> = ['-vf', 'scale_cuda=format=yuv420p'];
const SW_PIX_FMT_YUV420P: ReadonlyArray<string> = ['-pix_fmt', 'yuv420p'];

const NVENC_HWACCEL_INPUT: ReadonlyArray<string> = [
  // 0.1.11 — cap decode threads on the CUDA hwaccel path. ffmpeg's default
  // thread count (= CPU count, 16 here) makes the h264 NVDEC decoder request
  // `threads + 20` decode surfaces (36), which exceeds NVDEC's 32-surface
  // ceiling: `cuvidCreateDecoder` fails with CUDA_ERROR_INVALID_VALUE and,
  // because `-hwaccel_output_format cuda` pins GPU output, there's no
  // software fallback — the session writes zero segments and /open times out
  // (→ 415 hls_unavailable). 4 keeps the surface count well under 32 while
  // preserving decode parallelism. Must precede `-i`.
  '-threads', '4',
  '-hwaccel', 'cuda',
  '-hwaccel_output_format', 'cuda',
];

const NVENC_VIDEO_OUTPUT_FLAGS: ReadonlyArray<string> = [
  '-c:v', 'h264_nvenc',
  '-preset', 'p4',
  '-tune', 'll',
  '-rc', 'vbr',
  '-cq', '23',
  '-g', '60',
];

const AAC_AUDIO_FLAGS: ReadonlyArray<string> = [
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ac', '2',
  '-af', 'aresample=async=1:first_pts=0',
];

function buildMapArgs(audioStreamIndex: number | undefined): ReadonlyArray<string> {
  if (audioStreamIndex === undefined) {
    return ['-map', '0:v:0', '-map', '0:a:0?'];
  }
  return ['-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`];
}

/** Build the `subtitles=…:si=N` filter for burn-in. ffmpeg's filtergraph
 *  parser is two-layer: filter-args are split on `:`, and the values inside
 *  may need escaping so the parser doesn't mistake them for argument
 *  separators. Wrapping the path in single quotes protects `:`, `,`, `[`,
 *  `]`, `;`, `\`, and spaces — but a literal `'` in the path would close the
 *  quoted region. Mid-string `'` therefore needs to be escaped as `'\\\''`
 *  (close, escaped quote, reopen).
 *
 *  Backslashes (Windows separators) are converted to forward slashes first
 *  so the inner-string content never contains `\`, which the parser would
 *  otherwise consume as an escape.
 *
 *  Reference: https://ffmpeg.org/ffmpeg-filters.html#Notes-on-filtergraph-escaping
 */
function buildBurnSubFilter(absPath: string, subIdx: number): string {
  const forward = absPath.replace(/\\/g, '/');
  // Within '…', a literal apostrophe is "close-quote, escape-apostrophe,
  // reopen": '\''. JS string: `'\\\''` which produces the four chars `'\''`.
  const escaped = forward.replace(/'/g, `'\\''`);
  return `subtitles='${escaped}':si=${subIdx}`;
}

/** Input-side seek only.
 *
 *  The fragmented-MP4 path uses a lead/lag pattern (input -ss target-5,
 *  output -ss 5) for sub-frame accuracy. That doesn't work for HLS:
 *  output-side `-ss` discards decoded frames at the encoder's input but
 *  doesn't tell NVENC to emit an IDR at its first kept frame. The
 *  resulting seg-00000 may start on a P-frame referring to discarded
 *  pictures — Chrome's MSE then rejects the segment with
 *  DEMUXER_ERROR_COULD_NOT_PARSE.
 *
 *  Input-side `-ss` is demux-level: ffmpeg snaps to the nearest preceding
 *  keyframe and decodes forward to the seek target. NVENC's first output
 *  frame is then guaranteed to come from a keyframe-aligned decode, so
 *  seg-00000's first picture is real and self-decodable.
 *
 *  Tradeoff: input-side seek is keyframe-quantized — actual playback
 *  starts at whatever IDR is closest before the user-requested time. For
 *  HEVC with long GOPs that can be a few seconds early. The player's
 *  resume-position machinery already handles the offset by storing the
 *  user-visible currentTime separately from streamOffset, so this is
 *  invisible to the user. */
function buildSeekArgs(startSeconds: number | undefined): {
  inputSide: ReadonlyArray<string>;
  outputSide: ReadonlyArray<string>;
} {
  if (!startSeconds || startSeconds <= 0) {
    return { inputSide: [], outputSide: [] };
  }
  return {
    inputSide: ['-ss', String(Math.floor(startSeconds))],
    outputSide: [],
  };
}

function pickPlaylistMode(input: PipelineInput): 'vod' | 'event' {
  // VOD requires knowing the duration up front. Modern matroska/mp4/mov
  // sources always carry it (the demuxer reports it at startup). For
  // pathological sources (truncated, no duration in container) ffmpeg can't
  // write `EXT-X-PLAYLIST-TYPE:VOD` and we degrade to event mode. The
  // session manager passes a probe-known duration through here when known;
  // when 0/undefined we play it safe.
  const dur = (input as PipelineInput & { durationSeconds?: number }).durationSeconds;
  return typeof dur === 'number' && dur > 0 ? 'vod' : 'event';
}

/** Browser-compatible audio codecs the HLS muxer can copy directly into
 *  mpegts. Same set as the fragmented-MP4 path. */
const HLS_AUDIO_REMUX = new Set(['aac', 'mp3']);

/** True when a source can be repackaged into HLS mpegts segments without
 *  re-encoding either stream. h264 video + aac/mp3 audio is the sweet spot
 *  for `-c:v copy -c:a copy` into mpegts.
 *
 *  Why this matters: NVENC h264 → mpegts produces segments that Chrome's
 *  MSE occasionally rejects with `DEMUXER_ERROR_COULD_NOT_PARSE`. The
 *  source's existing h264 stream already has clean keyframes and PTS;
 *  copying preserves that and avoids the entire NVENC pipeline. Burn-in
 *  forces a re-encode (you can't burn into a copied stream). */
function canRemuxHlsCopy(input: PipelineInput): boolean {
  if (input.burnSubStreamIndex !== undefined) return false;
  if (input.videoCodec !== 'h264') return false;
  if (!HLS_AUDIO_REMUX.has(input.audioCodec)) return false;
  return true;
}

/** Build the remux-only HLS arg list. `-c:v copy -c:a copy` straight into
 *  mpegts segments. Cheapest path; only fires for clean h264/aac (or
 *  h264/mp3) sources without burn-in subs.
 *
 *  Note: this path uses input-side seek only (no lead/lag) because
 *  `-c:v copy` cannot drop frames — the output-side `-ss` would discard
 *  packets the muxer needs for keyframe alignment. The codec being copied
 *  IS the source's existing h264, which already has its own clean keyframe
 *  layout, so input-side seek is safe here. */
/** True when the source container can carry an `edts` edit list and uses
 *  AVCC framing for h264 — i.e. ISO BMFF families (MP4/MOV/M4V). MKV and
 *  matroska families have no edit list and h264 is already Annex-B. The
 *  `-ignore_editlist` and `-bsf:v h264_mp4toannexb` flags are MP4-only
 *  and ffmpeg errors out at startup if you pass them to a non-MP4 input. */
function isMp4LikeContainer(container: string): boolean {
  return /\b(mov|mp4|m4a|m4v|3gp|3g2|mj2|isom)\b/i.test(container);
}

function buildRemuxHlsArgs(input: PipelineInput, cacheDir: string): ReadonlyArray<string> {
  const mode = pickPlaylistMode(input);
  const isMp4 = isMp4LikeContainer(input.container);
  // 0.1.9.1 — `-ignore_editlist 1` BEFORE `-i`. YTS-style MP4s carry an
  // `edts` edit list whose first entry can be a 90-second silence/preroll;
  // by default the MP4 demuxer applies the edit list and emits frames with
  // PTS shifted by the offset. ffmpeg's HLS muxer then numbers segments
  // by floor(pts / hls_time) → first written segment is seg-00015
  // instead of seg-00000, and hls.js fails with
  // DEMUXER_ERROR_COULD_NOT_PARSE on any out-of-buffer seek.
  //
  // 0.1.9.2 — guard with isMp4 so passing this to a Matroska/WebM
  // demuxer doesn't crash ffmpeg at startup with "Option ignore_editlist
  // not found".
  const inputSide: string[] = isMp4 ? ['-ignore_editlist', '1'] : [];
  if (input.startSeconds && input.startSeconds > 0) {
    inputSide.push('-ss', String(Math.floor(input.startSeconds)));
  }
  // 0.1.9.1 — h264 in MP4 uses AVCC framing (length-prefixed NALUs);
  // mpegts needs Annex-B (start-code-prefixed). ffmpeg usually inserts
  // the BSF automatically but the auto-insertion is unreliable across
  // copy/seek combinations. Force it explicitly for MP4 inputs only —
  // MKV's h264 is already Annex-B and the BSF would be a no-op or
  // worse confuse the muxer.
  const videoBsf: string[] = isMp4 ? ['-bsf:v', 'h264_mp4toannexb'] : [];
  return [
    '-loglevel', 'info',
    '-y',
    ...inputSide,
    '-i', input.absPath,
    ...buildMapArgs(input.audioStreamIndex),
    '-c:v', 'copy',
    '-c:a', 'copy',
    ...videoBsf,
    // Belt-and-suspenders: rebase any leftover negative PTS to zero.
    '-avoid_negative_ts', 'make_zero',
    ...hlsOutputFlags(cacheDir, mode),
  ];
}

/** Build the modern-source HLS arg list. NVENC, GPU pixfmt convert, AAC.
 *
 *  Three sub-shapes depending on burn-in state:
 *    1. No burn-in       → `-hwaccel cuda` + `-vf scale_cuda=format=yuv420p`.
 *    2. Text-sub burn-in → `-hwaccel cuda` + `-vf hwdownload,format=nv12,subtitles=…,format=yuv420p`.
 *    3. Image-sub burn-in → no hwaccel; `-filter_complex
 *       "[0:v][0:s:N]overlay[outv]"` with `-map [outv]`. The overlay filter
 *       requires the subtitle stream to be decoded as a separate input —
 *       impossible on the GPU path because NVDEC doesn't decode
 *       PGS/dvd_subtitle/dvb_subtitle. We pay a CPU decode for the video
 *       too, but NVENC still encodes (ffmpeg uploads frames implicitly).
 */
function buildModernHlsArgs(input: PipelineInput, cacheDir: string): ReadonlyArray<string> {
  const mode = pickPlaylistMode(input);
  const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);

  if (input.burnSubStreamIndex !== undefined && input.burnSubTextBased === false) {
    // Image-sub overlay path. No hwaccel; software decode + overlay + NVENC encode.
    const filter = buildImageOverlayFilter(input.burnSubStreamIndex);
    return [
      '-loglevel', 'info',
      '-y',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      '-filter_complex', filter,
      '-map', '[outv]',
      // Audio still maps from input by index.
      '-map', input.audioStreamIndex !== undefined
        ? `0:a:${input.audioStreamIndex}`
        : '0:a:0?',
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...SW_PIX_FMT_YUV420P,
      ...AAC_AUDIO_FLAGS,
      ...hlsOutputFlags(cacheDir, mode),
    ];
  }

  // Text-sub or no burn-in path: NVENC with CUDA decode.
  let vf: ReadonlyArray<string>;
  if (input.burnSubStreamIndex !== undefined) {
    const burn = buildBurnSubFilter(input.absPath, input.burnSubStreamIndex);
    // Burn-in needs CPU-side `subtitles=` filter; download from GPU first.
    vf = ['-vf', `hwdownload,format=nv12,${burn},format=yuv420p`];
  } else {
    vf = SCALE_CUDA_TO_YUV420P;
  }
  return [
    '-loglevel', 'info',
    '-y',
    ...NVENC_HWACCEL_INPUT,
    ...inputSide,
    '-i', input.absPath,
    ...outputSide,
    ...buildMapArgs(input.audioStreamIndex),
    ...vf,
    ...NVENC_VIDEO_OUTPUT_FLAGS,
    ...AAC_AUDIO_FLAGS,
    ...hlsOutputFlags(cacheDir, mode),
  ];
}

/** Build the filter_complex graph for image-based subtitle burn-in. The
 *  source's Nth subtitle stream is overlaid onto the video, producing a
 *  labeled `[outv]` for the encoder.
 *
 *  PGS (Blu-ray) and dvb_subtitle decode to RGBA frames with timed
 *  presentation. The `overlay` filter handles sparseness — segments where
 *  no sub is showing pass the underlying video through unchanged. */
function buildImageOverlayFilter(subIdx: number): string {
  return `[0:v][0:s:${subIdx}]overlay[outv]`;
}

/** Legacy AVI (Xvid / packed-bitstream MPEG-4) → HLS. Software decode +
 *  NVENC encode + the same Xvid workaround set the existing nvenc-legacy-avi
 *  profile applies. */
function buildLegacyAviHlsArgs(input: PipelineInput, cacheDir: string): ReadonlyArray<string> {
  const mode = pickPlaylistMode(input);
  const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);

  // Image-sub burn-in routes through filter_complex + overlay; same shape as
  // the modern path's image branch, just with the Xvid workaround input flags.
  if (input.burnSubStreamIndex !== undefined && input.burnSubTextBased === false) {
    const filter = buildImageOverlayFilter(input.burnSubStreamIndex);
    return [
      '-loglevel', 'info',
      '-y',
      '-fflags', '+genpts',
      '-bsf:v', 'mpeg4_unpack_bframes',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      '-filter_complex', filter,
      '-map', '[outv]',
      '-map', input.audioStreamIndex !== undefined
        ? `0:a:${input.audioStreamIndex}`
        : '0:a:0?',
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...SW_PIX_FMT_YUV420P,
      '-fps_mode', 'cfr',
      ...AAC_AUDIO_FLAGS,
      ...hlsOutputFlags(cacheDir, mode),
    ];
  }

  const burnVf =
    input.burnSubStreamIndex !== undefined
      ? ['-vf', buildBurnSubFilter(input.absPath, input.burnSubStreamIndex)]
      : [];
  return [
    '-loglevel', 'info',
    '-y',
    '-fflags', '+genpts',
    '-bsf:v', 'mpeg4_unpack_bframes',
    ...inputSide,
    '-i', input.absPath,
    ...outputSide,
    ...buildMapArgs(input.audioStreamIndex),
    ...burnVf,
    ...NVENC_VIDEO_OUTPUT_FLAGS,
    ...SW_PIX_FMT_YUV420P,
    '-fps_mode', 'cfr',
    ...AAC_AUDIO_FLAGS,
    ...hlsOutputFlags(cacheDir, mode),
  ];
}

/** Legacy TS (MPEG-2 / VC-1) → HLS. Same shape as legacy AVI minus the
 *  Xvid-specific bitstream filter. */
function buildLegacyTsHlsArgs(input: PipelineInput, cacheDir: string): ReadonlyArray<string> {
  const mode = pickPlaylistMode(input);
  const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);

  if (input.burnSubStreamIndex !== undefined && input.burnSubTextBased === false) {
    const filter = buildImageOverlayFilter(input.burnSubStreamIndex);
    return [
      '-loglevel', 'info',
      '-y',
      '-fflags', '+genpts',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      '-filter_complex', filter,
      '-map', '[outv]',
      '-map', input.audioStreamIndex !== undefined
        ? `0:a:${input.audioStreamIndex}`
        : '0:a:0?',
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...SW_PIX_FMT_YUV420P,
      '-fps_mode', 'cfr',
      ...AAC_AUDIO_FLAGS,
      ...hlsOutputFlags(cacheDir, mode),
    ];
  }

  const burnVf =
    input.burnSubStreamIndex !== undefined
      ? ['-vf', buildBurnSubFilter(input.absPath, input.burnSubStreamIndex)]
      : [];
  return [
    '-loglevel', 'info',
    '-y',
    '-fflags', '+genpts',
    ...inputSide,
    '-i', input.absPath,
    ...outputSide,
    ...buildMapArgs(input.audioStreamIndex),
    ...burnVf,
    ...NVENC_VIDEO_OUTPUT_FLAGS,
    ...SW_PIX_FMT_YUV420P,
    '-fps_mode', 'cfr',
    ...AAC_AUDIO_FLAGS,
    ...hlsOutputFlags(cacheDir, mode),
  ];
}

/** Pick HLS args for a probed source. Reuses `pickPipelineProfile()` for the
 *  source-class decision; only the output side differs. */
export function buildHlsArgs(input: PipelineInput, cacheDir: string): {
  profile: PipelineProfile;
  args: ReadonlyArray<string>;
} {
  const profile = pickPipelineProfile(input);
  let args: ReadonlyArray<string>;
  switch (profile.name) {
    case 'nvenc-legacy-avi':
      args = buildLegacyAviHlsArgs(input, cacheDir);
      break;
    case 'nvenc-legacy-ts':
      args = buildLegacyTsHlsArgs(input, cacheDir);
      break;
    default:
      // 0.1.7 — clean h264/aac (or h264/mp3) sources without burn-in remux
      // straight into mpegts (`-c:v copy -c:a copy`). The legacy path would
      // have served these direct; HLS still has to repackage them but
      // re-encoding them through NVENC produces mpegts segments Chrome's
      // MSE intermittently rejects with DEMUXER_ERROR_COULD_NOT_PARSE.
      // Anything that genuinely needs an encode (HEVC, VP9, AV1, etc.) or
      // a burn-in falls through to nvenc-modern.
      if (profile.name === 'remux-modern' && canRemuxHlsCopy(input)) {
        args = buildRemuxHlsArgs(input, cacheDir);
      } else {
        args = buildModernHlsArgs(input, cacheDir);
      }
      break;
  }
  return { profile, args };
}
