/**
 * Player instance + manager (0.1.9).
 *
 * The unit of state is a player instance — keyed by a UUID minted by the
 * client on `<media-player>` mount and carried on every request. Each
 * instance owns at most one ffmpeg session; switching audio / burn-in /
 * relPath retires the current session and spawns a new one.
 *
 * Sessions across instances are isolated: each player has its own cache
 * subtree at `<hls-cache-root>/<playerId>/<relPathHash>/<paramsHash>/`.
 *
 * Concurrency is enforced at /open via two ceilings (D9):
 *   - global  MAX_CONCURRENT_PLAYERS
 *   - per-id  MAX_PLAYERS_PER_IP
 *
 * Per-IP single-player default (D8): when MAX_PLAYERS_PER_IP === 1 and the
 * identity already has a live player, /open adopts it as a media-swap
 * rather than rejecting.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { type Identity, identityKey } from '../identity/resolver.js';
import {
  HlsSessionManager,
  type HlsSession,
  type CreateOptions as SessionCreateOptions,
  type HlsSpawn,
} from '../streaming/hls-session.js';
import type { PaceController } from './pace-controller.js';

export type CanOpenResult =
  | { kind: 'allowed' }
  | { kind: 'media-swap'; playerId: string }
  | { kind: 'global-busy'; limit: number; active: number }
  | { kind: 'identity-busy'; limit: number; active: number };

export interface PlayerInstance {
  playerId: string;
  identity: Identity;
  /** Stable identity key used in maps. */
  identityKey: string;
  relPath: string | null;
  /** Hash over (audioStreamIndex, burnSubStreamIndex). null when nothing
   *  is open or the session uses defaults. */
  paramsHash: string | null;
  activeSession: HlsSession | null;
  /** Per-instance cache root: `<hls-cache-root>/<playerId>/`. */
  cacheDir: string;
  /** Last absolute source-second the client reported via /seek or /state. */
  lastClientAbsolutePosition: number;
  /** Whether the client reported paused on the most recent /state. */
  paused: boolean;
  /** ms timestamp of the last /state or /seek ping. */
  lastPingAt: number;
  /** Pace controller (Phase 3); null until Phase 3 wires it. */
  pace: PaceController | null;
  createdAt: number;
}

interface ManagerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const noopLogger: ManagerLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface ManagerOptions {
  hlsSessionManager: HlsSessionManager;
  cacheRoot?: string;
  now?: () => number;
  logger?: ManagerLogger;
  maxConcurrentPlayers?: number;
  maxPlayersPerIp?: number;
  /** Idle GC interval in ms (default 60_000, 0 disables). */
  gcIntervalMs?: number;
  /** Idle threshold in ms (default config.playerIdleTimeoutSeconds). */
  idleMs?: number;
}

export interface OpenInput {
  playerId: string;
  identity: Identity;
  relPath: string;
  audioStreamIndex?: number;
  burnSubStreamIndex?: number;
  burnSubTextBased?: boolean;
  startSeconds?: number;
  spawn: () => Promise<HlsSession>;
}

export interface OpenResult {
  player: PlayerInstance;
  reused: boolean;
}

export function paramsHashOf(opts: {
  audioStreamIndex?: number | undefined;
  burnSubStreamIndex?: number | undefined;
}): string {
  const a = opts.audioStreamIndex ?? -1;
  const b = opts.burnSubStreamIndex ?? -1;
  return crypto.createHash('sha1').update(`a${a}|b${b}`).digest('hex').slice(0, 12);
}

