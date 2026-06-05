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
 *   nav.activate()       — activate current option (Enter/Space)
 */

let _rvmarkOptionCounter = 0;

interface ListboxCallbacks {
  onSelect?:   (idx: number, el: HTMLElement) => void;
  onActivate?: (idx: number, el: HTMLElement) => void;
  onReset?:    () => void;
}

export function createListboxNav(
  content:    HTMLElement,
  listboxEl:  HTMLElement,
  getOptions: () => HTMLElement[],
  { onSelect, onActivate, onReset }: ListboxCallbacks = {},
) {
  let activeIdx = -1;

  function options() { return getOptions(); }

  function setActive(idx: number) {
    const opts = options();
    opts.forEach((el, i) => el.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
    activeIdx = idx;
    if (idx >= 0) {
      listboxEl.setAttribute('aria-activedescendant', opts[idx].id);
      onSelect?.(idx, opts[idx]);
    } else {
      listboxEl.removeAttribute('aria-activedescendant');
    }
  }

  function reset() {
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
    if (activeIdx === 0) { reset(); return true; }
    return false;
  }

  function activate() {
    const opts = options();
    if (activeIdx >= 0) onActivate?.(activeIdx, opts[activeIdx]);
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
        setActive(i);
        if (!isNativeLink) onActivate?.(i, el);
      }
      content.focus();
    });
  }

  return { wireOption, select: setActive, next, prev, reset, activate, activeIdx: () => activeIdx };
}

export type ListboxNav = ReturnType<typeof createListboxNav>;
