import { describe, it, expect, vi } from 'vitest';
import { computeScrollTarget, snapToAnchor } from '../src/components/strip-scroll.js';

/** Build a fake scrollEl with scriptable scroll/client/scrollWidth dimensions. */
function makeScroll(opts: {
  clientWidth: number;
  scrollWidth: number;
  scrollLeft?: number;
  hasScrollTo?: boolean;
}): HTMLElement & { _scrollToCalls: Array<{ left: number; behavior?: string }> } {
  const calls: Array<{ left: number; behavior?: string }> = [];
  const el = {
    clientWidth: opts.clientWidth,
    scrollWidth: opts.scrollWidth,
    scrollLeft: opts.scrollLeft ?? 0,
    _scrollToCalls: calls,
  } as unknown as HTMLElement & { _scrollToCalls: typeof calls };
  if (opts.hasScrollTo !== false) {
    (el as unknown as { scrollTo: (o: { left: number; behavior?: string }) => void }).scrollTo = (o): void => {
      calls.push(o);
      (el as unknown as { scrollLeft: number }).scrollLeft = o.left;
    };
  }
  return el;
}

function makeAnchor(offsetLeft: number, offsetWidth: number): HTMLElement {
  return { offsetLeft, offsetWidth } as unknown as HTMLElement;
}

describe('computeScrollTarget', () => {
  it('left-align places anchor at the left edge of viewport', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(800, 100);
    expect(computeScrollTarget(scroll, anchor, 'left')).toBe(800);
  });

  it('center-align centers the anchor in the viewport', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(800, 100);
    // anchor center = 850; want it at 200 (half of viewport) → scrollLeft = 650
    expect(computeScrollTarget(scroll, anchor, 'center')).toBe(650);
  });

  it('clamps negative target to 0 (anchor near the start)', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(50, 100);
    // center target = 100 - 200 = -100 → clamps to 0
    expect(computeScrollTarget(scroll, anchor, 'center')).toBe(0);
  });

  it('clamps target to scrollWidth - clientWidth (anchor near the end)', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(1900, 100);
    // left target = 1900; max = 1600 → clamps to 1600
    expect(computeScrollTarget(scroll, anchor, 'left')).toBe(1600);
  });

  it('returns 0 when content fits entirely (no scrollable range)', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 300 });
    const anchor = makeAnchor(50, 50);
    expect(computeScrollTarget(scroll, anchor, 'left')).toBe(0);
  });
});

describe('snapToAnchor', () => {
  it('null anchor → scroll to 0 (instant when smooth is false)', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000, scrollLeft: 500 });
    snapToAnchor(scroll, null, 'left', false);
    expect(scroll.scrollLeft).toBe(0);
    expect(scroll._scrollToCalls).toHaveLength(0);
  });

  it('null anchor + smooth → uses scrollTo with smooth behavior', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000, scrollLeft: 500 });
    snapToAnchor(scroll, null, 'left', true);
    expect(scroll._scrollToCalls).toEqual([{ left: 0, behavior: 'smooth' }]);
  });

  it('anchor + smooth=false → sets scrollLeft directly', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(800, 100);
    snapToAnchor(scroll, anchor, 'left', false);
    expect(scroll.scrollLeft).toBe(800);
    expect(scroll._scrollToCalls).toHaveLength(0);
  });

  it('anchor + smooth=true → uses scrollTo with smooth behavior', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000 });
    const anchor = makeAnchor(800, 100);
    snapToAnchor(scroll, anchor, 'center', true);
    // center target = 850 - 200 = 650
    expect(scroll._scrollToCalls).toEqual([{ left: 650, behavior: 'smooth' }]);
  });

  it('falls back to direct assign when scrollTo is missing', () => {
    const scroll = makeScroll({ clientWidth: 400, scrollWidth: 2000, hasScrollTo: false });
    const anchor = makeAnchor(800, 100);
    snapToAnchor(scroll, anchor, 'left', true);
    expect(scroll.scrollLeft).toBe(800);
  });
});

// Fail fast if computeScrollTarget gets renamed without updating tests
describe('exports', () => {
  it('module exports the documented surface', () => {
    expect(typeof computeScrollTarget).toBe('function');
    expect(typeof snapToAnchor).toBe('function');
    // Silence vi unused warning
    vi.fn();
  });
});
