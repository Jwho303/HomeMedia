/**
 * Codec-aware ffmpeg pipeline profiles (0.1.4.2).
 *
 * Replaces 0.1.4's "one ffmpeg arg list for every source" approach with named
 * per-source-class profiles. Each profile owns the *exact* set of flags that
 * its source class needs — no more, no less. Adding `-re` to fix Xvid no
 * longer cripples HEVC scrubbing; adding `+genpts` to fix AVI no longer
 * stutters modern VFR sources.
 *
 * The four profiles:
 *   - `remux-modern`         — MKV/MP4 H.264 → fragmented MP4, `-c:v copy`,
 *                              no input-side workarounds.
 *   - `nvenc-modern`         — HEVC (or other clean transcode-required
 *                              source) → H.264 via NVENC, no `-re`, no
 *                              `-bsf`, no PTS regen.
 *   - `nvenc-legacy-avi`     — Xvid / packed-bitstream MPEG-4 → H.264 with
 *                              the full Xvid workaround set.
 *   - `nvenc-legacy-ts`      — MPEG-2 / VC-1 transport-stream-flavoured
 *                              sources. Same shape as legacy-avi.
 *
 * Profile selection lives in `pickPipelineProfile()` and is driven entirely
 * by ffprobe-derived facts about the source. The route layer never calls
 * the individual builders directly.
 */

const FRAG_MP4_OUTPUT_FLAGS: ReadonlyArray<string> = [
  // `+separate_moof` writes one moof per track instead of bundling all tracks
  // into a single moof. Old Chromium MSE (notably the Catalina-era Chrome 128
  // build that still ships on some Macs) ingests separate-moof fragments
  // reliably; the bundled form can stall after the first fragment with no
  // error. `+frag_keyframe` keeps fragment boundaries on keyframes;
  // `+empty_moov` lets us start streaming before knowing the full duration;
  // `+default_base_moof` is the standards-mode tfdt anchor MSE wants.
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof+separate_moof',
  // Cap fragment duration at 2s. Smaller frags → more frequent moof boxes →
  // MSE has more checkpoints to ingest. Without this, ffmpeg may emit one
  // long fragment per GOP, and a slow-to-start MSE implementation has only
  // one chance to handshake.
  '-frag_duration', '2000000',
  '-f', 'mp4',
  'pipe:1',
];

const NVENC_HWACCEL_INPUT: ReadonlyArray<string> = [
  '-hwaccel', 'cuda',
  '-hwaccel_output_format', 'cuda',
];

/** NVENC video output flags shared across every NVENC profile. `-g 60` keeps
 *  GOPs small (Chrome's MSE prefers ~2s keyframe spacing at 30fps). The
 *  output pixel format is **not** set here — when `-hwaccel_output_format
 *  cuda` is in play, pinning `-pix_fmt yuv420p` at the encoder makes ffmpeg
 *  insert an auto-scaler that can't bridge `cuda` → CPU formats and fails
 *  with "Impossible to convert between the formats supported by the filter
 *  'Parsed_null_0' and the filter 'auto_scale_0'". Profiles that use CUDA
 *  hwaccel handle pixel format on the GPU via `scale_cuda=format=yuv420p`;
 *  profiles that decode on the CPU append `-pix_fmt yuv420p` here. */
const NVENC_VIDEO_OUTPUT_FLAGS: ReadonlyArray<string> = [
  '-c:v', 'h264_nvenc',
  '-preset', 'p4',
  '-tune', 'll',
  '-rc', 'vbr',
  '-cq', '23',
  '-g', '60',
];

/** GPU-side pixel-format conversion for the CUDA hwaccel path. Use as a
 *  `-vf` filter when `-hwaccel_output_format cuda` is set so 10-bit / non-
 *  4:2:0 inputs (e.g. HEVC Main 10) get downconverted on the GPU before
 *  hitting NVENC. Leaves 8-bit 4:2:0 inputs unchanged (no-op cost). */
const SCALE_CUDA_TO_YUV420P: ReadonlyArray<string> = ['-vf', 'scale_cuda=format=yuv420p'];

/** CPU-side pixel format pin. Used by NVENC profiles that decode on the CPU
 *  (e.g. legacy-avi/legacy-ts where NVDEC support is unreliable). */
const SW_PIX_FMT_YUV420P: ReadonlyArray<string> = ['-pix_fmt', 'yuv420p'];

