/**
 * listbox-utils.ts
 *
 * Shared listbox wiring for type handlers (text, markdown, tr).
 * Implements the full canonical behaviour:
 *   - state var pre-declaration
 *   - _rvmarkSpan annotation on DOM elements from spanMap
 *   - applyOptionSelection: clear prev assignments, apply new, expandNode
 *   - resetSelection: clear assignments, restore children
 *   - scroll selected option into view
 *   - onActivate for link-type options
 *   - default {selected} initial selection
 */

import { createListboxNav } from './listbox.js';
import { Multimap } from './multimap.js';
import type { ListboxNav } from './listbox.js';
import type { ParsedSpanAttrs } from './markdown.js';
import type { RenderNode, SourceNode } from './render-node.js';
import { expandNode, applyEventAttr } from './handler-utils.js';

// Shared empty attr set for elements with no parsed span (e.g. an author-written
// [role=option] that never went through the span extension).
const EMPTY_SPAN: ParsedSpanAttrs = new Multimap();

export interface ListboxConfig {
  /** The element that receives role=listbox and contains [role=option] elements. */
  optionContainer: HTMLElement;
  /** The root element passed to createListboxNav (content div). */
  navRoot: HTMLElement;
  /** spanMap from mdInlineWithSpans / mdToHtmlWithSpans. */
  spanMap: Map<number, ParsedSpanAttrs>;
  /** The RenderNode owning this listbox. */
  rn: RenderNode;
  /** Source node, used to restore children on reset. */
  sourceNode: SourceNode;
  /** If true, scroll the selected option to the centre of optionContainer on select. */
  scrollOnSelect?: boolean;
  /** If true, reset the listbox to no-option when the owning node is deselected. */
  volatile?: boolean;
}

export function wireListbox(cfg: ListboxConfig): ListboxNav {
  const { optionContainer, navRoot, spanMap, rn, sourceNode, scrollOnSelect, volatile } = cfg;

  // Annotate DOM elements with their parsed span attrs
  for (const el of optionContainer.querySelectorAll<HTMLElement>('[data-rvmark-span]')) {
    const ordinal = parseInt(el.getAttribute('data-rvmark-span')!, 10);
    const parsed  = spanMap.get(ordinal);
    if (parsed) (el as any)._rvmarkSpan = parsed;
  }


  let _prevEl: HTMLElement | null = null;

  const spanOf = (el: HTMLElement): ParsedSpanAttrs => (el as any)._rvmarkSpan ?? EMPTY_SPAN;

  // Every value of an event key fires, in source order — a span may declare the
  // same on-* handler more than once.
  const fireSpanEvent = (el: HTMLElement, key: string) => {
    for (const v of spanOf(el).getAll(key)) applyEventAttr(v, rn);
  };

  const applyOptionSelection = (el: HTMLElement) => {
    const params = spanOf(el);
    // A span's state mutations live under on-action (bare `let`/`set`/`remove`
    // normalize to it), and every one of them applies — hence getAll.
    for (const v of params.getAll('on-action')) applyEventAttr(v, rn);
    const transclude = params.get('transclude');
    if (transclude) {
      void expandNode(rn, transclude);
    } else {
      rn.setChildren(sourceNode.children as SourceNode[], null);
    }
  };

  const nav = createListboxNav(
    navRoot,
    optionContainer,
    () => [...optionContainer.querySelectorAll<HTMLElement>('[role="option"]')],
    {
      onSelect(_idx, el) {
        if (_prevEl && _prevEl !== el) {
          fireSpanEvent(_prevEl, 'on-deselect');
          fireSpanEvent(_prevEl, 'on-blur');
        }
        applyOptionSelection(el);
        fireSpanEvent(el, 'on-select');
        fireSpanEvent(el, 'on-focus');
        _prevEl = el;
        if (scrollOnSelect) {
          const elRect        = el.getBoundingClientRect();
          const containerRect = optionContainer.getBoundingClientRect();
          optionContainer.scrollTop +=
            (elRect.top - containerRect.top) - (optionContainer.clientHeight / 2 - el.clientHeight / 2);
        }
      },
      onActivate(_idx, el) {
        fireSpanEvent(el, 'on-action');
        if (el.tagName === 'A') (el as HTMLAnchorElement).click();
      },
      onReset() {
        if (_prevEl) {
          fireSpanEvent(_prevEl, 'on-deselect');
          fireSpanEvent(_prevEl, 'on-blur');
          _prevEl = null;
        }
        rn.setChildren(sourceNode.children as SourceNode[], null);
        for (const v of rn.attrs.getAll('on-no-option-select')) applyEventAttr(v, rn);
      },
    },
  );

  optionContainer.querySelectorAll<HTMLElement>('[role="option"]').forEach(el => nav.wireOption(el));

  // Apply default {selected} if any option declares it
  const options    = [...optionContainer.querySelectorAll<HTMLElement>('[role="option"]')];
  const defaultIdx = options.findIndex(el => (el as any)._rvmarkSpan?.has('selected'));
  if (defaultIdx !== -1) nav.select(defaultIdx);

  if (volatile) {
    navRoot.addEventListener('rvmark-deselect', () => {
      if (nav.activeIdx() !== -1) nav.reset();
    });
  }

  return nav;
}

// ── Selection-driven vs action-driven spans ────────────────────────────────
//
// Which EVENT drives a span's change is what separates the two kinds:
//   listbox span — opens on selection, closes on deselection  (activate: auto)
//   toggle span  — opens on action,    closes on action       (activate: manual)
//
// Toggling is the default. `activate: auto` restores the selection-driven
// behaviour that a bare `=> #ref` used to imply on its own. Resolution order is
// span attribute, else node attribute, else manual.
// See rvmark-site/tools/toggle-spans-design-note.md §1b.

export function spanIsSelectionDriven(span: ParsedSpanAttrs, nodeAttrs: Multimap): boolean {
  const mode = span.get('activate') ?? nodeAttrs.get('activate');
  if (mode !== undefined) return mode === 'auto';
  // An explicit {option} still means "member of the listbox", which is
  // selection-driven by definition; only a bare transclude flipped to toggling.
  // A node declared {listbox} says the same thing about all of its spans —
  // declaring the group and then having its members not be options would make
  // the attribute mean nothing.
  return span.has('option') || nodeAttrs.has('listbox') || nodeAttrs.has('listbox-volatile');
}

/** True when the span participates in the node's listbox group at all. A toggle
 *  span may ALSO be an option (§3a), in which case it is arrow-reachable but
 *  keeps toggle semantics. */
export function spanIsOption(span: ParsedSpanAttrs, nodeAttrs: Multimap): boolean {
  return span.has('option') || spanIsSelectionDriven(span, nodeAttrs);
}

export function isListbox(
  attrs: Multimap,
  spanMap: Map<number, ParsedSpanAttrs>,
): boolean {
  return attrs.has('listbox') ||
    [...spanMap.values()].some(s => s.has('option') || s.has('on-action') || spanIsSelectionDriven(s, attrs));
}
