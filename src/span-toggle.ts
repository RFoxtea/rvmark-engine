/**
 * span-toggle.ts
 *
 * Action-driven spans: a span in a node's label that expands its target into
 * the node's children area, and collapses it again when activated a second
 * time. The counterpart to listbox options, which are selection-driven.
 *
 * The two kinds consume different events — action vs select/deselect — which is
 * what makes them genuinely different rather than one being a flag on the
 * other. Toggling is the default; `activate: auto` opts a span back into
 * selection-driven behaviour. See rvmark-site/tools/toggle-spans-design-note.md.
 *
 * A toggle span is a button, reached by Tab. It may ALSO be an {option}, in
 * which case the listbox still navigates to it by arrow keys but the toggle
 * owns what the children area shows (§6b).
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
 * Wire every action-driven span under `root`. Returns a teardown.
 *
 * `nodeAttrs` is needed because `activate` may be declared node-level and
 * overridden per span — the renderer cannot see node attrs, so the role and
 * marker for these spans are settled here.
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
      // The renderer marks a bare `=> #ref` as a toggle because that is the
      // default, but `activate: auto` may be declared on the NODE, which the
      // renderer cannot see. Undo the guess now that node attrs are known.
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
    // A span that is also an {option} keeps arrow keys for listbox navigation
    // (§3a/§6b); only a plain toggle span may claim them for its own expansion.
    const ownsArrows = !span.has('option');

    const onKeydown = (e: KeyboardEvent) => {
      if (ownsArrows && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        // Expansion, not tree navigation: the node's handler would otherwise
        // expand/collapse the NODE while a span inside it holds focus.
        const wantOpen = e.key === 'ArrowRight';
        if (wantOpen !== toggles.isSpanOpen(el)) {
          e.stopPropagation();
          e.preventDefault();
          if (wantOpen) void toggles.openSpan(el, ref);
          else toggles.closeSpan(el);
        }
        return;
      }
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