/** Browser-compatible audio codecs the remux can copy directly. */
const BROWSER_AUDIO_DIRECT = new Set(['aac', 'mp3', 'opus', 'vorbis']);

/** Codecs the bare `<video>` element decodes universally without remux. */
const BROWSER_VIDEO_DIRECT = new Set(['h264', 'vp8', 'vp9', 'av1']);

const SEEK_LEAD_SECONDS = 5;

export interface PipelineInput {
  absPath: string;
  videoCodec: string;
  audioCodec: string;
  container: string;
  /** Fast-but-accurate seek target. 0 / undefined → start from beginning. */
  startSeconds?: number;
  /** ffmpeg local audio stream index (e.g. 1 from `0:a:1`). When undefined the
   *  profile defaults to the file's `default` audio (matches today's
   *  behavior). (0.1.4.3) */
  audioStreamIndex?: number;
  /** Burn an embedded subtitle into the video. When undefined, subs render as
   *  a `<track>` on the client. Burn-in implies an NVENC profile because
   *  `-c:v copy` can't burn — the route layer is responsible for promoting
   *  remux→nvenc when this is set. (0.1.4.3) */
  burnSubStreamIndex?: number;
}

export type AudioStrategy = 'copy' | 'transcode';

export interface PipelineProfile {
  /** Stable name for logging/tests. */
  name: string;
  /** True when this profile invokes NVENC; drives the diagnostics overlay. */
  accel: 'nvenc' | null;
  /** Build the ffmpeg arg list for a given source. Pure function. */
  buildArgs(input: PipelineInput): ReadonlyArray<string>;
  /** Inspect the source and report the audio strategy this profile would
   *  pick. Used by the diagnostics endpoint without spawning ffmpeg. */
  audioStrategy(input: PipelineInput): AudioStrategy;
}

// ----- Helpers -------------------------------------------------------------

function buildSeekArgs(startSeconds: number | undefined): {
  inputSide: ReadonlyArray<string>;
  outputSide: ReadonlyArray<string>;
} {
  if (!startSeconds || startSeconds <= 0) {
    return { inputSide: [], outputSide: [] };
  }
  if (startSeconds <= SEEK_LEAD_SECONDS) {
    return { inputSide: [], outputSide: ['-ss', String(startSeconds)] };
  }
  return {
    inputSide: ['-ss', String(startSeconds - SEEK_LEAD_SECONDS)],
    outputSide: ['-ss', String(SEEK_LEAD_SECONDS)],
  };
}

function pickAudioStrategy(audioCodec: string | undefined): AudioStrategy {
  return audioCodec && BROWSER_AUDIO_DIRECT.has(audioCodec) ? 'copy' : 'transcode';
}

/** Map flags for selecting the output video + audio streams. When
 *  `audioStreamIndex` is undefined the profile falls through to the file's
 *  default audio (matches today's behavior). (0.1.4.3) */
function buildMapArgs(audioStreamIndex: number | undefined): ReadonlyArray<string> {
  if (audioStreamIndex === undefined) {
    // Map the first video stream + the default audio, leaving subtitle/data
    // streams behind. Without an explicit `-map` the muxer auto-picks every
    // stream, which corrupts the fragmented MP4 output.
    return ['-map', '0:v:0', '-map', '0:a:0?'];
  }
  return ['-map', '0:v:0', '-map', `0:a:${audioStreamIndex}`];
}

/** Build the subtitles filter for burn-in. Uses `subtitles=<absPath>:si=<n>`,
 *  the canonical ffmpeg form. ffmpeg's filter requires forward slashes and
 *  some characters need escaping; we keep it simple by reflecting the path
 *  verbatim and trusting the caller's resolveStreamPath sandboxing. */
function buildBurnSubFilter(absPath: string, subIdx: number): string {
  // Backslashes (Windows) and colons need escaping in lavfi expressions.
  const escaped = absPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  return `subtitles='${escaped}':si=${subIdx}`;
}

/** Modern audio recipe — clean source, no PTS rescue needed. */
function audioArgsModern(audioCodec: string | undefined): ReadonlyArray<string> {
  if (pickAudioStrategy(audioCodec) === 'copy') return ['-c:a', 'copy'];
  // AAC LC at 192kbps stereo. The aresample filter forces the resampler to
  // track source PTS and stretch/squeeze to match — needed even on modern
  // sources after a mid-file seek with `-c:v copy`, because the encoder's
  // frame clock and source PTS clock drift apart by hundreds of µs/frame.
  return [
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
  ];
}

