export type Route =
  | { name: 'home' }
  | { name: 'series'; id: number }
  | { name: 'play'; path: string }
  | { name: 'search' }
  | { name: 'settings' }
  | { name: 'uncategorized' }
  | { name: 'unknown'; hash: string };

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '') || '/';
  if (h === '/' || h === '') return { name: 'home' };
  // Search may have a query string (?q=...). Strip it for route matching;
  // <search-view> reads the query from location.hash itself.
  const [pathOnly] = h.split('?');
  if (pathOnly === '/search') return { name: 'search' };
  if (pathOnly === '/settings') return { name: 'settings' };
  if (pathOnly === '/uncategorized') return { name: 'uncategorized' };

  const seriesMatch = (pathOnly ?? '').match(/^\/series\/(\d+)$/);
  if (seriesMatch && seriesMatch[1]) {
    return { name: 'series', id: Number(seriesMatch[1]) };
  }

  const playMatch = (pathOnly ?? '').match(/^\/play\/(.+)$/);
  if (playMatch && playMatch[1]) {
    let p = playMatch[1];
    try {
      p = decodeURIComponent(p);
    } catch {
      // leave as-is; let consumer surface the error
    }
    return { name: 'play', path: p };
  }

  return { name: 'unknown', hash: h };
}

/** Marks history entries created by our own `navigate()` so `goBack()` knows
 *  whether stepping back will land somewhere we own (vs. exiting the app). */
const HISTORY_TAG = 'homemedia:nav';

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. Use when
   *  the new view is a sibling of the current one and back should skip it —
   *  e.g. hopping between episodes inside the player. */
  replace?: boolean;
}

export function navigate(hash: string, opts: NavigateOptions = {}): void {
  if (window.location.hash === hash) {
    // Force a re-render by dispatching manually — setting hash to same value is a no-op.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  // Tag the entry so goBack() can detect intra-app history.
  const state = { [HISTORY_TAG]: true };
  if (opts.replace) {
    window.history.replaceState(state, '', hash);
  } else {
    window.history.pushState(state, '', hash);
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/**
 * Go back one step in app history. If there's no in-app history to step back
 * into (e.g. the user deep-linked straight to a player URL), fall back to
 * `fallback` so the back button never strands the user.
 */
export function goBack(fallback: string): void {
  const state = window.history.state as { [HISTORY_TAG]?: boolean } | null;
  if (state && state[HISTORY_TAG]) {
    window.history.back();
    return;
  }
  navigate(fallback);
}

export function homeHref(): string { return '#/'; }
export function settingsHref(): string { return '#/settings'; }
export function uncategorizedHref(): string { return '#/uncategorized'; }
export function seriesHref(id: number): string { return `#/series/${id}`; }
export function playHref(relPath: string): string {
  return `#/play/${encodeURIComponent(relPath)}`;
}

export function onRouteChange(handler: (route: Route) => void): () => void {
  const wrapped = (): void => handler(currentRoute());
  window.addEventListener('hashchange', wrapped);
  return () => window.removeEventListener('hashchange', wrapped);
}
