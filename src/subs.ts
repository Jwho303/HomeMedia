import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { toNativeAbsolute, toPosixRelative } from './paths.js';

export interface SubInfo {
  /** POSIX-relative path to the subtitle file under MEDIA_ROOT. */
  path: string;
  /** Best-effort language code parsed from the filename (`Foo.en.srt` → `en`); `null` when none. */
  lang: string | null;
  /** Lowercased extension without the dot: `srt` | `vtt`. */
  ext: 'srt' | 'vtt';
}

const SUB_EXTS: ReadonlyArray<'vtt' | 'srt'> = ['vtt', 'srt'];

/**
 * Discover sibling subtitle files for a given media path. Exact-stem only:
 * `Foo/Bar.mkv` matches `Foo/Bar.srt`, `Foo/Bar.vtt`, `Foo/Bar.<lang>.srt`,
 * `Foo/Bar.<lang>.vtt`. No fuzzy matching, no recursion.
 *
 * Sort order: `.vtt` before `.srt`, then by name. The first entry is the one the
 * frontend marks `default`.
 */
export async function discoverSubs(mediaRelPosix: string, root: string = config.mediaRoot): Promise<SubInfo[]> {
  const absMedia = toNativeAbsolute(mediaRelPosix, root);
  const dir = path.dirname(absMedia);
  const stem = path.basename(absMedia, path.extname(absMedia));

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const matches: SubInfo[] = [];
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase().slice(1);
    if (ext !== 'srt' && ext !== 'vtt') continue;

    const stemless = entry.slice(0, entry.length - (ext.length + 1));
    let lang: string | null = null;
    if (stemless === stem) {
      lang = null;
    } else if (stemless.startsWith(stem + '.')) {
      const tail = stemless.slice(stem.length + 1);
      // Language tag must be a single non-dotted token (e.g. `en`, `en-US`, `pt-BR`).
      // Anything with further dots indicates a different file (e.g. `Foo.bak.srt`).
      if (!tail.includes('.')) {
        lang = tail || null;
      } else {
        continue;
      }
    } else {
      continue;
    }

    const absSub = path.join(dir, entry);
    matches.push({
      path: toPosixRelative(absSub, root),
      lang,
      ext: ext as 'srt' | 'vtt',
    });
  }

  matches.sort((a, b) => {
    if (a.ext !== b.ext) return a.ext === 'vtt' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return matches;
}

/**
 * Convert SRT subtitle text to WebVTT. Handles the two real differences:
 * `WEBVTT` header and the `,` → `.` millisecond separator inside cue timestamps.
 * Pure string transform; no I/O.
 */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip an optional UTF-8 BOM.
  const stripped = normalized.charCodeAt(0) === 0xfeff ? normalized.slice(1) : normalized;
  // Replace `HH:MM:SS,mmm` with `HH:MM:SS.mmm` only inside lines that look like timestamps.
  const fixed = stripped.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2',
  );
  return `WEBVTT\n\n${fixed.replace(/^\s+/, '')}`;
}
