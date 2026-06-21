/**
 * scroll.ts
 *
 * Scroll helpers for the rvmark tree.
 *
 * scrollRowIntoMiddle — scrolls a .node-content row into the middle 3/5
 * dead zone of #tree-scroll, both vertically and horizontally.
 */

// The "middle 3/5" dead zone: only scroll vertically if the row is outside
// the band between 1/5 and 4/5 of the scroller height.
const SCROLL_DEAD_ZONE_FRACTION = 5; // denominator — row must be within [1/5, 4/5]

export function scrollRowIntoMiddle(
  targetContent: HTMLElement,
  { vertical = true, horizontal = true }: { vertical?: boolean; horizontal?: boolean } = {}
): void {
  const scroller = document.getElementById('tree-scroll');
  if (!scroller) return;

  // A detached row reports a (0,0) rect; scrolling to it yanks the scroller to a
  // garbage offset. This happens when a queued scroll rAF (e.g. scroll-on-expand)
  // fires after its node was collapsed/destroyed — bail rather than corrupt scroll.
  if (!scroller.contains(targetContent)) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect   = targetContent.getBoundingClientRect();
  const scrollerH    = scroller.clientHeight;
  const scrollerW    = scroller.clientWidth;

  if (vertical) {
    const targetTop    = targetRect.top - scrollerRect.top + scroller.scrollTop;
    const ideal        = targetTop + targetRect.height / 2 - scrollerH / 2;
    const zoneH        = scrollerH / SCROLL_DEAD_ZONE_FRACTION;
    const targetRelTop = targetRect.top - scrollerRect.top;
    if (!(targetRelTop >= zoneH && targetRelTop + targetRect.height <= zoneH * (SCROLL_DEAD_ZONE_FRACTION - 1))) {
      scroller.scrollTo({
        top: Math.max(0, Math.min(ideal, scroller.scrollHeight - scrollerH)),
        behavior: 'smooth',
      });
    }
  }

  if (horizontal) {
    const toScrollX = (el: HTMLElement): { left: number; right: number } => {
      const r = el.getBoundingClientRect();
      return {
        left:  r.left  - scrollerRect.left + scroller.scrollLeft,
        right: r.right - scrollerRect.left + scroller.scrollLeft,
      };
    };

    const target = toScrollX(targetContent);

    const parentLi       = targetContent.closest('.node')?.parentElement?.closest('.node');
    const parentContent  = parentLi ? parentLi.querySelector<HTMLElement>(':scope > .node-content') : null;
    const nodeLi         = targetContent.closest('.node');
    const firstChildContent = nodeLi?.querySelector<HTMLElement>(':scope > .node-content')?.getAttribute('aria-expanded') === 'true'
      ? (nodeLi?.querySelector<HTMLElement>(':scope > .node-children .node-content') ?? null)
      : null;
    const bracketLeft  = parentContent     ? toScrollX(parentContent).left      : target.left;
    const bracketRight = firstChildContent ? toScrollX(firstChildContent).right : target.right;

    let toFitLeft: number, toFitRight: number;
    if (bracketRight - bracketLeft <= scrollerW) {
      toFitLeft  = bracketLeft;
      toFitRight = bracketRight;
    } else {
      toFitLeft  = target.left;
      toFitRight = target.right;
    }

    const curLeft  = scroller.scrollLeft;
    const curRight = curLeft + scrollerW;
    let newLeft = curLeft;
    if      (toFitLeft < curLeft)   { newLeft = toFitLeft; }
    else if (toFitRight > curRight) { newLeft = Math.min(toFitRight - scrollerW, toFitLeft); }
    newLeft = Math.max(0, Math.min(newLeft, scroller.scrollWidth - scrollerW));
    if (newLeft !== curLeft) scroller.scrollTo({ left: newLeft, behavior: 'smooth' });
  }
}
