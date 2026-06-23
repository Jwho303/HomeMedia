import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BOOT_SRC = readFileSync(resolve(here, '..', 'boot.js'), 'utf8');

/**
 * 0.2.0 Phase 1 — boot router detection matrix.
 *
 * boot.js is hand-written ES5 and auto-runs as an IIFE. For unit testing it
 * sets `window.__hmBootManual` to suppress the auto-run and exposes its pure
 * functions on `window.__hmBoot`. Each test stubs the capability globals
 * (MediaSource, matchMedia, navigator.userAgent, getGamepads) then evaluates
 * a fresh copy of the file so module-level state never leaks between cases.
 */

type BootApi = {
  detect: () => Diag;
  diagnose: () => Diag;
  applyOverrides: (d: Diag) => Diag;
  legacyDefault: () => Diag;
  classifyPlatform: (ua: string) => string;
  run: () => Diag;
};

interface Diag {
  bucket: 'modern' | 'legacy';
  inputMode: 'pointer' | 'touch' | 'dpad';
  platform: string;
  mse: boolean;
  modernJs: boolean;
  nativeHls: boolean;
  forcedBucket?: boolean;
  forcedInput?: boolean;
  detectError?: boolean;
}

interface Caps {
  mseSupports?: boolean | (() => boolean) | undefined;
  hasMediaSource?: boolean;
  hasIsTypeSupported?: boolean;
  finePointer?: boolean;
  coarsePointer?: boolean;
  ua?: string;
  gamepads?: Array<{ id: string }> | null;
  search?: string;
  /** When false, pin Phase-1 logging-only mode (no redirect even on legacy).
   *  When omitted, boot.js defaults the gate live (Phase 5). */
  legacyLive?: boolean;
}

function loadBoot(caps: Caps): BootApi {
  const w = window as unknown as Record<string, unknown>;
  // Suppress the auto-run; we drive the exposed functions ourselves.
  w.__hmBootManual = true;
  delete w.__hm;
  delete w.__hmBoot;
  // Pin the legacy gate when the test asks; otherwise clear it so boot.js
  // applies its Phase-5 default (live).
  if (caps.legacyLive === undefined) delete w.__hmLegacyLive;
  else w.__hmLegacyLive = caps.legacyLive;

  // ── MediaSource (D3 primary discriminator) ──────────────────────────────
  if (caps.hasMediaSource === false) {
    delete w.MediaSource;
  } else {
    const isTypeSupported =
      caps.hasIsTypeSupported === false
        ? undefined
        : typeof caps.mseSupports === 'function'
          ? caps.mseSupports
          : (): boolean => caps.mseSupports !== false;
    w.MediaSource = { isTypeSupported } as unknown;
  }

  // ── matchMedia (pointer axis) ───────────────────────────────────────────
  window.matchMedia = ((q: string) => ({
    matches:
      q.indexOf('fine') >= 0
        ? caps.finePointer === true
        : q.indexOf('coarse') >= 0
          ? caps.coarsePointer === true
          : false,
    media: q,
  })) as unknown as typeof window.matchMedia;

  // ── navigator.userAgent + getGamepads ───────────────────────────────────
  Object.defineProperty(navigator, 'userAgent', {
    value: caps.ua ?? 'Mozilla/5.0',
    configurable: true,
  });
  (navigator as unknown as { getGamepads?: () => unknown }).getGamepads =
    caps.gamepads === undefined
      ? undefined
      : (): unknown => caps.gamepads ?? [];

  // ── location.search (overrides) ─────────────────────────────────────────
  if (caps.search !== undefined) {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: caps.search, pathname: '/', hash: '' },
      configurable: true,
      writable: true,
    });
  }

  // Evaluate a fresh copy of boot.js into the global scope.
  // eslint-disable-next-line no-new-func
  new Function(BOOT_SRC)();
  return w.__hmBoot as BootApi;
}

const MODERN_CAPS: Caps = {
  hasMediaSource: true,
  mseSupports: true,
  finePointer: true,
  ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
};

describe('boot.js — ES5 conformance (acceptance: no ES6+ syntax)', () => {
  it('parses under an ES5 parser (acorn ecmaVersion: 5)', async () => {
    const { parse } = await import('acorn');
    // Throws SyntaxError on any const/let, arrow fn, template literal,
    // optional chaining, spread, etc. — exactly what we must keep out of the
    // detector that runs on a 2014 engine (D1).
    expect(() => parse(BOOT_SRC, { ecmaVersion: 5 })).not.toThrow();
  });
});