export function relPathHashOf(relPath: string): string {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

export class PlayerInstanceManager {
  private readonly players = new Map<string, PlayerInstance>();
  /** identityKey → Set<playerId>. Lets us answer cap questions in O(1). */
  private readonly byIdentity = new Map<string, Set<string>>();
  private readonly hlsMgr: HlsSessionManager;
  private readonly cacheRoot: string;
  private readonly now: () => number;
  private readonly logger: ManagerLogger;
  private readonly maxGlobal: number;
  private readonly maxPerIdentity: number;
  private readonly idleMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ManagerOptions) {
    this.hlsMgr = opts.hlsSessionManager;
    this.cacheRoot = opts.cacheRoot ?? config.hlsCacheDir;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? noopLogger;
    this.maxGlobal = opts.maxConcurrentPlayers ?? config.maxConcurrentPlayers;
    this.maxPerIdentity = opts.maxPlayersPerIp ?? config.maxPlayersPerIp;
    this.idleMs = opts.idleMs ?? config.playerIdleTimeoutSeconds * 1000;
    const gcIntervalMs = opts.gcIntervalMs ?? 60_000;
    if (gcIntervalMs > 0) {
      this.gcTimer = setInterval(() => this.gcIdle(), gcIntervalMs);
      this.gcTimer.unref?.();
    }
  }

  /** Decide what to do with a fresh /open from this identity. */
  canOpen(identity: Identity): CanOpenResult {
    const key = identityKey(identity);
    const idSet = this.byIdentity.get(key);
    const idActive = idSet?.size ?? 0;
    // Per-identity check first — it's the common path under the default
    // MAX_PLAYERS_PER_IP=1 (D8 media-swap).
    if (idActive >= this.maxPerIdentity) {
      if (this.maxPerIdentity === 1 && idSet) {
        // Adopt the existing player (only one possible).
        const existing = idSet.values().next().value as string;
        return { kind: 'media-swap', playerId: existing };
      }
      return {
        kind: 'identity-busy',
        limit: this.maxPerIdentity,
        active: idActive,
      };
    }
    if (this.players.size >= this.maxGlobal) {
      return {
        kind: 'global-busy',
        limit: this.maxGlobal,
        active: this.players.size,
      };
    }
    return { kind: 'allowed' };
  }

  get(playerId: string): PlayerInstance | undefined {
    return this.players.get(playerId);
  }

  /** Look up a player owned by this identity. Used by the route layer to
   *  tell apart "you opened this" from "someone else owns this id". */
  ownedBy(playerId: string, identity: Identity): PlayerInstance | undefined {
    const p = this.players.get(playerId);
    if (!p) return undefined;
    if (p.identityKey !== identityKey(identity)) return undefined;
    return p;
  }

  liveCount(): number {
    return this.players.size;
  }

  countForIdentity(identity: Identity): number {
    return this.byIdentity.get(identityKey(identity))?.size ?? 0;
  }

  /** Open or media-swap. The caller (route handler) supplies a `spawn`
   *  callback that does the probe + session creation and returns the
   *  HlsSession; that side has access to the probe + library data we
   *  don't want to thread through this layer. */
  async open(input: OpenInput): Promise<OpenResult> {
    const idKey = identityKey(input.identity);
    const decision = this.canOpen(input.identity);
    let player: PlayerInstance;
    let reused = false;

    if (decision.kind === 'media-swap') {
      // Adopt existing player; retire its session if any.
      const existing = this.players.get(decision.playerId);
      if (!existing) {
        // Race: identity entry stale. Treat as fresh.
        player = await this.createPlayer(input.playerId, input.identity);
      } else {
        player = existing;
        reused = true;
        await this.retireSession(player);
        // Wipe the previous relPath's segment subtree (D5 retention rule).
        if (player.relPath && player.relPath !== input.relPath) {
          await this.wipeRelPath(player, player.relPath);
        }
      }
    } else if (decision.kind === 'allowed') {
      player = await this.createPlayer(input.playerId, input.identity);
    } else {
      const err = new CapacityExceededError(decision.kind, decision.limit, decision.active);
      throw err;
    }

    // If we're switching params on the SAME relPath, wipe the old params
    // hash (D5).
    const newParamsHash = paramsHashOf({
      audioStreamIndex: input.audioStreamIndex,
      burnSubStreamIndex: input.burnSubStreamIndex,
    });
    if (
      player.relPath === input.relPath &&
      player.paramsHash !== null &&
      player.paramsHash !== newParamsHash
    ) {
      await this.wipeParams(player, input.relPath, player.paramsHash);
    }

    const session = await input.spawn();
    player.relPath = input.relPath;
    player.paramsHash = newParamsHash;
    player.activeSession = session;
    player.lastPingAt = this.now();
    player.lastClientAbsolutePosition = input.startSeconds ?? 0;
    player.paused = false;

    this.logger.info(
      {
        evt: 'player.open',
        playerId: player.playerId,
        identity: idKey,
        relPath: input.relPath,
        sessionId: session.id,
        reused,
        paramsHash: newParamsHash,
      },
      'player opened',
    );

    return { player, reused };
  }

  /** Retire the active session (kills ffmpeg + drops its in-memory entry).
   *  Segments on disk are NOT removed here — retention is governed by the
   *  D5 rules (relPath swap, params change, close, idle). */
  async retireSession(player: PlayerInstance): Promise<void> {
    if (!player.activeSession) return;
    const sessionId = player.activeSession.id;
    player.pace?.dispose?.();
    player.pace = null;
    player.activeSession = null;
    await this.hlsMgr.delete(sessionId).catch(() => undefined);
  }

  /** Replace the active session. Used by /seek when a respawn is needed. */
  setActiveSession(player: PlayerInstance, session: HlsSession): void {
    player.activeSession = session;
  }

  /** Tear down the player completely. Kills any active session and wipes
   *  the entire <playerId>/ subtree. Idempotent. */
  async close(playerId: string): Promise<boolean> {
    const player = this.players.get(playerId);
    if (!player) return false;
    await this.retireSession(player);
    this.players.delete(playerId);
    const idSet = this.byIdentity.get(player.identityKey);
    if (idSet) {
      idSet.delete(playerId);
      if (idSet.size === 0) this.byIdentity.delete(player.identityKey);
    }
    try {
      await fs.rm(player.cacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    this.logger.info({ evt: 'player.close', playerId }, 'player closed');
    return true;
  }

  /** Update last-ping bookkeeping from /state or /seek. */
  recordPing(
    player: PlayerInstance,
    absolutePosition: number,
    paused: boolean,
  ): void {
    player.lastPingAt = this.now();
    player.lastClientAbsolutePosition = absolutePosition;
    player.paused = paused;
  }

  gcIdle(): void {
    const cutoff = this.now() - this.idleMs;
    const toClose: string[] = [];
    for (const p of this.players.values()) {
      if (p.lastPingAt < cutoff) toClose.push(p.playerId);
    }
    for (const id of toClose) {
      this.logger.warn(
        {
          evt: 'player.gc',
          playerId: id,
          idleThresholdMs: this.idleMs,
        },
        'player instance GCed (idle)',
      );
      void this.close(id);
    }
  }

  async shutdownAll(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    const ids = Array.from(this.players.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }

  /** Server-startup sweep — wipe every <playerId>/ dir under the cache
   *  root. Mirrors HlsSessionManager.cleanupOrphans for the new layout. */
  async cleanupOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await Promise.all(
      entries.map(async (name) => {
        const full = path.join(this.cacheRoot, name);
        try {
          const st = await fs.stat(full);
          if (!st.isDirectory()) return;
        } catch {
          return;
        }
        try {
          await fs.rm(full, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(
            { evt: 'player.orphanRmFailed', path: full, err },
            'failed to remove orphan player cache dir',
          );
        }
      }),
    );
  }

  /** Path resolver for the segment cache subtree. Phase 3 wires the HLS
   *  session to write into this path. */
  paramsCacheDir(playerId: string, relPath: string, paramsHash: string): string {
    return path.join(
      this.cacheRoot,
      playerId,
      relPathHashOf(relPath),
      paramsHash,
    );
  }

  private async createPlayer(playerId: string, identity: Identity): Promise<PlayerInstance> {
    const idKey = identityKey(identity);
    const cacheDir = path.join(this.cacheRoot, playerId);
    await fs.mkdir(cacheDir, { recursive: true });
    const player: PlayerInstance = {
      playerId,
      identity,
      identityKey: idKey,
      relPath: null,
      paramsHash: null,
      activeSession: null,
      cacheDir,
      lastClientAbsolutePosition: 0,
      paused: false,
      lastPingAt: this.now(),
      pace: null,
      createdAt: this.now(),
    };
    this.players.set(playerId, player);
    let idSet = this.byIdentity.get(idKey);
    if (!idSet) {
      idSet = new Set();
      this.byIdentity.set(idKey, idSet);
    }
    idSet.add(playerId);
    return player;
  }

  private async wipeRelPath(player: PlayerInstance, relPath: string): Promise<void> {
    const dir = path.join(player.cacheDir, relPathHashOf(relPath));
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  private async wipeParams(
    player: PlayerInstance,
    relPath: string,
    paramsHash: string,
  ): Promise<void> {
    const dir = this.paramsCacheDir(player.playerId, relPath, paramsHash);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export class CapacityExceededError extends Error {
  constructor(
    public readonly kind: 'global-busy' | 'identity-busy',
    public readonly limit: number,
    public readonly active: number,
  ) {
    super(`capacity_exceeded: ${kind}`);
    this.name = 'CapacityExceededError';
  }
}

let singleton: PlayerInstanceManager | null = null;

export function getPlayerInstanceManager(opts?: ManagerOptions): PlayerInstanceManager {
  if (!singleton) {
    if (!opts) {
      throw new Error('getPlayerInstanceManager() needs options on first call');
    }
    singleton = new PlayerInstanceManager(opts);
  }
  return singleton;
}

export function setPlayerInstanceManagerForTests(mgr: PlayerInstanceManager | null): void {
  singleton = mgr;
}

export type { HlsSpawn };
