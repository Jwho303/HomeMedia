/**
 * 0.1.10 — scan_runs table lifecycle, orphan sweep, latestRunAt semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

process.env.TMDB_API_KEY ??= 'test-key';
process.env.MEDIA_ROOT ??= path.join(os.tmpdir(), 'homemedia-scan-runs-default');

const { openDb } = await import('../src/db.js');

describe('scan_runs lifecycle', () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('openScanRun creates a status="running" row', () => {
    const runId = db.openScanRun('smart');
    const row = db.getScanRun(runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('running');
    expect(row!.mode).toBe('smart');
    expect(row!.started_at).toBeGreaterThan(0);
    expect(row!.finished_at).toBeNull();
  });

  it('closeScanRunOk transitions to ok with counts', () => {
    const runId = db.openScanRun('smart');
    db.closeScanRunOk(runId, {
      filesWalked: 10,
      filesDirty: 2,
      filesDisappeared: 1,
      filesResurrected: 0,
    });
    const row = db.getScanRun(runId);
    expect(row!.status).toBe('ok');
    expect(row!.finished_at).toBeGreaterThan(0);
    expect(row!.files_walked).toBe(10);
    expect(row!.files_disappeared).toBe(1);
    expect(row!.files_resurrected).toBe(0);
  });

  it('closeScanRunError transitions to error with message', () => {
    const runId = db.openScanRun('hard');
    db.closeScanRunError(runId, 'boom');
    const row = db.getScanRun(runId);
    expect(row!.status).toBe('error');
    expect(row!.error_message).toBe('boom');
    expect(row!.finished_at).toBeGreaterThan(0);
  });

  it('latestRunAt returns 0 when no scans have run', () => {
    expect(db.latestRunAt()).toBe(0);
  });

  it('latestRunAt only considers status=ok rows', () => {
    const runA = db.openScanRun('smart');
    db.closeScanRunOk(runA, { filesWalked: 1 });
    const finishedA = db.getScanRun(runA)!.finished_at!;

    // An error run after the ok run does not advance latestRunAt.
    const runB = db.openScanRun('smart');
    db.closeScanRunError(runB, 'oops');
    expect(db.latestRunAt()).toBe(finishedA);

    // A second ok run advances it.
    const runC = db.openScanRun('smart');
    db.closeScanRunOk(runC, { filesWalked: 1 });
    const finishedC = db.getScanRun(runC)!.finished_at!;
    expect(db.latestRunAt()).toBe(finishedC);
  });

  it('orphan running rows are swept to status=error on next DB open', () => {
    // Persistent file DB so we can re-open.
    const tmp = path.join(os.tmpdir(), `homemedia-scanruns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const a = openDb(tmp);
    const runId = a.openScanRun('smart');
    expect(a.getScanRun(runId)!.status).toBe('running');
    a.close();

    const b = openDb(tmp);
    const after = b.getScanRun(runId);
    expect(after!.status).toBe('error');
    expect(after!.error_message).toBe('server_restart');
    expect(after!.finished_at).not.toBeNull();
    b.close();
  });

  it('scan_runs.id auto-increments per call', () => {
    const a = db.openScanRun('smart');
    const b = db.openScanRun('smart');
    const c = db.openScanRun('smart');
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