/** Legacy audio recipe — VFR / broken-PTS source. The aresample filter is
 *  the same as modern, but we always transcode (legacy MP3 / AC3 / etc.
 *  paired with packed-bitstream video doesn't survive `-c:a copy`). */
function audioArgsLegacy(_audioCodec: string | undefined): ReadonlyArray<string> {
  return [
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
  ];
}

// ----- Profile: remux-modern ----------------------------------------------

export const PROFILE_REMUX_MODERN: PipelineProfile = {
  name: 'remux-modern',
  accel: null,
  buildArgs(input) {
    const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);
    // HEVC bitstream copies need the `hvc1` sample-entry tag (parameter sets
    // in the sample description) to play in fragmented MP4 across browsers.
    // ffmpeg's default is `hev1` (parameter sets inline in NAL units), which
    // Chrome on Mac silently plays as audio-only — Safari is more forgiving.
    // For h264 / vp9 etc. this tag is a no-op.
    const videoTag =
      input.videoCodec === 'hevc' || input.videoCodec === 'h265'
        ? ['-tag:v', 'hvc1']
        : [];
    return [
      '-loglevel', 'warning',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      ...buildMapArgs(input.audioStreamIndex),
      '-c:v', 'copy',
      ...videoTag,
      ...audioArgsModern(input.audioCodec),
      ...FRAG_MP4_OUTPUT_FLAGS,
    ];
  },
  audioStrategy(input) {
    return pickAudioStrategy(input.audioCodec);
  },
};

// ----- Profile: nvenc-modern -----------------------------------------------

export const PROFILE_NVENC_MODERN: PipelineProfile = {
  name: 'nvenc-modern',
  accel: 'nvenc',
  buildArgs(input) {
    const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);
    // Build the video filter chain. With CUDA hwaccel we always need an
    // on-GPU pixel-format conversion to yuv420p (NVENC's input must be 8-bit
    // 4:2:0; HEVC Main 10 inputs arrive as p010le and would otherwise force
    // ffmpeg to insert an auto-scaler that can't bridge cuda → CPU formats).
    // Burn-in subtitles use the CPU `subtitles=` filter, so they run after
    // an explicit GPU→CPU `hwdownload`+`format=nv12` and we omit scale_cuda.
    let vf: ReadonlyArray<string>;
    if (input.burnSubStreamIndex !== undefined) {
      const burn = buildBurnSubFilter(input.absPath, input.burnSubStreamIndex);
      vf = ['-vf', `hwdownload,format=nv12,${burn},format=yuv420p`];
    } else {
      vf = SCALE_CUDA_TO_YUV420P;
    }
    return [
      '-loglevel', 'warning',
      ...NVENC_HWACCEL_INPUT,
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      ...buildMapArgs(input.audioStreamIndex),
      ...vf,
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...audioArgsModern(input.audioCodec),
      ...FRAG_MP4_OUTPUT_FLAGS,
    ];
  },
  audioStrategy(input) {
    return pickAudioStrategy(input.audioCodec);
  },
};

// ----- Profile: nvenc-legacy-avi ------------------------------------------

