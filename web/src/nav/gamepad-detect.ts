/**
 * 0.2.0 (Layer 2, D7) — Gamepad API detection for GLYPH THEMING ONLY.
 *
 * Navigation never touches the Gamepad API — the D-pad emits keyboard events
 * which the FocusNavController already handles. This module exists solely to
 * read a connected controller's `id` ("DualSense", "Xbox One Controller") so
 * the <glyph-hint-bar> can pick Xbox vs PlayStation glyphs. If detection is
 * uncertain we return 'generic' and the bar renders neutral "OK / Back" text —
 * wrong glyphs are worse than generic ones (D7).
 */

export type GlyphPlatform = 'xbox' | 'playstation' | 'generic';

/** Map a Gamepad.id string to a glyph platform. Returns null when the id is
 *  present but unrecognised, so callers can fall back to the boot-router
 *  platform classification before defaulting to 'generic'. */
export function platformFromGamepadId(id: string): GlyphPlatform | null {
  const s = id.toLowerCase();
  // Explicit brand tokens first. "Xbox Wireless Controller" and Sony's bare
  // "Wireless Controller" both contain "wireless controller", so the generic
  // phrase must only count as a PlayStation signal AFTER ruling Xbox out.
  if (/xbox|x-box|xinput|microsoft|045e/.test(s)) return 'xbox';
  if (/dualsense|dualshock|playstation|sony|ps4|ps5|054c|wireless controller/.test(s)) {
    return 'playstation';
  }
  return null;
}

/** Poll the connected gamepads and resolve a glyph platform, preferring a
 *  recognised controller id, then the boot-router platform, then 'generic'. */
export function detectGlyphPlatform(bootPlatform?: string): GlyphPlatform {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad && pad.id) {
        const p = platformFromGamepadId(pad.id);
        if (p) return p;
      }
    }
  } catch {
    /* getGamepads can throw in some sandboxed contexts — fall through */
  }
  // No (recognised) controller — fall back to the boot router's UA-based
  // platform, which knows "this is an Xbox/PS" even before the first input.
  if (bootPlatform === 'xbox' || bootPlatform === 'playstation') return bootPlatform;
  return 'generic';
}

/** Summary of connected controller ids — backs window.__hm.gamepads(). */
export function gamepadIds(): string[] {
  const ids: string[] = [];
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad && pad.id) ids.push(pad.id);
    }
  } catch {
    /* ignore */
  }
  return ids;
}
