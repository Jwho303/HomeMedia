import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyScanEvent,
  clearScanProgress,
  getScanProgress,
  startJob,
  subscribeScanProgress,
  _resetForTests,
} from '../src/scan-progress-store.js';

describe('scan-progress-store', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('starts inactive with zero counters', () => {
    const s = getScanProgress();
    expect(s.active).toBe(false);
    expect(s.i).toBe(0);
    expect(s.n).toBe(0);
  });

  it('startJob marks active and sets jobId', () => {
    startJob('job-abc');
    const s = getScanProgress();
    expect(s.active).toBe(true);
    expect(s.jobId).toBe('job-abc');
  });

  it('file event updates counter and current file with identify phase', () => {
    startJob('job-x');
    applyScanEvent({ type: 'file', i: 3, n: 10, path: 'a/b.mkv', phase: 'identify' });
    const s = getScanProgress();
    expect(s.i).toBe(3);
    expect(s.n).toBe(10);
    expect(s.currentFile).toBe('a/b.mkv');
    expect(s.phase).toBe('identify');
  });

  it('probe event sets phase to probe', () => {
    startJob('job-y');
    applyScanEvent({ type: 'probe', i: 1, n: 5, path: 'x.mkv', status: 'reprobed' });
    const s = getScanProgress();
    expect(s.phase).toBe('probe');
    expect(s.currentFile).toBe('x.mkv');
  });

  it('done event transitions to inactive and stores result', () => {
    startJob('job-z');
    applyScanEvent({ type: 'file', i: 5, n: 5, path: 'last.mkv', phase: 'identify' });
    applyScanEvent({ type: 'done', result: { added: 5 } });
    const s = getScanProgress();
    expect(s.active).toBe(false);
    expect(s.result).toEqual({ added: 5 });
    expect(s.currentFile).toBeNull();
  });

  it('error event sets errorMessage and inactive', () => {
    startJob('job-err');
    applyScanEvent({ type: 'error', message: 'boom' });
    const s = getScanProgress();
    expect(s.active).toBe(false);
    expect(s.errorMessage).toBe('boom');
  });

  it('subscribers fire on each event', () => {
    const seen: string[] = [];
    subscribeScanProgress((s) => seen.push(s.currentFile ?? ''));
    startJob('j');
    applyScanEvent({ type: 'file', i: 1, n: 2, path: 'a.mkv', phase: 'identify' });
    applyScanEvent({ type: 'file', i: 2, n: 2, path: 'b.mkv', phase: 'identify' });
    expect(seen).toEqual(['', 'a.mkv', 'b.mkv']);
  });

  it('clearScanProgress resets to initial state', () => {
    startJob('j');
    applyScanEvent({ type: 'file', i: 1, n: 1, path: 'x.mkv', phase: 'identify' });
    clearScanProgress();
    const s = getScanProgress();
    expect(s.active).toBe(false);
    expect(s.currentFile).toBeNull();
    expect(s.jobId).toBeNull();
  });

  it('diff event seeds n', () => {
    startJob('j');
    applyScanEvent({ type: 'diff', dirty: 4, disappeared: 1, total: 100 });
    expect(getScanProgress().n).toBe(100);
  });
});
