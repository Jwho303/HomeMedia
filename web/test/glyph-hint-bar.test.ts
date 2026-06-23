import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/components/glyph-hint-bar.js';
import type { GlyphHintBar } from '../src/components/glyph-hint-bar.js';
import { platformFromGamepadId, detectGlyphPlatform } from '../src/nav/gamepad-detect.js';

/**
 * 0.2.0 Phase 3 — controller glyphs.
 *
 * The bar themes confirm/back prompts by platform: Xbox → A/B glyph SVGs,
 * PlayStation → cross/circle SVGs, generic → neutral text chips. The acceptance
 * criteria are about which set renders, so we assert on the rendered shadow DOM.
 */

async function mountBar(platform: 'xbox' | 'playstation' | 'generic'): Promise<GlyphHintBar> {
  const el = document.createElement('glyph-hint-bar') as GlyphHintBar;
  el.platform = platform;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('platformFromGamepadId (D7 — glyph theming only)', () => {
  it('maps PlayStation controller ids', () => {
    expect(platformFromGamepadId('DualSense Wireless Controller')).toBe('playstation');
    expect(platformFromGamepadId('Sony DualShock 4')).toBe('playstation');
    expect(platformFromGamepadId('054c-0ce6-Wireless Controller')).toBe('playstation');
  });
  it('maps Xbox controller ids', () => {
    expect(platformFromGamepadId('Xbox Wireless Controller')).toBe('xbox');
    expect(platformFromGamepadId('045e-02ea-Microsoft X-Box One pad')).toBe('xbox');
    expect(platformFromGamepadId('xinput gamepad (XInput STANDARD GAMEPAD)')).toBe('xbox');
  });
  it('returns null for an unrecognised id (caller falls back)', () => {
    expect(platformFromGamepadId('8BitDo Pro 2')).toBeNull();
  });
});

describe('detectGlyphPlatform — fallback chain', () => {
  beforeEach(() => {
    (navigator as unknown as { getGamepads?: () => unknown }).getGamepads = (): unknown[] => [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the boot platform when no controller is present', () => {
    expect(detectGlyphPlatform('playstation')).toBe('playstation');
    expect(detectGlyphPlatform('xbox')).toBe('xbox');
  });
  it('defaults to generic when nothing is known', () => {
    expect(detectGlyphPlatform('tizen')).toBe('generic');
    expect(detectGlyphPlatform(undefined)).toBe('generic');
  });
  it('prefers a recognised controller id over the boot platform', () => {
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = (): unknown[] => [
      { id: 'DualSense Wireless Controller' },
    ];
    expect(detectGlyphPlatform('xbox')).toBe('playstation');
  });
});

describe('<glyph-hint-bar> rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (navigator as unknown as { getGamepads?: () => unknown }).getGamepads = (): unknown[] => [];
  });

  it('platform="xbox" renders Xbox glyphs (Ⓐ confirm / Ⓑ back)', async () => {
    const el = await mountBar('xbox');
    const sr = el.shadowRoot!;
    expect(sr.querySelector('[data-glyph="xbox-confirm"]')).not.toBeNull();
    expect(sr.querySelector('[data-glyph="xbox-back"]')).not.toBeNull();
    // No neutral chips, no PlayStation glyphs.
    expect(sr.querySelector('.neutral')).toBeNull();
    expect(sr.querySelector('[data-glyph^="ps-"]')).toBeNull();
    expect(sr.querySelectorAll('.glyph').length).toBe(2);
  });

  it('platform="playstation" renders PlayStation glyphs (✕ confirm / ○ back)', async () => {
    const el = await mountBar('playstation');
    const sr = el.shadowRoot!;
    expect(sr.querySelector('[data-glyph="ps-confirm"]')).not.toBeNull();
    expect(sr.querySelector('[data-glyph="ps-back"]')).not.toBeNull();
    expect(sr.querySelector('.neutral')).toBeNull();
    expect(sr.querySelector('[data-glyph^="xbox-"]')).toBeNull();
    expect(sr.querySelectorAll('.glyph').length).toBe(2);
  });

  it('menu hint renders the "more options" face button: Ⓨ (xbox) / △ (playstation)', async () => {
    const xbox = document.createElement('glyph-hint-bar') as GlyphHintBar;
    xbox.platform = 'xbox';
    xbox.hints = [{ kind: 'menu', label: 'Options' }];
    document.body.appendChild(xbox);
    await xbox.updateComplete;
    expect(xbox.shadowRoot!.querySelector('[data-glyph="xbox-menu"]')).not.toBeNull();

    const ps = document.createElement('glyph-hint-bar') as GlyphHintBar;
    ps.platform = 'playstation';
    ps.hints = [{ kind: 'menu', label: 'Options' }];
    document.body.appendChild(ps);
    await ps.updateComplete;
    expect(ps.shadowRoot!.querySelector('[data-glyph="ps-menu"]')).not.toBeNull();
  });

  it('forced=true keeps the seed platform even with a recognised gamepad connected', async () => {
    // A DualSense is connected, but the user spoofed Xbox via ?glyph=xbox.
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = (): unknown[] => [
      { id: 'DualSense Wireless Controller' },
    ];
    const el = document.createElement('glyph-hint-bar') as GlyphHintBar;
    el.platform = 'xbox';
    el.forced = true;
    document.body.appendChild(el);
    await el.updateComplete;
    // Forced → Xbox glyphs win; the PlayStation controller does NOT override.
    expect(el.shadowRoot?.querySelector('[data-glyph="xbox-confirm"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[data-glyph^="ps-"]')).toBeNull();
  });

  it('generic platform renders neutral text labels, NOT wrong glyphs', async () => {
    const el = await mountBar('generic');
    const sr = el.shadowRoot!;
    const neutral = sr.querySelectorAll('.neutral');
    expect(neutral.length).toBe(2);
    const text = sr.textContent ?? '';
    expect(text).toContain('OK');
    expect(text).toContain('Back');
    // No themed glyph spans at all.
    expect(sr.querySelector('.glyph')).toBeNull();
    expect(sr.querySelector('[data-glyph^="xbox-"]')).toBeNull();
    expect(sr.querySelector('[data-glyph^="ps-"]')).toBeNull();
  });
});
