import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { forceBasicPlayer, forceModernPlayer } from '../src/nav/basic-player.js';

/**
 * 0.2.0 (D9) — the Basic Player escape hatch. Prefers window.__hm.force()
 * (set by the boot router) and falls back to a ?platform= reload otherwise.
 */
describe('forceBasicPlayer / forceModernPlayer', () => {
  beforeEach(() => {
    delete (window as unknown as { __hm?: unknown }).__hm;
  });
  afterEach(() => vi.restoreAllMocks());

  it('delegates to window.__hm.force("legacy") when present', () => {
    const force = vi.fn();
    (window as unknown as { __hm: { force: (b: string) => void } }).__hm = { force };
    forceBasicPlayer();
    expect(force).toHaveBeenCalledWith('legacy');
  });

  it('delegates to window.__hm.force("modern") for the modern counterpart', () => {
    const force = vi.fn();
    (window as unknown as { __hm: { force: (b: string) => void } }).__hm = { force };
    forceModernPlayer();
    expect(force).toHaveBeenCalledWith('modern');
  });

  it('falls back to a ?platform=legacy reload when __hm is absent', () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'http://tv.local/#/play/x' },
      configurable: true,
      writable: true,
    });
    forceBasicPlayer();
    expect(window.location.href).toContain('platform=legacy');
  });
});