describe('boot.detect — bucket discrimination (D3)', () => {
  beforeEach(() => {
    // happy-dom lacks navigator.getGamepads by default; loadBoot manages it.
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bucket=legacy when MediaSource is undefined', () => {
    const boot = loadBoot({ hasMediaSource: false, finePointer: true });
    expect(boot.detect().bucket).toBe('legacy');
  });

  it('bucket=legacy when isTypeSupported returns false for the H.264/AAC probe', () => {
    const boot = loadBoot({ hasMediaSource: true, mseSupports: false, finePointer: true });
    expect(boot.detect().bucket).toBe('legacy');
  });

  it('bucket=modern when MSE-h264 and modern-syntax both pass', () => {
    const boot = loadBoot(MODERN_CAPS);
    const d = boot.detect();
    expect(d.mse).toBe(true);
    expect(d.modernJs).toBe(true);
    expect(d.bucket).toBe('modern');
  });
});

describe('boot.detect — input mode (D2, orthogonal to bucket)', () => {
  it('inputMode=dpad when no fine pointer AND a couch UA', () => {
    const boot = loadBoot({
      ...MODERN_CAPS,
      finePointer: false,
      ua: 'Mozilla/5.0 (PlayStation 5)',
    });
    expect(boot.detect().inputMode).toBe('dpad');
  });

  it('inputMode=dpad when no fine pointer AND a gamepad is connected', () => {
    const boot = loadBoot({
      ...MODERN_CAPS,
      finePointer: false,
      ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
      gamepads: [{ id: 'Xbox Wireless Controller' }],
    });
    expect(boot.detect().inputMode).toBe('dpad');
  });

  it('inputMode=touch for a coarse-pointer device with no couch UA', () => {
    const boot = loadBoot({
      ...MODERN_CAPS,
      finePointer: false,
      coarsePointer: true,
      ua: 'Mozilla/5.0 (iPad)',
    });
    expect(boot.detect().inputMode).toBe('touch');
  });

  it('inputMode=pointer for a fine-pointer desktop', () => {
    const boot = loadBoot(MODERN_CAPS);
    expect(boot.detect().inputMode).toBe('pointer');
  });
});

