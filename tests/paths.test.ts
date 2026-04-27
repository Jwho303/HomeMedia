import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { toPosixRelative, toNativeAbsolute } from '../src/paths.js';

const isWindows = process.platform === 'win32';

describe('paths', () => {
  it('toPosixRelative produces forward slashes on host platform', () => {
    if (isWindows) {
      const rel = toPosixRelative('D:\\TestMedia\\The Bear\\S01E01.mkv', 'D:\\TestMedia');
      expect(rel).toBe('The Bear/S01E01.mkv');
      expect(rel).not.toContain('\\');
    } else {
      const rel = toPosixRelative('/Volumes/media/The Bear/S01E01.mkv', '/Volumes/media');
      expect(rel).toBe('The Bear/S01E01.mkv');
    }
  });

  it('toPosixRelative handles top-level files', () => {
    const root = isWindows ? 'D:\\TestMedia' : '/Volumes/media';
    const file = path.join(root, 'Dune.2021.mkv');
    expect(toPosixRelative(file, root)).toBe('Dune.2021.mkv');
  });

  it('toPosixRelative handles deep nesting', () => {
    const root = isWindows ? 'D:\\TestMedia' : '/Volumes/media';
    const file = path.join(root, 'A', 'B', 'C', 'file.mkv');
    expect(toPosixRelative(file, root)).toBe('A/B/C/file.mkv');
  });

  it('toNativeAbsolute uses native separators', () => {
    const root = isWindows ? 'D:\\TestMedia' : '/Volumes/media';
    const native = toNativeAbsolute('The Bear/S01E01.mkv', root);
    expect(native).toBe(path.join(root, 'The Bear', 'S01E01.mkv'));
  });

  it('round-trips: native -> posix -> native', () => {
    const root = isWindows ? 'D:\\TestMedia' : '/Volumes/media';
    const original = path.join(root, 'A', 'B', 'file.mkv');
    const rel = toPosixRelative(original, root);
    const back = toNativeAbsolute(rel, root);
    expect(back).toBe(original);
  });
});