export const PROFILE_NVENC_LEGACY_AVI: PipelineProfile = {
  name: 'nvenc-legacy-avi',
  accel: 'nvenc',
  buildArgs(input) {
    const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);
    const burnVf =
      input.burnSubStreamIndex !== undefined
        ? ['-vf', buildBurnSubFilter(input.absPath, input.burnSubStreamIndex)]
        : [];
    // Note: no `-hwaccel cuda` here. NVDEC's MPEG-4 ASP support won't reliably
    // decode Xvid's packed-bitstream variant, so ffmpeg falls back to the
    // software mpeg4 decoder — which produces CPU-side frames while
    // `-hwaccel_output_format cuda` still claims GPU output, and the auto
    // scaler then errors with "Impossible to convert ... src: cuda → dst:
    // <yuv420p ...>" before any frame reaches NVENC. Decode in software;
    // only encode on the GPU. NVENC will upload frames implicitly.
    return [
      '-loglevel', 'warning',
      // Regenerate PTS from packet order — Xvid AVIs ship with timestamps
      // the MP4 demuxer interprets as "this 9MB chunk represents 20 minutes".
      '-fflags', '+genpts',
      // Pace input at 1× wallclock. The fragmented MP4 produced by NVENC for
      // AVI sources has subtle structural quirks that confuse Chrome's MSE
      // when delivered too fast — empirically the only way to keep playback
      // alive on these sources.
      '-re',
      // Unpack Xvid packed-bitstream B-frames before decode. Without this,
      // ffmpeg's mpeg4 decoder rejects most packets ("Discarding excessive
      // bitstream in packed xvid") and NVENC encodes only a handful of valid
      // frames — moov advertises 20 minutes but only 1-2s of video data
      // exists, browser hits EOF immediately and fires `ended`.
      '-bsf:v', 'mpeg4_unpack_bframes',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      ...buildMapArgs(input.audioStreamIndex),
      ...burnVf,
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...SW_PIX_FMT_YUV420P,
      // Force a constant frame rate at the encoder so the produced H.264 has
      // clean evenly-spaced timestamps regardless of source packet timing.
      '-fps_mode', 'cfr',
      ...audioArgsLegacy(input.audioCodec),
      ...FRAG_MP4_OUTPUT_FLAGS,
    ];
  },
  audioStrategy() {
    return 'transcode';
  },
};

// ----- Profile: nvenc-legacy-ts -------------------------------------------

export const PROFILE_NVENC_LEGACY_TS: PipelineProfile = {
  name: 'nvenc-legacy-ts',
  accel: 'nvenc',
  buildArgs(input) {
    const { inputSide, outputSide } = buildSeekArgs(input.startSeconds);
    const burnVf =
      input.burnSubStreamIndex !== undefined
        ? ['-vf', buildBurnSubFilter(input.absPath, input.burnSubStreamIndex)]
        : [];
    // Note: no `-hwaccel cuda` here. MPEG-2 / VC-1 sources frequently fall
    // back to software decode when NVDEC rejects the bitstream variant; same
    // failure mode as legacy-avi (CPU frames vs `-hwaccel_output_format
    // cuda` claim → auto-scaler error before NVENC sees a packet). Software
    // decode + NVENC encode is the safe path.
    return [
      '-loglevel', 'warning',
      '-fflags', '+genpts',
      '-re',
      ...inputSide,
      '-i', input.absPath,
      ...outputSide,
      ...buildMapArgs(input.audioStreamIndex),
      ...burnVf,
      ...NVENC_VIDEO_OUTPUT_FLAGS,
      ...SW_PIX_FMT_YUV420P,
      '-fps_mode', 'cfr',
      ...audioArgsLegacy(input.audioCodec),
      ...FRAG_MP4_OUTPUT_FLAGS,
    ];
  },
  audioStrategy() {
    return 'transcode';
  },
};

// ----- Selection -----------------------------------------------------------

function isLegacyAVI(input: PipelineInput): boolean {
  return input.videoCodec === 'mpeg4' && input.container.includes('avi');
}

function isLegacyTS(input: PipelineInput): boolean {
  if (input.videoCodec === 'mpeg2video' || input.videoCodec === 'vc1') return true;
  if (input.container.includes('mpegts')) return true;
  if (input.container.includes('asf')) return true;
  return false;
}

function needsNvenc(input: PipelineInput): boolean {
  // h264 stays on the remux path; everything else outside the
  // BROWSER_VIDEO_DIRECT set needs a real encode.
  if (input.videoCodec === 'h264') return false;
  return !BROWSER_VIDEO_DIRECT.has(input.videoCodec);
}

/**
 * Pick the right profile for a probed source. `direct` (range serving) is
 * handled upstream by `streamFile()`; this function is only consulted when
 * an ffmpeg pipeline is going to spawn.
 */
export function pickPipelineProfile(input: PipelineInput): PipelineProfile {
  if (isLegacyAVI(input)) return PROFILE_NVENC_LEGACY_AVI;
  if (isLegacyTS(input))  return PROFILE_NVENC_LEGACY_TS;
  if (needsNvenc(input))  return PROFILE_NVENC_MODERN;
  return PROFILE_REMUX_MODERN;
}

export const ALL_PROFILES: ReadonlyArray<PipelineProfile> = [
  PROFILE_REMUX_MODERN,
  PROFILE_NVENC_MODERN,
  PROFILE_NVENC_LEGACY_AVI,
  PROFILE_NVENC_LEGACY_TS,
];