describe('boot.classifyPlatform (D4 — UA refines platform only)', () => {
  it('classifies the known couch platforms', () => {
    const boot = loadBoot(MODERN_CAPS);
    expect(boot.classifyPlatform('Mozilla/5.0 (Xbox)')).toBe('xbox');
    expect(boot.classifyPlatform('Mozilla/5.0 (PlayStation 5)')).toBe('playstation');
    expect(boot.classifyPlatform('Mozilla/5.0 (SMART-TV; Tizen 4.0)')).toBe('tizen');
    expect(boot.classifyPlatform('Mozilla/5.0 (Web0S; webOS.TV)')).toBe('webos');
    expect(boot.classifyPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('generic');
  });
});

describe('boot override parsing (?platform= / ?input=)', () => {
  it('?platform=legacy forces bucket=legacy regardless of capabilities', () => {
    const boot = loadBoot({ ...MODERN_CAPS, search: '?platform=legacy' });
    const d = boot.applyOverrides(boot.detect());
    expect(d.bucket).toBe('legacy');
    expect(d.forcedBucket).toBe(true);
  });

  it('?platform=modern forces bucket=modern', () => {
    const boot = loadBoot({ hasMediaSource: false, search: '?platform=modern' });
    const d = boot.applyOverrides(boot.detect());
    expect(d.bucket).toBe('modern');
  });

  it('?input=dpad forces inputMode=dpad', () => {
    const boot = loadBoot({ ...MODERN_CAPS, search: '?input=dpad' });
    const d = boot.applyOverrides(boot.detect());
    expect(d.inputMode).toBe('dpad');
    expect(d.forcedInput).toBe(true);
  });

  it('?glyph=playstation forces the glyph platform (desktop preview)', () => {
    const boot = loadBoot({ ...MODERN_CAPS, search: '?glyph=playstation' });
    const d = boot.applyOverrides(boot.detect()) as Diag & { forcedGlyph?: boolean };
    expect(d.platform).toBe('playstation');
    expect(d.forcedGlyph).toBe(true);
  });

  it('?glyph=xbox + ?input=dpad combine', () => {
    const boot = loadBoot({ ...MODERN_CAPS, search: '?input=dpad&glyph=xbox' });
    const d = boot.applyOverrides(boot.detect()) as Diag & { forcedGlyph?: boolean };
    expect(d.inputMode).toBe('dpad');
    expect(d.platform).toBe('xbox');
    expect(d.forcedGlyph).toBe(true);
  });

  it('ignores an unknown ?glyph= value (keeps detected platform)', () => {
    const boot = loadBoot({ ...MODERN_CAPS, search: '?glyph=switch' });
    const d = boot.applyOverrides(boot.detect()) as Diag & { forcedGlyph?: boolean };
    expect(d.forcedGlyph).toBeUndefined();
  });
});

describe('boot legacy-default safety net (D5)', () => {
  it('a thrown error inside capability probing yields the legacy default (no propagation)', () => {
    // Make isTypeSupported throw — detect() must not propagate it.
    const boot = loadBoot({
      hasMediaSource: true,
      mseSupports: (): boolean => {
        throw new Error('broken MSE impl');
      },
      finePointer: true,
    });
    // detect() swallows the throw inside hasMseH264 → mse=false → legacy.
    expect(boot.detect().bucket).toBe('legacy');
    // diagnose() is the belt-and-suspenders wrapper around applyOverrides.
    expect(boot.diagnose().bucket).toBe('legacy');
  });

  it('legacyDefault() carries detectError and a legacy bucket', () => {
    const boot = loadBoot(MODERN_CAPS);
    const d = boot.legacyDefault();
    expect(d.bucket).toBe('legacy');
    expect(d.detectError).toBe(true);
  });
});

describe('boot.run — routing + window.__hm', () => {
  it('Phase-1 logging-only: legacy bucket but gate off → no redirect, modern loads', () => {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { search: '', pathname: '/', hash: '', replace },
      configurable: true,
      writable: true,
    });
    const boot = loadBoot({ hasMediaSource: false, finePointer: true, legacyLive: false });
    (navigator as unknown as { sendBeacon?: () => boolean }).sendBeacon = (): boolean => true;
    boot.run();
    const hm = (window as unknown as { __hm: { diag: Diag } }).__hm;
    expect(hm).toBeTruthy();
    expect(hm.diag.bucket).toBe('legacy');
    // Gate off → no redirect (device still works on modern while we log).
    expect(replace).not.toHaveBeenCalled();
  });

  it('Phase-5 live: legacy bucket → location.replace to /legacy, no modern bundle', () => {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { search: '', pathname: '/', hash: '', replace },
      configurable: true,
      writable: true,
    });
    const boot = loadBoot({ hasMediaSource: false, finePointer: true, legacyLive: true });
    (navigator as unknown as { sendBeacon?: () => boolean }).sendBeacon = (): boolean => true;
    boot.run();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(String(replace.mock.calls[0]![0])).toMatch(/^\/legacy\//);
  });

  it('modern bucket never redirects to /legacy', () => {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { search: '', pathname: '/', hash: '', replace },
      configurable: true,
      writable: true,
    });
    const boot = loadBoot({ ...MODERN_CAPS, legacyLive: true });
    (navigator as unknown as { sendBeacon?: () => boolean }).sendBeacon = (): boolean => true;
    boot.run();
    const hm = (window as unknown as { __hm: { diag: Diag } }).__hm;
    expect(hm.diag.bucket).toBe('modern');
    expect(replace).not.toHaveBeenCalled();
  });

  it('modern bucket loads the bundle from <head> even when document.body is null', () => {
    // Regression: boot.js runs inlined in <head>, so document.body is null when
    // loadModernBundle runs. Appending to a null body threw, the catch fired,
    // and EVERY modern desktop got bounced to /legacy. The bundle must append
    // to <head>/documentElement and never redirect on an inject hiccup.
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { search: '', pathname: '/', hash: '', replace },
      configurable: true,
      writable: true,
    });
    // Simulate the in-<head> state: no <body> yet.
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      const boot = loadBoot({ ...MODERN_CAPS, legacyLive: true });
      (window as unknown as { __hmBootSrc?: string }).__hmBootSrc = '/assets/index-test.js';
      (navigator as unknown as { sendBeacon?: () => boolean }).sendBeacon = (): boolean => true;
      boot.run();
      // No bounce to legacy…
      expect(replace).not.toHaveBeenCalled();
      // …and the entry module script was injected into <head>.
      const injected = document.head.querySelector('script[type="module"][src="/assets/index-test.js"]');
      expect(injected).not.toBeNull();
    } finally {
      Object.defineProperty(document, 'body', { value: realBody, configurable: true });
      delete (window as unknown as { __hmBootSrc?: string }).__hmBootSrc;
    }
  });
});
