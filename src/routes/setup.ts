/**
 * Setup-state route (0.1.13 — FTUE onboarding).
 *
 * A single endpoint the frontend polls on boot to decide whether to show the
 * first-time-user wizard. It must:
 *   - never throw on missing config (a fresh clone boots in "needs setup" mode);
 *   - never leak a raw API key value (only presence + configured paths).
 *
 * `configured && libraryBuilt` → no wizard. Anything else → the frontend enters
 * the wizard at the first unsatisfied step. `activeJobId` lets a mid-build
 * reload reconnect to the running scan instead of starting a second one.
 *
 * Reuses the existing config layer (`isConfigured`), the scan history
 * (`db.latestRunAt`), and the in-process scan lock (`currentJobId`). No new
 * scan machinery — the wizard drives `POST /api/refresh` directly.
 */

import type { FastifyInstance } from 'fastify';
import { config, isConfigured } from '../config.js';
import { getDb } from '../db.js';
import { currentJobId } from '../scan-lock.js';

export interface SetupState {
  /** TMDB key set AND a media folder set. */
  configured: boolean;
  /** Required TMDB key present. */
  tmdbReady: boolean;
  /** Configured media paths (values OK — these are paths, not secrets). */
  mediaFolders: string[];
  /** A scan has completed successfully (`latestRunAt() > 0`). */
  libraryBuilt: boolean;
  /** Alive media_items count. */
  itemCount: number;
  /** Job id of a scan currently running, so a mid-build reload reattaches. */
  activeJobId: string | null;
}

/** Count alive library items without throwing if the DB can't open yet. */
function aliveItemCount(): number {
  try {
    const row = getDb().raw
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM media_items WHERE deleted_at IS NULL`,
      )
      .get();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function latestRunAtSafe(): number {
  try {
    return getDb().latestRunAt();
  } catch {
    return 0;
  }
}

export function setupState(): SetupState {
  const tmdbReady = config.tmdbApiKey.length > 0;
  const mediaFolders = config.mediaRoot ? [config.mediaRoot] : [];
  const itemCount = aliveItemCount();
  const libraryBuilt = latestRunAtSafe() > 0;
  return {
    configured: isConfigured(),
    tmdbReady,
    mediaFolders,
    libraryBuilt,
    itemCount,
    activeJobId: currentJobId(),
  };
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup-state', async () => setupState());
}
