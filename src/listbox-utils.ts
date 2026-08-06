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
import type { Multimap } from './multimap.js';
import type { ListboxNav } from './listbox.js';
import type { ParsedSpanAttrs } from './markdown.js';
import type { RenderNode, SourceNode } from './render-node.js';
import { expandNode, applyEventAttr, resolveStateVal } from './handler-utils.js';

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

  const spanOf = (el: HTMLElement): ParsedSpanAttrs => (el as any)._rvmarkSpan ?? {};

  const applyOptionSelection = (el: HTMLElement) => {
    const params = spanOf(el);
    for (const { key, op, val } of params.stateAssignments ?? []) {
      if (op === 'delete') rn.state.delete(key);
      else if (op === 'set') rn.state.set(key, resolveStateVal(val, rn.state));
      else rn.state.declare(key, resolveStateVal(val, rn.state));
    }
    if (params.transclude) {
      void expandNode(rn, params.transclude);
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
          applyEventAttr(spanOf(_prevEl)['on-deselect'], rn);
          applyEventAttr(spanOf(_prevEl)['on-blur'],     rn);
        }
        applyOptionSelection(el);
        applyEventAttr(spanOf(el)['on-select'], rn);
        applyEventAttr(spanOf(el)['on-focus'],  rn);
        _prevEl = el;
        if (scrollOnSelect) {
          const elRect        = el.getBoundingClientRect();
          const containerRect = optionContainer.getBoundingClientRect();
          optionContainer.scrollTop +=
            (elRect.top - containerRect.top) - (optionContainer.clientHeight / 2 - el.clientHeight / 2);
        }
      },
      onActivate(_idx, el) {
        applyEventAttr(spanOf(el)['on-action'], rn);
        if (el.tagName === 'A') (el as HTMLAnchorElement).click();
      },
      onReset() {
        if (_prevEl) {
          applyEventAttr(spanOf(_prevEl)['on-deselect'], rn);
          applyEventAttr(spanOf(_prevEl)['on-blur'],     rn);
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
  const defaultIdx = options.findIndex(el => (el as any)._rvmarkSpan?.selected);
  if (defaultIdx !== -1) nav.select(defaultIdx);

  if (volatile) {
    navRoot.addEventListener('rvmark-deselect', () => {
      if (nav.activeIdx() !== -1) nav.reset();
    });
  }

  return nav;
}

export function isListbox(
  attrs: Multimap,
  spanMap: Map<number, ParsedSpanAttrs>,
): boolean {
  return attrs.has('listbox') ||
    [...spanMap.values()].some(s => s.option || s.stateAssignments?.length || s.transclude);
}
