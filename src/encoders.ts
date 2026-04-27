import { spawn } from 'node:child_process';

export interface EncoderCapabilities {
  /** ffmpeg ships an `h264_nvenc` encoder (NVIDIA hardware H.264 encode). */
  nvenc: boolean;
  /** ffmpeg ships `h264_qsv` (Intel QuickSync H.264 encode). */
  qsv: boolean;
  /** ffmpeg ships `h264_videotoolbox` (Apple Mac/iOS H.264 encode). */
  videotoolbox: boolean;
}

let cached: EncoderCapabilities | null = null;

/**
 * Run `ffmpeg -encoders` once and parse out the hardware H.264 encoders we care
 * about. Result is cached for the process lifetime — encoders don't appear and
 * disappear at runtime. Returns `{ nvenc:false, qsv:false, videotoolbox:false }`
 * when ffmpeg is missing or errors; the caller is expected to fall back to the
 * external-player path in that case.
 */
export async function detectEncoders(): Promise<EncoderCapabilities> {
  if (cached) return cached;

  const result = await new Promise<EncoderCapabilities>((resolve) => {
    const empty: EncoderCapabilities = { nvenc: false, qsv: false, videotoolbox: false };
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(empty);
      return;
    }
    let out = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.on('error', () => resolve(empty));
    child.on('close', () => {
      resolve({
        nvenc: /\bh264_nvenc\b/.test(out),
        qsv: /\bh264_qsv\b/.test(out),
        videotoolbox: /\bh264_videotoolbox\b/.test(out),
      });
    });
  });

  cached = result;
  return result;
}

export function getCachedEncoders(): EncoderCapabilities | null {
  return cached;
}

/** For tests. */
export function setCachedEncodersForTests(caps: EncoderCapabilities | null): void {
  cached = caps;
}
