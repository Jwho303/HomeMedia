import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from './config.js';

export function toPosixRelative(absPath: string, root: string): string {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join('/');
}

export function toNativeAbsolute(relPosix: string, root: string): string {
  return path.join(root, ...relPosix.split('/'));
}

export class BadPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadPathError';
  }
}

/**
 * Resolve a user-supplied POSIX-relative path under MEDIA_ROOT and verify the realpath
 * stays inside the root. Throws `BadPathError` on traversal attempts. Throws ENOENT (from
 * fs.realpath) when the file simply doesn't exist — callers map that to 404.
 */
export async function resolveStreamPath(relPosix: string, root: string = config.mediaRoot): Promise<string> {
  if (!relPosix || relPosix.includes('\0')) {
    throw new BadPathError('empty or null-byte path');
  }
  const absRequested = toNativeAbsolute(relPosix, root);
  const rootReal = await fs.realpath(root);
  const absReal = await fs.realpath(absRequested);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (absReal !== rootReal && !absReal.startsWith(rootWithSep)) {
    throw new BadPathError(`path escapes media root: ${relPosix}`);
  }
  return absReal;
}
