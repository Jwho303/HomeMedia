import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { config } from './config.js';

export class ShareOfflineError extends Error {
  constructor(public readonly mountPath: string) {
    super(`Share offline: ${mountPath}`);
    this.name = 'ShareOfflineError';
  }
}

export interface ShareStatus {
  online: boolean;
  mountPath: string;
  lastSeen: number | null;
}

let lastSeen: number | null = null;

export async function status(mountPath: string = config.mediaRoot): Promise<ShareStatus> {
  try {
    await fs.access(mountPath);
    // Cheap readability check — ENOENT or EACCES will throw.
    const dir = await fs.opendir(mountPath);
    await dir.close();
    lastSeen = Date.now();
    return { online: true, mountPath, lastSeen };
  } catch {
    return { online: false, mountPath, lastSeen };
  }
}

export interface SpawnLike {
  (cmd: string, args: readonly string[], opts: { timeoutMs: number }): Promise<{ exitCode: number }>;
}

const defaultSpawn: SpawnLike = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: 'ignore' });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ exitCode: -1 });
      }
    }, opts.timeoutMs);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1 });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1 });
    });
  });

export interface ReconnectDeps {
  spawn?: SpawnLike;
  platform?: () => NodeJS.Platform;
  smbHost?: string | null;
  smbShare?: string | null;
  mountPath?: string;
}

export async function reconnect(deps: ReconnectDeps = {}): Promise<ShareStatus> {
  const plat = (deps.platform ?? platform)();
  const mountPath = deps.mountPath ?? config.mediaRoot;
  if (plat === 'darwin') {
    const host = deps.smbHost ?? config.smbHost;
    const share = deps.smbShare ?? config.smbShare;
    if (host && share) {
      const sp = deps.spawn ?? defaultSpawn;
      // Treat any non-zero exit as "reconnect attempted, status unknown" — the
      // immediately-following status() call is the source of truth.
      await sp('osascript', ['-e', `mount volume "smb://${host}/${share}"`], { timeoutMs: 10_000 });
    }
  }
  // Windows / Linux dev: nothing to do — re-checking status is the whole job.
  return status(mountPath);
}
