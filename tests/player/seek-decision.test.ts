import { describe, it, expect } from 'vitest';
import { decideAction } from '../../src/player/seek-decision.js';

describe('decideAction', () => {
  it('reuses when target is inside the window and session is running', () => {
    const r = decideAction({
      targetSeconds: 120,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'running',
    });
    expect(r.mode).toBe('reuse');
    expect(r.localSeconds).toBe(60);
  });

  it('respawns when target is past the encoded head', () => {
    const r = decideAction({
      targetSeconds: 600,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'running',
    });
    expect(r.mode).toBe('respawn');
    expect(r.localSeconds).toBeUndefined();
  });

  it('respawns when target is before the encoded foot', () => {
    const r = decideAction({
      targetSeconds: 30,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'running',
    });
    expect(r.mode).toBe('respawn');
  });

  it('respawns when session is gone, even if target is in-window', () => {
    const r = decideAction({
      targetSeconds: 120,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'gone',
    });
    expect(r.mode).toBe('respawn');
  });

  it('respawns when there is no encoded window yet', () => {
    const r = decideAction({
      targetSeconds: 0,
      encodedWindow: null,
      sessionState: 'running',
    });
    expect(r.mode).toBe('respawn');
  });

  it('reuses with localSeconds=0 at the foot of the window', () => {
    const r = decideAction({
      targetSeconds: 60,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'running',
    });
    expect(r.mode).toBe('reuse');
    expect(r.localSeconds).toBe(0);
  });

  it('reuses at the head of the window', () => {
    const r = decideAction({
      targetSeconds: 180,
      encodedWindow: { from: 60, to: 180 },
      sessionState: 'running',
    });
    expect(r.mode).toBe('reuse');
    expect(r.localSeconds).toBe(120);
  });
});
