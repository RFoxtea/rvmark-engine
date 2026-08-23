/**
 * listbox.ts
 *
 * Shared ARIA listbox navigation model used by:
 *   - inline option spans in label text ({option} span attr)
 *
 * Implements the ARIA listbox interaction pattern using aria-activedescendant:
 *   - The listbox container (or owning .node-content) is the single Tab stop
 *   - Options have unique IDs; aria-activedescendant on the listbox points to the active one
 *   - No DOM focus moves to options; all keyboard events handled on .node-content
 *   - ArrowLeft/Right cycle the active option; all other keys handled by tree nav as normal
 *   - Enter/Space activate the focused option
 *
 * Usage:
 *   const nav = createListboxNav(content, listboxEl, getOptions, { onSelect, onActivate, onReset });
 *   nav.wireOption(el)   — register an option element (assigns id if needed)
 *   nav.next()           — select next
 *   nav.prev()           — select prev (returns false if already at start, for fallthrough)
 *   nav.select(idx)      — programmatically select
 *   nav.reset()          — deselect all
 *   nav.activeIdx()      — current index (-1 if none)
 *   nav.activate()       — activate current option (Enter/Space); false if the
 *                          option had no action, so the caller can fall through
 */

let _rvmarkOptionCounter = 0;

// onActivate returns whether the option actually did something. An option with
// no action of its own reports false, and the gesture falls through to the
// node — so Enter on a targetless highlight span still reaches the node's own
// Enter behaviour instead of being swallowed by the listbox.
/** How a selection was made. A click already has the option under the pointer,
 *  so it needs no scroll to reveal it; a key or a programmatic select does. */
export type SelectSource = 'click' | 'key';

interface ListboxCallbacks {
  onSelect?:   (idx: number, el: HTMLElement, source: SelectSource) => void;
  onActivate?: (idx: number, el: HTMLElement) => boolean | void;
  onReset?:    () => void;
  /** No no-option state: reset() is refused and ArrowLeft off the first option
   *  falls through instead of clearing. The caller is responsible for selecting
   *  one option up front — see wireListbox. */
  nonempty?:   boolean;
}

export function createListboxNav(
  content:    HTMLElement,
  listboxEl:  HTMLElement,
  getOptions: () => HTMLElement[],
  { onSelect, onActivate, onReset, nonempty }: ListboxCallbacks = {},
) {
  let activeIdx = -1;

  function options() { return getOptions(); }

  function setActive(idx: number, source: SelectSource = 'key') {
    const opts = options();
    opts.forEach((el, i) => el.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
    activeIdx = idx;
    if (idx >= 0) {
      listboxEl.setAttribute('aria-activedescendant', opts[idx].id);
      onSelect?.(idx, opts[idx], source);
    } else {
      listboxEl.removeAttribute('aria-activedescendant');
    }
  }

  // A nonempty listbox has no no-option state, so every route to it is refused
  // here rather than at each call site — the bullet, the block's border strip,
  // ArrowLeft off the first option, and the volatile deselect all funnel through
  // reset(), and a guard in one of them would leave the others open.
  function reset() {
    if (nonempty) return;
    options().forEach(el => el.setAttribute('aria-selected', 'false'));
    listboxEl.removeAttribute('aria-activedescendant');
    activeIdx = -1;
    onReset?.();
  }

  function next(): boolean {
    const opts = options();
    if (!opts.length) return false;
    if (activeIdx < opts.length - 1) { setActive(activeIdx + 1); return true; }
    return false;
  }

  function prev(): boolean {
    const opts = options();
    if (!opts.length) return false;
    if (activeIdx > 0)   { setActive(activeIdx - 1); return true; }
    // ArrowLeft off the first option clears the selection — unless there is no
    // such state, in which case the key was not consumed and falls through to
    // its ordinary meaning (collapse, or move to the parent).
    if (activeIdx === 0 && !nonempty) { reset(); return true; }
    return false;
  }

  // True when the active option consumed the gesture. No active option, or an
  // option with nothing of its own to run, is a miss — the caller then treats
  // the key as unhandled and lets the node act on it.
  function activate(): boolean {
    const opts = options();
    if (activeIdx < 0) return false;
    return onActivate?.(activeIdx, opts[activeIdx]) === true;
  }

  function wireOption(el: HTMLElement) {
    if (!el.id) el.id = `rvmark-option-${++_rvmarkOptionCounter}`;
    el.setAttribute('aria-selected', 'false');
    el.setAttribute('data-rvmark-option', '');

    el.addEventListener('click', () => {
      const opts = options();
      const i = opts.indexOf(el);
      if (i === -1) return;
      const isNativeLink = el.tagName === 'A' && (el as HTMLAnchorElement).href;
      if (i === activeIdx) {
        if (!isNativeLink) onActivate?.(activeIdx, el);
      } else {
        setActive(i, 'click');
        if (!isNativeLink) onActivate?.(i, el);
      }
      content.focus();
    });
  }

  return { wireOption, select: setActive, next, prev, reset, activate, activeIdx: () => activeIdx };
}

export type ListboxNav = ReturnType<typeof createListboxNav>;
