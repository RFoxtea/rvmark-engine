/**
 * sidepanel-split.ts
 *
 * Drag-to-resize for the sidepanel, over Split.js.
 *
 * Split.js is written for flex/float layouts: it writes a width onto each
 * element it manages. The sidepanel layout is a grid on #root, and a width on a
 * grid item does not resize its track — the track sizes the item. So the sizes
 * are intercepted instead: elementStyle/gutterStyle return no style at all, and
 * the numbers they were called with are collected and written to #root as
 * grid-template-columns (or -rows). Split.js still owns the drag maths, the
 * min-size clamping and the pointer bookkeeping; only where the result lands
 * changes.
 *
 * The gutter is #sidepanel-divider from template.html, handed back by the
 * `gutter` callback rather than letting Split.js create one. It is already in
 * the markup, already styled, and already hidden when the panel is closed.
 * That also means teardown must not delete it: destroy(true, true).
 *
 * Portrait mobile stacks the panel above the tree, so the axis is vertical and
 * the pair order is reversed. The layout switches on a media query, so the
 * split is rebuilt when that query changes.
 *
 * Split.js is imported lazily rather than at the top of the file. It touches
 * `document` while its own module body runs, and this module is in the graph
 * the static builder loads under Node — where `document` is a stub whose
 * createElement returns a bare {} (build/site.ts). A top-level import
 * therefore crashes the build. The dynamic import runs only from
 * sidepanelSplitAttach, which is reached only from a real page.
 */

import type SplitType from 'split.js';

type SplitFn = typeof SplitType;

let _Split: SplitFn | null = null;

// Matches the portrait-mobile block in styles.css that stacks the columns.
const STACKED = '(max-width: 768px) and (orientation: portrait)';

// Min track size in px. Below roughly this the tree column stops being able to
// show a node at all, and the sidepanel iframe is narrower than its own chrome.
const MIN_SIZE = 180;

// Gutter thickness in px — the divider is a 1px rule, but a 1px pointer target
// is not hittable. The rule stays 1px; the element is widened and centred over
// it by CSS (.sidepanel-divider background-clip), so the grab area is bigger
// than the mark.
const GUTTER = 9;

let _split: ReturnType<SplitFn> | null = null;
let _mql: MediaQueryList | null = null;
let _onChange: (() => void) | null = null;

// Last sizes the reader dragged to, as percentages, kept across a close/open
// and across an orientation flip. Null until they have actually dragged: an
// untouched panel opens at the 50/50 the stylesheet specifies.
let _sizes: [number, number] | null = null;

function root(): HTMLElement | null {
  return document.getElementById('root');
}

/**
 * Write the pair of track sizes onto #root.
 *
 * Split.js hands sizes to elementStyle one element at a time, and there is no
 * callback that fires once both are known, so the two are buffered here and the
 * property is rewritten on each call. The intermediate write (one new size, one
 * stale) is never painted: both calls happen in the same task.
 *
 * The sizes arrive as percentages, but they are written as `minmax(0, Nfr)`.
 * Split.js's own unit is `calc(N% - gutterpx)`, which suits a flex row where
 * the two panes are all there is. Here they are tracks in a grid that also
 * carries the header and footer: stacked, 50% + 50% is the whole of #root and
 * those auto tracks and the row gaps are then added on top, pushing the footer
 * off the bottom of the screen. fr divides only what the auto tracks and gaps
 * leave behind, which is the space the two panes actually have, and it makes
 * the gutter subtraction unnecessary — hence gutterSize going unused.
 *
 * minmax(0, …) rather than a bare fr: an fr track floors at min-content, and
 * the tree's min-content exceeds its share, so a bare fr would refuse to
 * shrink past it and the drag would stick.
 */
function makeWriter(vertical: boolean) {
  const tracks: string[] = [];
  return {
    element(_dim: string, size: number, _gutterSize: number, index: number) {
      tracks[index * 2] = `minmax(0, ${size}fr)`;
      flush();
      return {};
    },
    gutter(_dim: string, gutterSize: number) {
      tracks[1] = `${gutterSize}px`;
      flush();
      return {};
    },
  };

  function flush() {
    const el = root();
    if (!el || tracks.length < 3 || tracks.some((t) => t === undefined)) return;
    const prop = vertical ? 'gridTemplateRows' : 'gridTemplateColumns';
    // The stacked layout's grid-template-rows also carries the header and
    // footer tracks; only the two content tracks and their gutter are ours.
    el.style[prop] = vertical
      ? `auto ${tracks.join(' ')} auto`
      : tracks.join(' ');
  }
}

function build(): void {
  const el = root();
  const divider = document.getElementById('sidepanel-divider');
  const tree = document.getElementById('tree-scroll');
  const panel = el?.querySelector<HTMLElement>('.sidepanel');
  if (!el || !divider || !tree || !panel) return;

  const vertical = _mql!.matches;
  // Source order is tree, divider, panel. Stacked, the stylesheet puts the
  // panel first, so Split.js must be given them in that visual order or its
  // drag direction is inverted against the layout.
  const parts: HTMLElement[] = vertical ? [panel, tree] : [tree, panel];
  const sizes: [number, number] = _sizes
    ? (vertical ? [_sizes[1], _sizes[0]] : _sizes)
    : [50, 50];

  const writer = makeWriter(vertical);

  _split = _Split!(parts, {
    sizes,
    minSize:    MIN_SIZE,
    gutterSize: GUTTER,
    direction:  vertical ? 'vertical' : 'horizontal',
    gutter:     () => divider,
    elementStyle: writer.element,
    gutterStyle:  writer.gutter,
    onDragEnd: (s) => {
      // Stored tree-first regardless of axis, so a flip reads the same numbers.
      _sizes = vertical ? [s[1], s[0]] : [s[0], s[1]];
    },
  });
}

function teardown(): void {
  // (true, true): keep the inline styles until the rebuild overwrites them
  // — clearing them mid-flip would flash the stylesheet's 50/50 — and keep the
  // gutter, which is template markup Split.js did not create and must not
  // remove.
  _split?.destroy(true, true);
  _split = null;
  const el = root();
  if (el) { el.style.gridTemplateColumns = ''; el.style.gridTemplateRows = ''; }
}

/**
 * Called after the panel is attached and body.sidepanel-open is set.
 *
 * Async because of the lazy import above, and nothing awaits it: the panel is
 * usable before the split loads — it is laid out by the stylesheet's own
 * columns, and gains the drag once the module lands. A close arriving in that
 * window is handled by the _detached guard, which stops a build() from
 * attaching a split to a panel that is already gone.
 */
let _detached = false;

export async function sidepanelSplitAttach(): Promise<void> {
  if (_split) return;
  _detached = false;
  if (!_Split) {
    _Split = (await import('split.js')).default;
    if (_detached) return;
  }
  _mql = window.matchMedia(STACKED);
  _onChange = () => { teardown(); build(); };
  _mql.addEventListener('change', _onChange);
  build();
}

/** Called when the panel is removed. */
export function sidepanelSplitDetach(): void {
  _detached = true;
  if (_onChange && _mql) _mql.removeEventListener('change', _onChange);
  _onChange = null;
  _mql = null;
  teardown();
}
