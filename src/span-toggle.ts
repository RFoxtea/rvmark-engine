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
import type { Multimap } from './multimap.js';
import type { RenderNode } from './render-node.js';
import type { ToggleSet } from './toggle-set.js';
import { spanIsSelectionDriven } from './listbox-utils.js';
import { applyEventAttr } from './handler-utils.js';

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

    // Arrow keys are never a manual toggle's (§1c). They always mean listbox
    // navigation, so that how a span was reached tells the reader which keys
    // apply: arrows for options, Tab then Enter/Space for manual toggles.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // The node's own handler treats Enter/Space as its bullet toggle, so the
      // event must not continue up to it.
      e.stopPropagation();
      e.preventDefault();
      activate();
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
