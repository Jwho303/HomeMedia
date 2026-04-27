import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FastifyReply } from 'fastify';
import {
  pickPipelineProfile,
  type PipelineInput,
  type PipelineProfile,
  type AudioStrategy,
  PROFILE_NVENC_MODERN,
  PROFILE_REMUX_MODERN,
} from './streaming/profiles.js';

const MIME_BY_EXT: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
};

export function mimeForExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range "bytes=START-END" header. Returns null when the header is absent.
 * Returns the symbol `INVALID` when the header is present but unparseable / out of range —
 * caller should respond 416.
 */
export const INVALID: unique symbol = Symbol('invalid range');
export type RangeResult = ParsedRange | typeof INVALID | null;

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return INVALID;
  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return INVALID;
  if (startStr === '') {
    // Suffix range: "bytes=-N" → last N bytes.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return INVALID;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return INVALID;
  if (start < 0 || end < start || start >= size) return INVALID;
  if (end >= size) end = size - 1;
  return { start, end };
}

export async function streamFile(reply: FastifyReply, absPath: string, range: RangeResult): Promise<void> {
  const stat = await fs.stat(absPath);
  const size = stat.size;
  const mime = mimeForExt(absPath);

  const parsed = range === null ? null : range === INVALID ? INVALID : range;

  if (parsed === INVALID) {
    reply.code(416).header('Content-Range', `bytes */${size}`).send({ error: 'range_not_satisfiable' });
    return;
  }

  if (parsed === null) {
    reply
      .code(200)
      .header('Content-Type', mime)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(size))
      .send(createReadStream(absPath));
    return;
  }

  const { start, end } = parsed;
  const len = end - start + 1;
  reply
    .code(206)
    .header('Content-Type', mime)
    .header('Accept-Ranges', 'bytes')
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', String(len))
    .send(createReadStream(absPath, { start, end }));
}

// ----- ffmpeg pipeline (0.1.4.2 — profile-driven) --------------------------

export type RemuxSpawn = (
  cmd: string,
  args: ReadonlyArray<string>,
) => ChildProcessWithoutNullStreams;

const defaultRemuxSpawn: RemuxSpawn = (cmd, args) =>
  spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;

let activeRemuxSpawn: RemuxSpawn = defaultRemuxSpawn;

export function setRemuxSpawnForTests(spawnFn: RemuxSpawn | null): void {
  activeRemuxSpawn = spawnFn ?? defaultRemuxSpawn;
}

const liveRemuxes = new Set<ChildProcessWithoutNullStreams>();

export function liveRemuxCount(): number {
  return liveRemuxes.size;
}

/**
 * Kill every tracked ffmpeg process. Wired to Fastify's `onClose` so server
 * shutdown doesn't leak workers.
 */
export function killAllRemuxProcesses(): void {
  for (const ff of liveRemuxes) {
    try {
      ff.kill('SIGKILL');
    } catch {
      // best-effort
    }
  }
  liveRemuxes.clear();
}

export interface PipelineOptions {
  spawn?: RemuxSpawn;
  startSeconds?: number;
  audioCodec?: string;
  videoCodec?: string;
  container?: string;
  /** When set, the route layer asks for an NVENC pipeline regardless of what
   *  the source codec would normally select. Used for the explicit
   *  `?accel=nvenc` override (typically a fallback after the remux attempt
   *  failed in the browser). */
  forceNvenc?: boolean;
  /** When set, force the lean remux path (used by `?remux=true` when the
   *  source is a clean h264 MKV/MP4). */
  forceRemux?: boolean;
  /** ffmpeg local audio stream index (`0:a:<n>`). Threaded through to
   *  every profile's `-map`. (0.1.4.3) */
  audioStreamIndex?: number;
  /** ffmpeg local subtitle stream index (`0:s:<n>`) to burn in. Implies
   *  NVENC because `-c:v copy` can't burn — `resolveProfile()` promotes a
   *  remux pick to nvenc-modern when this is set. (0.1.4.3) */
  burnSubStreamIndex?: number;
}

