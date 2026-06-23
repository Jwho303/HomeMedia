/**
 * 0.2.0 (D9) — the user-facing "Basic Player" escape hatch.
 *
 * Detection is wrong ~5% of the time, and a stalled modern player on a TV is
 * unrecoverable without devtools. This drops to the native-HLS legacy client
 * in one action. It prefers `window.__hm.force('legacy')` (set by the boot
 * router) and falls back to setting `?platform=legacy` + reloading directly,
 * so it still works in dev where boot.js may not have run.
 */
export function forceBasicPlayer(): void {
  const hm = (window as unknown as { __hm?: { force?: (b: string) => void } }).__hm;
  if (hm?.force) {
    hm.force('legacy');
    return;
  }
  // Fallback: set the override query param and reload, mirroring boot.js.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('platform', 'legacy');
    window.location.href = url.toString();
  } catch {
    window.location.href = '/legacy/';
  }
}

/** Symmetric counterpart — force back to the modern client (mainly testing). */
export function forceModernPlayer(): void {
  const hm = (window as unknown as { __hm?: { force?: (b: string) => void } }).__hm;
  if (hm?.force) {
    hm.force('modern');
    return;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('platform', 'modern');
    window.location.href = url.toString();
  } catch {
    window.location.href = '/';
  }
}
