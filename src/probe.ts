import { spawn } from 'node:child_process';
import type {
  AudioStream,
  Chapter,
  ProbeResult,
  SubStream,
} from './db.js';

export type { ProbeResult } from './db.js';

export class ProbeError extends Error {
  public readonly probeCause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProbeError';
    this.probeCause = cause;
  }
}

interface FfprobeDisposition {
  default?: number;
  forced?: number;
}

interface FfprobeTags {
  language?: string;
  title?: string;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  disposition?: FfprobeDisposition;
  tags?: FfprobeTags;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

interface FfprobeChapter {
  id?: number;
  time_base?: string;
  start?: number;
  start_time?: string;
  end?: number;
  end_time?: string;
  tags?: { title?: string };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  chapters?: FfprobeChapter[];
  format?: FfprobeFormat;
}

export interface ProbeDeps {
  spawn?: typeof spawn;
}

/** Subtitle codecs whose body is text — ffmpeg can convert to WebVTT cleanly. */
const TEXT_SUB_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
]);

function parseTimeBaseSeconds(
  ts: number | undefined,
  timeBase: string | undefined,
  fallback: string | undefined,
): number {
  if (typeof ts === 'number' && Number.isFinite(ts) && timeBase) {
    const m = /^(\d+)\/(\d+)$/.exec(timeBase);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (den > 0) return (ts * num) / den;
    }
  }
  if (fallback) {
    const f = Number(fallback);
    if (Number.isFinite(f)) return f;
  }
  return 0;
}

export async function probe(absPath: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const sp = deps.spawn ?? spawn;
  const child = sp(
    'ffprobe',
    [
      '-v', 'error',
      '-of', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      absPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new ProbeError(`ffprobe spawn failed: ${(e as Error).message}`, e)));
    child.on('close', (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    throw new ProbeError(`ffprobe exited ${exitCode}: ${err.trim() || '(no stderr)'}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(out) as FfprobeOutput;
  } catch (e) {
    throw new ProbeError(`ffprobe produced invalid JSON: ${(e as Error).message}`, e);
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const firstAudio = streams.find((s) => s.codec_type === 'audio');
  const container = parsed.format?.format_name ?? '';
  const durationSeconds = Number(parsed.format?.duration ?? 0) || 0;

  // Walk audio + subtitle streams while tracking per-codec-type local indices.
  // ffmpeg's `-map 0:a:N` uses the local-within-audio index, not the global one,
  // and the two diverge when stream order isn't canonical (e.g. video, sub,
  // audio, audio).
  const audioStreams: AudioStream[] = [];
  const subStreams: SubStream[] = [];
  let audioLocal = 0;
  let subLocal = 0;
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      audioStreams.push({
        index: typeof s.index === 'number' ? s.index : audioLocal,
        audioIndex: audioLocal,
        codec: s.codec_name ?? '',
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
        channels: typeof s.channels === 'number' ? s.channels : 0,
        default: s.disposition?.default === 1,
        forced: s.disposition?.forced === 1,
      });
      audioLocal++;
    } else if (s.codec_type === 'subtitle') {
      const codec = s.codec_name ?? '';
      subStreams.push({
        index: typeof s.index === 'number' ? s.index : subLocal,
        subIndex: subLocal,
        codec,
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
        default: s.disposition?.default === 1,
        forced: s.disposition?.forced === 1,
        textBased: TEXT_SUB_CODECS.has(codec),
      });
      subLocal++;
    }
  }

  const chapters: Chapter[] = (parsed.chapters ?? []).map((c, i) => ({
    index: i,
    startSeconds: parseTimeBaseSeconds(c.start, c.time_base, c.start_time),
    endSeconds: parseTimeBaseSeconds(c.end, c.time_base, c.end_time),
    title: c.tags?.title ?? null,
  }));

  return {
    container,
    videoCodec: video?.codec_name ?? '',
    audioCodec: firstAudio?.codec_name ?? '',
    durationSeconds,
    audioStreams,
    subStreams,
    chapters,
  };
}
