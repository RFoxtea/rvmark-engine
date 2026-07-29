/**
 * search.ts
 *
 * A small search widget scoped to {searchable} subtrees. Overloads Ctrl+F:
 * the first press focuses this widget instead of native find; a second
 * press (while already focused) falls through to the browser's own find.
 *
 * Matching runs over SourceNode structure (the authored tree — not
 * transclusion, not exhibits, not the DOM), so it can see into subtrees that
 * haven't been mounted yet. It never mounts or expands anything on its own.
 *
 * Mounted matches get a native-find-style highlight: every match is wrapped
 * in a <mark class="search-mark">, one consistent color — there is no
 * separate "current match" tint tied to selection, since stepping to a
 * result (Enter/Shift+Enter) just moves ordinary tree selection
 * (RenderNode.setSelection), and selection can change for reasons unrelated
 * to search (e.g. clicking elsewhere), so marks don't react to it.
 * Highlighting wraps the matched substring within a node's rendered
 * .node-label text; a match that spans an inline formatting boundary (e.g.
 * part bold, part not) still counts as a match but isn't wrapped, since
 * splitting across element boundaries safely would mean reimplementing a
 * layout-aware algorithm — accepted imprecision, same as everywhere else
 * this feature touches raw vs. rendered text.
 *
 * A match inside an unmounted node only marks its nearest mounted ancestor
 * with a "contains a match below" indicator (.search-indicator), leaving
 * expansion to the reader — search never mounts or expands anything.
 *
 * Typing alone never moves selection — only committing to a result
 * (Enter/Shift+Enter) does. Escape only returns focus to wherever it was
 * before activation; it does not hide the widget or clear results/marks.
 * Clearing the query text is what hides the widget again.
 */

import type { SourceNode } from './parser.js';
import type { SourceFile } from './source-file.js';
import { isSearchable, RenderNode } from './render-node.js';

interface SearchMatch {
  node:    SourceNode;
  li:      HTMLElement | null; // the mounted <li class="node"> for this SourceNode, if any
}

// ── Matching ──────────────────────────────────────────────────────────────────

function nodeTextMatches(node: SourceNode, needle: string): boolean {
  if (node.label && node.label.toLowerCase().includes(needle)) return true;
  return node.bodyLines.some(line => line.toLowerCase().includes(needle));
}

// Map every currently-mounted SourceNode to its <li>, in one DOM pass.
function mountedNodes(): Map<SourceNode, HTMLElement> {
  const map = new Map<SourceNode, HTMLElement>();
  for (const li of document.querySelectorAll<HTMLElement>('li.node')) {
    const rn = (li as any)._renderNode;
    if (rn?.sourceNode) map.set(rn.sourceNode, li);
  }
  return map;
}

function searchTree(roots: SourceNode[], query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const mounted = mountedNodes();
  const out: SearchMatch[] = [];
  // A node is in scope if it (or its file) carries {searchable} itself, or
  // an ancestor's {searchable} already covers this whole subtree.
  const walk = (node: SourceNode, inScope: boolean) => {
    const scope = inScope || isSearchable(node);
    if (!scope) { for (const child of node.children) walk(child, false); return; }
    if (nodeTextMatches(node, needle)) out.push({ node, li: mounted.get(node) ?? null });
    for (const child of node.children) walk(child, true);
  };
  roots.forEach(node => walk(node, false));
  return out;
}

function anySearchable(roots: SourceNode[]): boolean {
  return roots.some(function check(node): boolean {
    if (isSearchable(node)) return true;
    return node.children.some(check);
  });
}

// SourceNode has no parent pointer, so "does this collapsed node's subtree
// contain a match" is computed in the same top-down walk that visits every
// node, rather than by climbing from a match upward.
interface WalkResult {
  ownMatch: boolean;      // this node's own text matched
  hasDescendantMatch: boolean;
}

