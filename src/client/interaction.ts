/**
 * interaction.ts
 *
 * User interaction logic for the rvmark tree:
 *   - wireSelectThenAction  — select-then-action click behaviour
 *   - Global event listeners:
 *       document Escape     — close sidepanel
 *       document keydown    — bootstrap arrow-key focus into tree
 *
 * Depends on scroll.ts (scrollRowIntoMiddle) and sidepanel.js (sidepanelIsOpen, sidepanelClose).
 */

import { scrollRowIntoMiddle } from './scroll.js';
import { sidepanelIsOpen, sidepanelClose } from './sidepanel.js';
import { RenderNode } from './render-node.js';
import { spanIsInteractive } from './markdown.js';

// ── Select-then-action click ───────────────────────────────────────────────

const DRAG_THRESHOLD_PX = 5;

// Any modifier held (Shift/Ctrl/Alt/Meta, incl. Cmd on macOS) is an explicit
// "let me select, don't act" signal: skip both the double-click selection
// suppression and the re-click action so native selection works everywhere.
const hasModifier = (e: MouseEvent): boolean => e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;

export function wireSelectThenAction(
  target: HTMLElement,
  doAction: (expand?: boolean, opts?: { scroll?: boolean }) => void,
  focusTarget: HTMLElement = target,
  isExcluded: (el: HTMLElement) => boolean = () => false,
  // Whether a re-click actually does something. Only the caller knows: it
  // depends on the node's type, its attrs, and whether it can expand — all of
  // which can change after wiring, so this is a predicate rather than a flag.
  // Defaults to "yes", which is the conservative answer for a caller that has
  // not been taught the question.
  hasAction: () => boolean = () => true,
): void {
  let wasSelected = false;
  let downX = 0, downY = 0;
  // A span that handles its own clicks — a manual toggle, an option — owns the
  // whole gesture, including the second click of a double. It is focusable in
  // its own right, so suppressing the default below would blur it and drop
  // focus back on the node mid-gesture.
  target.addEventListener('mousedown', (e) => {
    const et = e.target as HTMLElement;
    if (et.tagName === 'A' || isExcluded(et) || spanIsInteractive(et)) return;
    // detail >= 2 means this mousedown is part of a double/triple-click;
    // preventDefault here (not on 'dblclick') is what actually stops the
    // browser's native word/paragraph selection. A held modifier opts out, and
    // so does a node with nothing to do on re-click: the suppression exists to
    // protect an action from being lost to a text selection, so where there is
    // no action it buys nothing and only costs the reader double-click-to-select.
    if (e.detail >= 2 && !hasModifier(e) && hasAction()) e.preventDefault();
    const rn: RenderNode | undefined = (target.closest<HTMLElement>('.node') as any)?._renderNode;
    wasSelected = !!rn && RenderNode.currentSelection === rn;
    downX = e.clientX; downY = e.clientY;
  });
  target.addEventListener('click', (e) => {
    const et = e.target as HTMLElement;
    if (et.tagName === 'A' || isExcluded(et) || spanIsInteractive(et)) return;
    if (hasModifier(e)) return;
    // A double-click on an inert node is the reader selecting a word. Taking
    // focus mid-gesture would collapse that selection, so leave it alone.
    if (e.detail >= 2 && !hasAction()) return;
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD_PX;
    if (wasSelected && !moved) doAction(undefined, { scroll: false });
    else focusTarget.focus();
    // Bring the row horizontally into view even when the click changed nothing.
    // Selecting a node already scrolls horizontally, but that runs off the
    // selection CHANGE (see setSelection), so clicking the row you are already
    // on — the natural thing to do after resizing the window pushes the tree
    // sideways — did nothing. Horizontal only: the vertical position is where
    // the reader put it, and a click is not a request to move it.
    //
    // Not for a drag: past the threshold this is a text selection, and
    // scrolling under it would wreck the gesture.
    if (!moved) scrollRowIntoMiddle(focusTarget, { vertical: false });
  });
}

// ── Focus helpers ─────────────────────────────────────────────────────────

export function focusAndScroll(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus();
  scrollRowIntoMiddle(el);
}

// ── Visible content helpers ────────────────────────────────────────────────

export function visibleContents(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.node-content')]
    .filter(r => r.offsetParent !== null && (r.closest<HTMLElement>('.node') as any)?._renderNode?.selectable !== false);
}

// Returns the visible .node-content elements that are direct siblings of li
// (i.e. children of the same parent <ul>, in document order, excluding hidden nodes).
export function siblingContents(li: HTMLElement): HTMLElement[] {
  const parentUl = li.parentElement;
  if (!parentUl) return [];
  return [...parentUl.children]
    .filter(el => el.classList.contains('node'))
    .map(el => el.querySelector<HTMLElement>(':scope > .node-content'))
    .filter((c): c is HTMLElement => !!c && c.offsetParent !== null && (c.closest<HTMLElement>('.node') as any)?._renderNode?.selectable !== false);
}

// ── Global event listeners ─────────────────────────────────────────────────

// Escape closes sidepanel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!sidepanelIsOpen()) return;
  const active = document.activeElement;
  if (!active?.classList.contains('node-content')) return;
  sidepanelClose();
  e.preventDefault();
});

// Bootstrap keyboard navigation: when arrow keys are pressed outside any
// node-content, redirect focus to the selected (or first) visible row.
const ARROW_CONSUMERS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO', 'AUDIO', 'IFRAME']);
const ARROW_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
document.addEventListener('keydown', (e) => {
  if (!ARROW_KEYS.has(e.key)) return;
  if (e.defaultPrevented) return;
  const active = document.activeElement;
  if (active?.classList.contains('node-content')) return;
  if (active && ARROW_CONSUMERS.has(active.tagName)) return;
  const ownerContent = active?.closest('.node-content');
  if (ownerContent) return;
  const all = visibleContents();
  if (!all.length) return;
  const current = RenderNode.currentSelection?.contentEl ?? null;
  const target = (current && all.includes(current)) ? current : all[0];
  target.focus();
  e.preventDefault();
});
