import { describe, it, expect } from 'vitest';
import { SkipTracker, skipTarget, windowAt, type SkipMarkers } from '../src/skip-logic.js';

const M: SkipMarkers = { introStart: 60, introEnd: 150, creditsStart: 1290, creditsEnd: 1335 };
const OFF = { autoIntro: false, autoCredits: false };
const ON = { autoIntro: true, autoCredits: true };

/** Play naturally from `from` to `to` in 0.25 s ticks, returning every view. */
function play(t: SkipTracker, from: number, to: number) {
  const views = [];
  for (let x = from; x <= to; x += 0.25) views.push(t.update(x));
  return views;
}

describe('windowAt', () => {
  it('finds intro and credits windows', () => {
    expect(windowAt(M, 59)).toBeNull();
    expect(windowAt(M, 60)).toBe('intro');
    expect(windowAt(M, 148)).toBe('intro');
    expect(windowAt(M, 149.5)).toBeNull(); // last second: nothing left to skip
    expect(windowAt(M, 1300)).toBe('credits');
    expect(windowAt(null, 100)).toBeNull();
  });
  it('ignores a missing window', () => {
    expect(windowAt({ ...M, introStart: null, introEnd: null }, 100)).toBeNull();
  });
});

describe('skipTarget', () => {
  it('skips the intro to its end', () => {
    expect(skipTarget(M, 'intro', 1400)).toBe(150);
  });
  it('lands at the end of the credits theme so a post-credit scene still plays', () => {
    expect(skipTarget(M, 'credits', 1400)).toBe(1335);
  });
  it('becomes Next Episode when (almost) nothing follows the credits', () => {
    expect(skipTarget(M, 'credits', 1340)).toBe('next');
  });
});

describe('SkipTracker', () => {
  it('auto-skip off: shows the button inside the window only, never auto-starts', () => {
    const t = new SkipTracker(M, OFF);
    expect(t.update(50).showButton).toBe(false);
    const views = play(t, 55, 70);
    expect(views.some((v) => v.showButton && v.kind === 'intro')).toBe(true);
    expect(views.some((v) => v.startAuto)).toBe(false);
  });

  it('auto-skip on: starts the countdown once when playback runs into the window', () => {
    const t = new SkipTracker(M, ON);
    const views = play(t, 55, 70);
    expect(views.filter((v) => v.startAuto)).toHaveLength(1);
  });

  it('starting or resuming inside the window auto-skips', () => {
    const t = new SkipTracker(M, ON);
    expect(t.update(100).startAuto).toBe(true);
  });

  it('scrubbing into the window auto-skips too', () => {
    const t = new SkipTracker(M, ON);
    play(t, 10, 11);
    expect(t.update(100).startAuto).toBe(true);
    expect(t.update(1300).startAuto).toBe(true);
  });

  it('scrubbing back into an already-skipped intro starts the countdown again', () => {
    const t = new SkipTracker(M, ON);
    expect(play(t, 55, 70).filter((v) => v.startAuto)).toHaveLength(1);
    play(t, 200, 202);
    expect(t.update(100).startAuto).toBe(true);
  });

  it('Watch cancels auto-skip for that window for the rest of the episode', () => {
    const t = new SkipTracker(M, ON);
    expect(t.update(60.1).startAuto).toBe(true);
    t.cancelAuto('intro');
    play(t, 10, 11);
    expect(play(t, 55, 70).some((v) => v.startAuto)).toBe(false);
    // Credits still auto-skip.
    expect(play(t, 1285, 1295).some((v) => v.startAuto)).toBe(true);
  });

  it('auto-skip only applies to the kinds turned on', () => {
    const t = new SkipTracker(M, { autoIntro: false, autoCredits: true });
    expect(play(t, 55, 70).some((v) => v.startAuto)).toBe(false);
    expect(play(t, 1285, 1295).some((v) => v.startAuto)).toBe(true);
  });

  it('no markers: nothing to show', () => {
    const t = new SkipTracker(null, ON);
    expect(t.update(100)).toEqual({ kind: null, showButton: false, startAuto: false });
  });
});