function markIndicators(roots: SourceNode[], query: string): void {
  const needle = query.trim().toLowerCase();
  const mounted = mountedNodes();

  const walk = (node: SourceNode, inScope: boolean): WalkResult => {
    const scope = inScope || isSearchable(node);
    if (!scope) {
      for (const child of node.children) walk(child, false);
      return { ownMatch: false, hasDescendantMatch: false };
    }
    const ownMatch = needle.length > 0 && nodeTextMatches(node, needle);
    let hasDescendantMatch = false;
    for (const child of node.children) {
      const r = walk(child, true);
      if (r.ownMatch || r.hasDescendantMatch) hasDescendantMatch = true;
    }

    const li = mounted.get(node);
    if (li) {
      // Only collapsed nodes need the indicator, and only for matches
      // hidden inside their (currently unmounted) children — the node's own
      // label stays visible even while collapsed (collapse only hides
      // .node-children), so its own match already gets a real .search-mark
      // regardless. ownMatch must not suppress the indicator: a node can
      // both match itself AND have a separate match hidden below it.
      const content = li.querySelector<HTMLElement>(':scope > .node-content');
      const collapsed = content?.getAttribute('aria-expanded') === 'false';
      setIndicator(content, collapsed && hasDescendantMatch);
    }

    return { ownMatch, hasDescendantMatch };
  };

  roots.forEach(node => walk(node, false));
}

// The breadcrumb dot is a real sibling element next to .toggle, not a
// pseudo-element on it — .toggle already owns an ::after (the "expandable"
// subscript badge on custom-bullet/{.li} nodes) and gets rotated when
// expanded, and a marker anchored via .toggle::after would collide with
// that badge and spin along with the bullet. A sibling shares neither.
function setIndicator(content: HTMLElement | null | undefined, show: boolean): void {
  if (!content) return;
  const toggle = content.querySelector<HTMLElement>(':scope > .toggle');
  let dot = content.querySelector<HTMLElement>(':scope > .search-indicator');
  if (show && !dot) {
    dot = document.createElement('span');
    dot.className = 'search-indicator';
    toggle?.after(dot);
  } else if (!show && dot) {
    dot.remove();
  }
}

function clearIndicators(): void {
  document.querySelectorAll('.search-indicator').forEach(el => el.remove());
}

// ── Substring highlighting (native-find-style marks) ──────────────────────────

// Undo previous wraps: merge each mark's text back into the surrounding text
// and normalize, so re-searching never compounds marks or leaves fragments.
function clearMarks(): void {
  for (const mark of document.querySelectorAll<HTMLElement>('.search-mark')) {
    const parent = mark.parentNode;
    mark.replaceWith(mark.textContent ?? '');
    parent?.normalize();
  }
}

