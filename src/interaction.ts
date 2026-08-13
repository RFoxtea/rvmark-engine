/**
 * interaction.ts
 *
 * User interaction logic for the rvmark tree:
 *   - wireSelectThenAction  — select-then-action click behaviour
 *   - Global event listeners:
 *       document Escape     — close exhibit panel
 *       document keydown    — bootstrap arrow-key focus into tree
 *
 * Depends on scroll.ts (scrollRowIntoMiddle) and exhibit.js (exhibitIsOpen, exhibitClose).
 */

import { scrollRowIntoMiddle } from './scroll.js';
import { exhibitIsOpen, exhibitClose } from './exhibit.js';
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
    // browser's native word/paragraph selection. A held modifier opts out.
    if (e.detail >= 2 && !hasModifier(e)) e.preventDefault();
    const rn: RenderNode | undefined = (target.closest<HTMLElement>('.node') as any)?._renderNode;
    wasSelected = !!rn && RenderNode.currentSelection === rn;
    downX = e.clientX; downY = e.clientY;
  });
  target.addEventListener('click', (e) => {
    const et = e.target as HTMLElement;
    if (et.tagName === 'A' || isExcluded(et) || spanIsInteractive(et)) return;
    if (hasModifier(e)) return;
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD_PX;
    if (wasSelected && !moved) doAction(undefined, { scroll: false });
    else focusTarget.focus();
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

// Escape closes exhibit panel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!exhibitIsOpen()) return;
  const active = document.activeElement;
  if (!active?.classList.contains('node-content')) return;
  exhibitClose();
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
