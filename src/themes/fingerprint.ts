/**
 * Audio fingerprint capture through ffmpeg's built-in chromaprint muxer (0.2.1).
 *
 * Decodes only the audio stream, downmixed to mono at 11025 Hz, for one window
 * at the start or end of a file. Never throws for "no audio" or "no muxer":
 * returns null so callers can record the attempt and move on.
 */

import { spawn } from 'node:child_process';
import { decodeRaw } from './match.js';

export type SpawnFn = typeof spawn;

let muxerSupport: Promise<boolean> | null = null;

/** Whether this ffmpeg build has the chromaprint muxer. Checked once per process. */
export function hasChromaprint(spawnFn: SpawnFn = spawn): Promise<boolean> {
  if (!muxerSupport) {
    muxerSupport = new Promise((resolve) => {
      let out = '';
      try {
        const child = spawnFn('ffmpeg', ['-hide_banner', '-muxers'], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', () => resolve(false));
        child.on('close', () => resolve(/\bchromaprint\b/.test(out)));
      } catch {
        resolve(false);
      }
    });
  }
  return muxerSupport;
}

export function resetChromaprintCacheForTests(): void {
  muxerSupport = null;
}

export interface WindowSpec {
  /** Local audio index (ffmpeg `-map 0:a:N`). */
  audioIndex: number;
  /** Seconds from the file start where the window begins. */
  startS: number;
  durationS: number;
}

export function fingerprintArgs(absPath: string, w: WindowSpec): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (w.startS > 0) args.push('-ss', w.startS.toFixed(3));
  args.push(
    '-t', w.durationS.toFixed(3),
    '-i', absPath,
    '-map', `0:a:${w.audioIndex}`,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '11025',
    '-f', 'chromaprint', '-fp_format', 'raw',
    '-',
  );
  return args;
}

/** Fingerprint one window. Resolves null on any ffmpeg failure or empty output. */
export function fingerprintWindow(absPath: string, w: WindowSpec, spawnFn: SpawnFn = spawn): Promise<Uint32Array | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawnFn('ffmpeg', fingerprintArgs(absPath, w), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.stdout!.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', (code: number | null) => {
      if (code !== 0) return resolve(null);
      const fp = decodeRaw(Buffer.concat(chunks));
      resolve(fp.length > 0 ? fp : null);
    });
  });
}
