/**
 * scroll.ts
 *
 * Scroll helpers for the rvmark tree.
 *
 * scrollRowIntoMiddle — scrolls a .node-content row into the middle 3/5
 * dead zone of #tree-scroll, both vertically and horizontally.
 * scrollRevealIntoView — frames a node's row together with what it just revealed.
 */

// The "middle 3/5" dead zone: only scroll vertically if the row is outside
// the band between 1/5 and 4/5 of the scroller height.
const SCROLL_DEAD_ZONE_FRACTION = 5; // denominator — row must be within [1/5, 4/5]

/**
 * Scroll behavior honouring prefers-reduced-motion.
 *
 * A smooth scroll moves the whole viewport, which is the kind of large-field
 * motion prefers-reduced-motion exists to suppress — it can provoke nausea or
 * dizziness in readers with vestibular disorders. Reduced-motion readers get
 * 'auto' (an instant jump): the scroll still happens and the row still lands
 * where it should, only the travel between is skipped.
 *
 * Queried per call rather than cached, so a reader who changes the setting
 * mid-session is respected without a reload.
 */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
}

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
        behavior: scrollBehavior(),
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
    if (newLeft !== curLeft) scroller.scrollTo({ left: newLeft, behavior: scrollBehavior() });
  }
}

/**
 * Scroll so a node's row and the content it just revealed below are both in view.
 *
 * A reveal is unlike a plain move: the row the reader operated stays put and
 * the thing worth seeing appears underneath it. Centring the row
 * (scrollRowIntoMiddle) answers the wrong question — it can push the reveal
 * back off the bottom edge. So the target is the bracket from the node's own
 * row down through the FIRST revealed row.
 *
 * The first row, not the whole children block: a transclusion can drop in
 * hundreds of children, and what tells the reader the reveal happened is where
 * it starts. The rest is theirs to scroll. Measuring one row also costs the
 * same whatever arrived.
 *
 * The bracket is placed with a margin of breathing room at each end, and where
 * both cannot be honoured the top wins — the row is the fixed point the reader
 * operated. Nothing moves if the bracket is already framed, and nothing is
 * added at the limits of the scroll range: a top node sitting flush against the
 * top of the tree is where it belongs.
 */
const REVEAL_MARGIN_FRACTION = 12; // breathing room, as a fraction of scroller height

export function scrollRevealIntoView(rowEl: HTMLElement, revealEl: HTMLElement): void {
  const scroller = document.getElementById('tree-scroll');
  if (!scroller) return;
  if (!scroller.contains(rowEl) || !scroller.contains(revealEl)) return;

  const scrollerRect = scroller.getBoundingClientRect();
  const scrollerH    = scroller.clientHeight;
  const margin       = scrollerH / REVEAL_MARGIN_FRACTION;

  // Falling back to the container covers a reveal that is not a node list (an
  // embedded body, say), which is one element and measures the same either way.
  const footEl = revealEl.querySelector<HTMLElement>('.node-content') ?? revealEl;

  const top    = rowEl.getBoundingClientRect().top     - scrollerRect.top + scroller.scrollTop;
  const bottom = footEl.getBoundingClientRect().bottom - scrollerRect.top + scroller.scrollTop;

  // The scrollTop window that keeps both margins. It is empty when the bracket
  // plus its margins exceeds the viewport, and the upper bound then wins.
  const highest = top - margin;                    // any lower and the row is clipped
  const lowest  = bottom + margin - scrollerH;     // any higher and the reveal is

  const cur = scroller.scrollTop;
  const next = Math.max(0, Math.min(
    Math.min(Math.max(cur, lowest), highest),
    scroller.scrollHeight - scrollerH,
  ));

  if (Math.abs(next - cur) > 1) scroller.scrollTo({ top: next, behavior: scrollBehavior() });
}
