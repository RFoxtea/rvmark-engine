/**
 * span-toggle.ts
 *
 * Manual toggles: a span in a node's label that expands its target into the
 * node's children area, and collapses it again when activated a second time.
 *
 * Options are toggles too — `{option}` names what drives one. An option toggle
 * is on while selected; a manual toggle is on from activation until
 * re-activation. This module wires only the manual kind; the listbox path in
 * listbox-utils.ts wires the other. See the design note §1c.
 *
 * A manual toggle is a button reached by Tab, activated with Enter/Space or a
 * click. Arrow keys are never its own — they always mean listbox navigation.
 */

import type { ParsedSpanAttrs } from './markdown.js';
import { BARE_MUTATION_KEY } from './markdown.js';
import type { Multimap } from './multimap.js';
import type { RenderNode } from './render-node.js';
import type { ToggleSet } from './toggle-set.js';
import { spanIsSelectionDriven } from './listbox-utils.js';
import { applyEventAttr, treeNavKeydown } from './handler-utils.js';
import { scrollRowIntoMiddle } from './scroll.js';

/** Marker element mirroring the bullet's glyph, placed in front of the span. */
function makeSpanMarker(): HTMLElement {
  const marker = document.createElement('span');
  marker.className = 'span-toggle-marker';
  marker.setAttribute('aria-hidden', 'true');
  return marker;
}

/**
 * Wire every manual toggle under `root`. Returns a teardown.
 *
 * `nodeAttrs` is needed because `{listbox}` may be declared node-level, making
 * options of spans the renderer saw only as bare `=> #ref` — the renderer
 * cannot see node attrs, so role and marker are settled here.
 */
// An option is selection-driven, so a bare `let`/`set`/`remove` on it means
// "when this becomes current" — not "on the action gesture". The span parser
// cannot tell: whether a span is an option depends on node attrs it never sees
// (`{listbox}`), so it files every bare mutation under on-action and records it
// under BARE_MUTATION_KEY. Here, with the kind settled, the bare ones move to
// on-select.
//
// An explicitly written `{on-action: …}` is left exactly where it is. The author
// named the gesture key, so it keeps firing on Enter/Space — and makes the
// option consume that key, rather than passing it to the node.
function retargetBareMutations(span: ParsedSpanAttrs): void {
  const bare = span.getAll(BARE_MUTATION_KEY);
  if (!bare.length) return;
  const explicit = span.getAll('on-action').filter(v => !bare.includes(v));
  span.delete('on-action');
  for (const v of explicit) span.append('on-action', v);
  for (const v of bare)     span.append('on-select', v);
  span.delete(BARE_MUTATION_KEY);
}

export function wireSpanToggles(
  root:      HTMLElement,
  spanMap:   Map<number, ParsedSpanAttrs>,
  nodeAttrs: Multimap,
  rn:        RenderNode,
  toggles:   ToggleSet,
): () => void {
  const teardowns: Array<() => void> = [];

  for (const el of root.querySelectorAll<HTMLElement>('[data-rvmark-span]')) {
    const ordinal = parseInt(el.getAttribute('data-rvmark-span')!, 10);
    const span    = spanMap.get(ordinal);
    if (!span) continue;
    if (spanIsSelectionDriven(span, nodeAttrs)) {
      retargetBareMutations(span);
      // The renderer marks a bare `=> #ref` as a manual toggle, but node-level
      // `{listbox}` may make it an option — which the renderer cannot see. Undo
      // the guess now that node attrs are known. Options are wired by the
      // listbox path, and never get Tab or a toggle marker: DOM focus on an
      // option would desync aria-activedescendant, which listbox.ts forbids.
      el.classList.remove('inline-toggle');
      el.classList.add('inline-option');
      el.setAttribute('role', 'option');
      continue;
    }

    const ref = span.get('transclude');
    // A targetless {toggle} is a checkbox: it contends for no children area, so
    // it is not a member of the toggle set and its meaning is whatever state it
    // sets. Not wired here — its on-action mutations already fire through the
    // ordinary span path.
    if (!ref) continue;

    el.classList.add('inline-toggle');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.setAttribute('aria-expanded', 'false');
    // Tab-reachable: the baseline keyboard model for a toggle span is a button,
    // independent of whether the node is also a listbox.
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    // Scoped to the span's own children: querySelector would also match a
    // marker nested inside the label (e.g. an <em> wrapper), and wiring runs
    // more than once — markdown.ts re-renders on fetch and again on KaTeX —
    // so a descendant match would let a second marker be prepended.
    if (!el.querySelector('.span-toggle-marker')) el.prepend(makeSpanMarker());

    toggles.register(el);

    const activate = () => {
      toggles.toggleSpan(el, ref);
      for (const v of span.getAll('on-action')) applyEventAttr(v, rn);
    };

    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      activate();
    };

    // Enter/Space toggle; ArrowRight/Left open and close directionally and
    // ArrowUp/Down walk to the previous/next node — the same gestures a node's
    // bullet answers to, so a focused span navigates like the row it sits in.
    //
    // This supersedes §1c's "arrows are never a manual toggle's". That rule was
    // wrong: a span holding DOM focus is the thing being operated, and refusing
    // it the obvious gesture bought nothing. Nothing is taken from the listbox
    // either — while a span has DOM focus the node is in "mode"
    // (FocusGating.modeActive), and both the node's own arrow cases and its
    // listbox dispatch bail on `inMode`, so arrowing across options still
    // requires focus on the node itself.
    const onKeydown = (e: KeyboardEvent) => {
      const open = toggles.isSpanOpen(el);
      switch (e.key) {
        case 'Enter':
        case ' ':
          activate();
          break;
        case 'ArrowRight':
          // Open when closed. When already open, step into the content it put
          // in the children area, mirroring a node's ArrowRight.
          if (!open) activate();
          else {
            const fc = rn.children?.querySelector<HTMLElement>('.node-content');
            if (fc) { fc.focus(); scrollRowIntoMiddle(fc); }
          }
          break;
        case 'ArrowLeft':
          // Close when open; otherwise leave the event alone so it keeps its
          // ordinary meaning rather than being silently swallowed.
          if (!open) return;
          activate();
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          // Move to the previous/next node, as if the node itself were focused.
          // Delegated to treeNavKeydown so a focused span walks the tree by
          // exactly the same rules — including Alt for sibling-only movement —
          // rather than carrying a second traversal that could drift from it.
          // It calls preventDefault itself and moves focus off this span, which
          // is what ends the toggle's claim on the arrow keys.
          treeNavKeydown(e, rn.contentEl, rn.li);
          e.stopPropagation();
          return;
        default:
          return;
      }
      // The node's own handler treats these as its bullet/tree gestures, so the
      // event must not continue up to it.
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeydown);
    teardowns.push(() => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeydown);
    });
  }

  return () => { for (const t of teardowns) t(); };
}
