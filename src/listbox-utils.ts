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
import type { ToggleSet } from './toggle-set.js';
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
  /** The node's toggle set, so a transcluding option can take the hill (§1c).
   *  Optional: a listbox on a node with no toggle set still works, it simply
   *  has no one to contend with. */
  toggles?: ToggleSet;
}

export function wireListbox(cfg: ListboxConfig): ListboxNav {
  const { optionContainer, navRoot, spanMap, rn, sourceNode, scrollOnSelect, volatile, toggles } = cfg;

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
    // No on-action here: an option is selection-driven, so its own mutations
    // ride on-select and are fired by the caller. `on-action` on an option means
    // what it means everywhere — the context-sensitive gesture — and belongs to
    // onActivate alone.
    const transclude = params.get('transclude');
    // Only a TRANSCLUDING option takes the hill (§1c). A targetless option —
    // Euclid's `[BCD]{let &e-ri = …}`, thousands of them — makes no claim on
    // the children area, so it must not touch it: it takes nothing and knocks
    // nobody off, which is what lets a manual toggle stay open while the reader
    // arrows across the highlights beneath it.
    if (!transclude) return;
    toggles?.takeHillForOption(el);
    void expandNode(rn, transclude);
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
          // Deselection turns an option off, so it stops holding the hill. If
          // the newly selected option transcludes it takes the hill below and
          // fills the area; if it does not, the area is emptied here — an
          // option's content must not outlive its selection.
          if (toggles?.isSpanOpen(_prevEl)) {
            toggles.releaseIfHolder(_prevEl);
            if (!spanOf(el).get('transclude')) rn.setChildren([]);
          }
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
      // Action is the context-sensitive gesture (Enter/Space, committing click),
      // never selection — an option's own state mutations ride `on-select` and
      // have already fired by the time we get here. So this runs only what the
      // author explicitly filed under `on-action`, and consumes the key only if
      // there was something to run.
      //
      // An option that consumes nothing leaves Enter to the node, which is what
      // lets a markdown node still focus its scroll area while one of its
      // options is selected.
      onActivate(_idx, el) {
        const actions = spanOf(el).getAll('on-action');
        for (const v of actions) applyEventAttr(v, rn);
        if (el.tagName === 'A') { (el as HTMLAnchorElement).click(); return true; }
        return actions.length > 0;
      },
      onReset() {
        let heldHill = false;
        if (_prevEl) {
          fireSpanEvent(_prevEl, 'on-deselect');
          fireSpanEvent(_prevEl, 'on-blur');
          heldHill = !!toggles?.isSpanOpen(_prevEl);
          if (heldHill) toggles!.releaseIfHolder(_prevEl);
          _prevEl = null;
        }
        // Restore the node's own children only when the listbox itself held the
        // hill (or there is no toggle set to hold it). A manual toggle holding
        // the hill is untouched by deselection — nothing knocked it off, so it
        // stands. `on-no-option-select` still fires either way: it is a fact
        // about selection, not about the children area, and Euclid relies on it
        // to clear the diagram highlight.
        if (heldHill || !toggles || toggles.hillIsFree()) {
          rn.setChildren(sourceNode.children as SourceNode[], null);
        }
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

// ── Option toggles vs manual toggles ───────────────────────────────────────
//
// Everything expandable is a toggle; `{option}` names what DRIVES one:
//   option toggle — on when selected,  off when deselected   (arrow keys)
//   manual toggle — on when activated, off when re-activated (Tab, Enter/Space)
//
// `{option; toggle}` is redundant rather than a compose case: an option already
// is a toggle. There is no `activate` attribute — the fork it expressed is
// carried by `{option}`, so no span leaves the question open.
// See rvmark-site/tools/toggle-spans-design-note.md §1c.

export function spanIsSelectionDriven(span: ParsedSpanAttrs, nodeAttrs: Multimap): boolean {
  // `{option}` is explicit and settles it.
  if (span.has('option')) return true;
  // An explicit span-level `{toggle}` opts OUT of an inherited node-level
  // listbox. Without this a node carrying {listbox-volatile} — which Euclid
  // applies to every node through the [.euclid] tag — would demote its
  // citations to options, and §1c's "Why Euclid works" needs exactly the mix it
  // forbade: targetless highlight options arrowed across while a manual-toggle
  // citation holds the hill. Span-level beats node-level because the node
  // attribute is a default for spans that do not say, not an override.
  if (span.has('toggle')) return false;
  // A node declared {listbox} says its spans are options — declaring the group
  // and then having its members not be options would make the attribute mean
  // nothing.
  return nodeAttrs.has('listbox') || nodeAttrs.has('listbox-volatile');
}

/** True when the span participates in the node's listbox group. Identical to
 *  being selection-driven now that options and toggles are one mechanism
 *  (§1c); kept as its own name because call sites ask a different question. */
export function spanIsOption(span: ParsedSpanAttrs, nodeAttrs: Multimap): boolean {
  return spanIsSelectionDriven(span, nodeAttrs);
}

export function isListbox(
  attrs: Multimap,
  spanMap: Map<number, ParsedSpanAttrs>,
): boolean {
  // `on-select` is tested alongside `on-action` because an option's bare
  // mutations are re-filed from one to the other once its kind is known (see
  // retargetBareMutations). This runs before that pass today, but testing both
  // keeps the answer stable regardless of call order.
  return attrs.has('listbox') ||
    [...spanMap.values()].some(s =>
      s.has('option') || s.has('on-action') || s.has('on-select') || spanIsSelectionDriven(s, attrs));
}