/** Internal helper: spawn an ffmpeg child with the given args, pipe its stdout
 *  to the reply, and wire lifecycle (tracking + close → SIGKILL). */
function streamFfmpeg(
  args: ReadonlyArray<string>,
  reply: FastifyReply,
  spawnFn: RemuxSpawn,
): void {
  const ff = spawnFn('ffmpeg', args);
  liveRemuxes.add(ff);

  const cleanup = (): void => {
    liveRemuxes.delete(ff);
  };

  ff.on('exit', cleanup);
  ff.on('error', (err) => {
    cleanup();
    reply.log.error({ err }, 'ffmpeg spawn error');
    if (!reply.sent) {
      try { reply.code(500).send({ error: 'ffmpeg_unavailable' }); } catch { /* socket closed */ }
    }
    reply.raw.destroy(err);
  });

  ff.stderr.on('data', (b: Buffer) => {
    reply.log.warn({ ffmpeg: b.toString('utf8').trim() });
  });

  // Client disconnect → kill the worker. close fires on tab close, navigation, network drop.
  reply.raw.on('close', () => {
    if (!ff.killed) ff.kill('SIGKILL');
  });

  reply.header('Content-Type', 'video/mp4');
  reply.send(ff.stdout);
}

/** Compute the `PipelineInput` from `PipelineOptions` for profile selection. */
function toProfileInput(absPath: string, opts: PipelineOptions): PipelineInput {
  const input: PipelineInput = {
    absPath,
    videoCodec: opts.videoCodec ?? '',
    audioCodec: opts.audioCodec ?? '',
    container: opts.container ?? '',
  };
  if (opts.startSeconds !== undefined) input.startSeconds = opts.startSeconds;
  if (opts.audioStreamIndex !== undefined) input.audioStreamIndex = opts.audioStreamIndex;
  if (opts.burnSubStreamIndex !== undefined) input.burnSubStreamIndex = opts.burnSubStreamIndex;
  return input;
}

/**
 * Resolve the URL flags + probe data into a concrete profile.
 *
 * - `forceRemux` always lands on `remux-modern` (the only remux profile).
 * - `forceNvenc` overrides the natural choice to an NVENC profile — if the
 *   source-derived profile is already NVENC we keep its specialization
 *   (legacy-avi, legacy-ts, etc.); otherwise we fall back to `nvenc-modern`.
 * - No override → whatever `pickPipelineProfile()` returns.
 */
export function resolveProfile(absPath: string, opts: PipelineOptions): PipelineProfile {
  const input = toProfileInput(absPath, opts);
  // 0.1.4.3 — burning a subtitle requires re-encode; `-c:v copy` can't do it.
  // Force NVENC and never honor forceRemux when the caller asks for burn-in.
  const burnIn = opts.burnSubStreamIndex !== undefined;
  if (opts.forceRemux && !burnIn) return PROFILE_REMUX_MODERN;
  const natural = pickPipelineProfile(input);
  if ((opts.forceNvenc || burnIn) && natural.accel !== 'nvenc') return PROFILE_NVENC_MODERN;
  return natural;
}

/** Build the ffmpeg arg list for the chosen profile. Pure — used by both the
 *  live spawn path and the read-only diagnostics endpoint. */
export function buildPipelineArgs(absPath: string, opts: PipelineOptions): {
  profile: PipelineProfile;
  args: ReadonlyArray<string>;
  audioStrategy: AudioStrategy;
} {
  const profile = resolveProfile(absPath, opts);
  const input = toProfileInput(absPath, opts);
  return {
    profile,
    args: profile.buildArgs(input),
    audioStrategy: profile.audioStrategy(input),
  };
}

/**
 * Spawn an ffmpeg pipeline for a probed source. Picks the right profile based
 * on the probe data + URL flags, builds its arg list, emits a single
 * structured `pipeline.spawn` log line at info level capturing the entire
 * decision, and pumps the resulting fragmented MP4 to the reply.
 */