// Wrap every occurrence of needle within a single text node in <mark
// class="search-mark">. Matches that span multiple text nodes (i.e. cross an
// inline element boundary) are not wrapped — see file header.
function markTextNode(textNode: Text, needle: string): void {
  const text = textNode.textContent ?? '';
  const lower = text.toLowerCase();
  let from = 0;
  let idx: number;
  const ranges: Array<[number, number]> = [];
  while ((idx = lower.indexOf(needle, from)) !== -1) {
    ranges.push([idx, idx + needle.length]);
    from = idx + needle.length;
  }
  if (!ranges.length) return;

  const parent = textNode.parentNode;
  if (!parent) return;
  let cursor = 0;
  const frag = document.createDocumentFragment();
  for (const [start, end] of ranges) {
    if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement('mark');
    mark.className = 'search-mark';
    mark.textContent = text.slice(start, end);
    frag.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  parent.replaceChild(frag, textNode);
}

function markMatchesIn(li: HTMLElement, needle: string): void {
  const label = li.querySelector<HTMLElement>(':scope > .node-content .node-label');
  if (!label) return;
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  for (const tn of textNodes) markTextNode(tn, needle);
}

function applyMarks(results: SearchMatch[], needle: string): void {
  for (const match of results) {
    if (match.li) markMatchesIn(match.li, needle);
  }
}

// ── Widget state ──────────────────────────────────────────────────────────────

let _sourceFile:      SourceFile | null = null;
let _widget:          HTMLElement | null = null;
let _input:           HTMLInputElement | null = null;
let _resultLabel:     HTMLElement | null = null;
let _results:         SearchMatch[] = [];
// Index into _results of the match last stepped to via Enter/Shift+Enter —
// not "the first match," and not updated by typing alone.
let _steppedIndex:    number = -1;
let _preActivationFocus: HTMLElement | null = null;

// Recompute matches/indicators/marks for the current query, keeping
// _steppedIndex (and therefore selection) untouched — used when the tree's
// shape changes under an unchanged query (see refreshForTreeChange below).
function recomputeResults(): void {
  clearIndicators();
  clearMarks();

  if (!_sourceFile) { _results = []; updateResultLabel(); return; }
  const query = _input?.value ?? '';
  const needle = query.trim().toLowerCase();
  _results = searchTree(_sourceFile.roots, query);
  markIndicators(_sourceFile.roots, query);
  if (needle) applyMarks(_results, needle);
  updateResultLabel();
}

// Recompute for a new query (typing). Unlike recomputeResults, this resets
// _steppedIndex — a new query has no "current" match yet until the reader
// steps to one.
function applyResults(): void {
  _steppedIndex = -1;
  recomputeResults();
}

// The tree's mounted shape (expand/collapse, show-when) can change without
// the query changing at all — re-run matching/marking so newly-mounted
// content is covered and no-longer-mounted content's marks are cleared.
// Global rerun rather than diffing the changed subtree: cost is bounded by
// however much is currently mounted (only what the reader has expanded),
// not by document size, so scoping it would save little for real added
// complexity. Selection/_steppedIndex are left alone — a shape change is
// not the reader committing to a different result.
function refreshForTreeChange(): void {
  if (!_input?.value.trim()) return; // nothing to refresh without a query
  recomputeResults();
}

function updateResultLabel(): void {
  if (!_resultLabel) return;
  if (!_input?.value.trim()) { _resultLabel.textContent = ''; return; }
  const mountedCount = _results.filter(r => r.li).length;
  if (!_results.length) { _resultLabel.textContent = 'No matches'; return; }
  _resultLabel.textContent = mountedCount
    ? `${_steppedIndex + 1 <= 0 ? 0 : _steppedIndex + 1} of ${mountedCount} visible`
    : `${_results.length} below — expand to view`;
}

// Step to the next/previous mounted match and select it exactly as a click
// would (RenderNode.setSelection + focus) — there is no separate "search
// result" visual state, a stepped-to match just becomes the selection.
// Marks themselves don't change appearance based on which one this is —
// that would make them shift color as a side effect of selection changing
// for any other reason (e.g. clicking elsewhere in the tree).
function stepActive(dir: 1 | -1): void {
  const mountedIdxs = _results.map((r, i) => r.li ? i : -1).filter(i => i >= 0);
  if (!mountedIdxs.length) return;
  const curPos = mountedIdxs.indexOf(_steppedIndex);
  const nextPos = curPos === -1
    ? (dir === 1 ? 0 : mountedIdxs.length - 1)
    : (curPos + dir + mountedIdxs.length) % mountedIdxs.length;
  _steppedIndex = mountedIdxs[nextPos];
  updateResultLabel();

  const match = _results[_steppedIndex];
  const rn: RenderNode | undefined = (match?.li as any)?._renderNode;
  if (rn) {
    RenderNode.setSelection(rn);
    rn.contentEl.focus();
  }
}

// ── Widget DOM ────────────────────────────────────────────────────────────────

function buildWidget(): HTMLElement {
  const widget = document.createElement('div');
  widget.className = 'search-widget';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.placeholder = 'Find in page…';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search this page');
  widget.appendChild(input);

  const resultLabel = document.createElement('span');
  resultLabel.className = 'search-result-label';
  widget.appendChild(resultLabel);

  input.addEventListener('input', () => {
    applyResults();
    updateVisibility();
  });

  // Captured on every focus-in, not just the first Ctrl+F — the input can
  // regain focus later (e.g. clicking back into it after Enter moved focus
  // into the tree), and Escape should always return to wherever focus was
  // immediately before that, not to a stale one-time snapshot.
  //
  // relatedTarget can be <body> (or null) rather than something meaningful —
  // e.g. pressing Ctrl+F as the very first action on a freshly-loaded page,
  // before anything has been deliberately focused. body.focus() is a no-op,
  // which would make Escape look broken. In that case, "return to the tree"
  // means the currently selected row, if there is one.
  input.addEventListener('focusin', (e: FocusEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related && related !== document.body) _preActivationFocus = related;
    else _preActivationFocus = RenderNode.currentSelection?.contentEl ?? _preActivationFocus;
  });

  // Losing focus with an empty query hides the widget; losing focus with
  // text still in it (e.g. after Enter moves focus into the tree) does not.
  input.addEventListener('focusout', () => updateVisibility());

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepActive(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Only return focus — the widget, its query, its marks and indicators
      // all stay exactly as they were. Clearing the query is what hides it.
      _preActivationFocus?.focus();
    }
  });

  _input = input;
  _resultLabel = resultLabel;
  return widget;
}

