/**
 * Shared scroll math for `<season-strip>` and `<poster-strip>`. (0.1.3.2 D1)
 *
 * Both strips have the same mechanics — a horizontal scroller that, on mount,
 * snaps an "anchor" element into view. The only difference is alignment:
 *   - `<season-strip>` centers the hero card.
 *   - `<poster-strip>` aligns the most-relevant card to the LEFT edge.
 */

export type StripAlign = 'left' | 'center';

/** Compute the desired scrollLeft for `scrollEl` so `anchorEl` ends up aligned. */
export function computeScrollTarget(
  scrollEl: HTMLElement,
  anchorEl: HTMLElement,
  align: StripAlign,
): number {
  const max = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
  let target: number;
  if (align === 'center') {
    const anchorCenter = anchorEl.offsetLeft + anchorEl.offsetWidth / 2;
    target = anchorCenter - scrollEl.clientWidth / 2;
  } else {
    target = anchorEl.offsetLeft;
  }
  return Math.max(0, Math.min(max, target));
}

/**
 * Snap `scrollEl`'s scrollLeft so `anchorEl` is positioned per `align`. When
 * `anchorEl` is null, scroll to the start (0). When `smooth` is true and the
 * runtime supports it, animate; otherwise jump.
 */
export function snapToAnchor(
  scrollEl: HTMLElement,
  anchorEl: HTMLElement | null,
  align: StripAlign,
  smooth: boolean,
): void {
  if (!anchorEl) {
    if (smooth && typeof scrollEl.scrollTo === 'function') {
      scrollEl.scrollTo({ left: 0, behavior: 'smooth' });
    } else {
      scrollEl.scrollLeft = 0;
    }
    return;
  }
  const clamped = computeScrollTarget(scrollEl, anchorEl, align);
  if (smooth && typeof scrollEl.scrollTo === 'function') {
    scrollEl.scrollTo({ left: clamped, behavior: 'smooth' });
  } else {
    scrollEl.scrollLeft = clamped;
  }
}