export function runPipeline(
  absPath: string,
  reply: FastifyReply,
  relPath: string,
  opts: PipelineOptions = {},
): void {
  const sp = opts.spawn ?? activeRemuxSpawn;
  const { profile, args, audioStrategy } = buildPipelineArgs(absPath, opts);

  const startSeconds = opts.startSeconds ?? 0;
  reply.log.info(
    {
      evt: 'pipeline.spawn',
      reqId: reply.request.id,
      relPath,
      source: {
        container: opts.container ?? '',
        videoCodec: opts.videoCodec ?? '',
        audioCodec: opts.audioCodec ?? '',
      },
      decision: {
        profile: profile.name,
        accel: profile.accel,
        audioStrategy,
        startSeconds,
        seekStrategy: startSeconds > 0 ? 'restart' : 'fresh',
        audioStreamIndex: opts.audioStreamIndex,
        burnSubStreamIndex: opts.burnSubStreamIndex,
      },
      ffmpegArgs: args,
    },
    'pipeline spawned',
  );

  streamFfmpeg(args, reply, sp);
}

// ----- Back-compat shims --------------------------------------------------
// `remux()` and `transcodeNvenc()` are retained as thin wrappers that
// translate the old API to a `runPipeline()` call. Tests and any old import
// sites continue to work without change.

export interface RemuxOptions {
  spawn?: RemuxSpawn;
  startSeconds?: number;
  audioCodec?: string;
  videoCodec?: string;
  container?: string;
}

function compatPipelineOpts(opts: RemuxOptions, force: 'remux' | 'nvenc'): PipelineOptions {
  const out: PipelineOptions = {};
  if (opts.spawn !== undefined) out.spawn = opts.spawn;
  if (opts.startSeconds !== undefined) out.startSeconds = opts.startSeconds;
  if (opts.audioCodec !== undefined) out.audioCodec = opts.audioCodec;
  if (opts.videoCodec !== undefined) out.videoCodec = opts.videoCodec;
  if (opts.container !== undefined) out.container = opts.container;
  if (force === 'remux') out.forceRemux = true;
  else out.forceNvenc = true;
  return out;
}

/** @deprecated Use `runPipeline()`. Retained for the existing route +
 *  test surface. */
export function remux(absPath: string, reply: FastifyReply, opts: RemuxOptions = {}): void {
  runPipeline(absPath, reply, absPath, compatPipelineOpts(opts, 'remux'));
}

/** @deprecated Use `runPipeline()`. Retained for the existing route +
 *  test surface. */
export function transcodeNvenc(absPath: string, reply: FastifyReply, opts: RemuxOptions = {}): void {
  runPipeline(absPath, reply, absPath, compatPipelineOpts(opts, 'nvenc'));
}

// ----- Legacy exports for tests -------------------------------------------
// The old tests reference these constants. Keep them around but mark them
// deprecated so new code uses the profile system.

/** @deprecated Use a profile's `buildArgs()` output instead. */
export const REMUX_FFMPEG_ARGS: ReadonlyArray<string> = [
  '-loglevel', 'warning',
  '-c:v', 'copy',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
  '-f', 'mp4',
  'pipe:1',
];

/** @deprecated Use a profile's `buildArgs()` output instead. */
export const NVENC_FFMPEG_ARGS: ReadonlyArray<string> = [
  '-loglevel', 'warning',
  '-hwaccel', 'cuda',
  '-hwaccel_output_format', 'cuda',
];

/** @deprecated Use a profile's `buildArgs()` output instead. */
export const NVENC_OUTPUT_ARGS: ReadonlyArray<string> = [
  '-c:v', 'h264_nvenc',
  '-preset', 'p4',
  '-tune', 'll',
  '-rc', 'vbr',
  '-cq', '23',
  '-pix_fmt', 'yuv420p',
  '-g', '60',
  '-c:a', 'copy',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
  '-f', 'mp4',
  'pipe:1',
];