// Visible whenever there's a query to show results for, or the input itself
// is focused (so it's visible to type into right after Ctrl+F, before any
// query exists yet).
function updateVisibility(): void {
  if (!_widget) return;
  const visible = isWidgetFocused() || !!_input?.value;
  _widget.classList.toggle('search-widget--active', visible);
}

function activate(): void {
  if (!_widget) return;
  // _preActivationFocus is captured by the input's own focusin listener
  // (fires below, from .focus()) — not set here, so it stays correct
  // whenever the input regains focus later too, not just on first Ctrl+F.
  // Must show the widget before focusing — a display:none input silently
  // refuses focus (no error, focus just stays wherever it was).
  _widget.classList.add('search-widget--active');
  _input?.focus();
  _input?.select();
}

function isWidgetFocused(): boolean {
  return !!_input && document.activeElement === _input;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSearch(sourceFile: SourceFile): void {
  _sourceFile = sourceFile;
  if (!anySearchable(sourceFile.roots)) return; // nothing in scope — stay a no-op

  const anchor = document.getElementById('search-root');
  if (!anchor) return;

  _widget = buildWidget();
  anchor.appendChild(_widget);

  const header = anchor.closest('header');
  if (header && 'IntersectionObserver' in window) {
    new IntersectionObserver(
      ([entry]) => anchor.classList.toggle('search-root--floating', !entry.isIntersecting),
      { threshold: 0 },
    ).observe(header);
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const isFindShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f';
    if (!isFindShortcut) return;
    if (isWidgetFocused()) return; // let the second press through to native find
    e.preventDefault();
    activate();
  });

  observeTreeShape();
}

// Expand/collapse (aria-expanded flips on existing DOM) and mount/unmount
// (show-when, first-time expand) both change what's currently searchable —
// re-run matching whenever either happens. Ignores mutations to our own
// .search-mark/.search-indicator elements so recomputeResults()'s own DOM
// writes don't retrigger themselves.
function observeTreeShape(): void {
  const treeRoot = document.getElementById('tree-root');
  if (!treeRoot) return;

  let pending = false;
  const scheduleRefresh = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; refreshForTreeChange(); });
  };

  // Our own writes only ever happen inside .node-label (mark wrapping) or as
  // .search-indicator siblings of .toggle — anything there is our own
  // recompute, not a real tree-shape change, so it's excluded to avoid
  // retriggering ourselves.
  const isOwnWrite = (node: Node): boolean => {
    const el = node instanceof HTMLElement ? node : node.parentElement;
    return !!el?.closest('.node-label, .search-indicator');
  };

  new MutationObserver((mutations) => {
    const relevant = mutations.some(m => {
      if (m.type === 'attributes') {
        return m.attributeName === 'aria-expanded' && !isOwnWrite(m.target);
      }
      // childList: a real tree mount/unmount touches .node-children/.tree,
      // never .node-label — our own writes are always inside .node-label.
      if (isOwnWrite(m.target)) return false;
      return true;
    });
    if (relevant) scheduleRefresh();
  }).observe(treeRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
}
