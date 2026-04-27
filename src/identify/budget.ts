import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface BudgetTracker {
  /** Returns true if a request can proceed; false if the daily budget is exhausted. */
  allow(): boolean;
  /** Record a successful request against the budget. */
  consume(): void;
  /** Current count for today (for diagnostics). */
  count(): number;
  /** Soft-limit (90% of `dailyLimit` by default) — exposed for tests. */
  readonly limit: number;
}

interface BudgetFile {
  date: string;   // YYYY-MM-DD (UTC)
  count: number;
}

function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * File-backed daily-budget tracker. Resets the counter when the date rolls over.
 * `dailyLimit` is the source's hard daily quota (e.g. 1000 for OMDb free tier);
 * we soft-cap at 90% to leave headroom for in-flight retries.
 */
export function createBudgetTracker(filePath: string, dailyLimit: number): BudgetTracker {
  const limit = Math.floor(dailyLimit * 0.9);
  let state: BudgetFile = { date: todayUtc(), count: 0 };

  function load(): void {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as BudgetFile;
      if (parsed && typeof parsed.date === 'string' && typeof parsed.count === 'number') {
        state = parsed;
      }
    } catch {
      // Missing or corrupt file → start fresh.
    }
    rolloverIfNeeded();
  }

  function rolloverIfNeeded(): void {
    const today = todayUtc();
    if (state.date !== today) {
      state = { date: today, count: 0 };
    }
  }

  function persist(): void {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(state));
    } catch {
      // Best-effort; budget is advisory.
    }
  }

  load();

  return {
    limit,
    allow(): boolean {
      rolloverIfNeeded();
      return state.count < limit;
    },
    consume(): void {
      rolloverIfNeeded();
      state.count++;
      persist();
    },
    count(): number {
      rolloverIfNeeded();
      return state.count;
    },
  };
}

/** In-memory tracker for tests (no disk). */
export function createMemoryBudgetTracker(dailyLimit: number): BudgetTracker {
  const limit = Math.floor(dailyLimit * 0.9);
  let count = 0;
  return {
    limit,
    allow: () => count < limit,
    consume: () => { count++; },
    count: () => count,
  };
}
