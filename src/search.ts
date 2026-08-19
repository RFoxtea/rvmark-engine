/**
 * search.ts
 *
 * A small search widget, present on every interactive page. Overloads Ctrl+F:
 * the first press focuses this widget instead of native find; a second
 * press (while already focused) falls through to the browser's own find.
 *
 * Matching starts from the mounted tree and reads SourceNode structure from
 * there. Driving it from the DOM rather than from the page file's roots is
 * what makes it work on mixed pages: transcluded content belongs to another
 * SourceFile and never appears in the page file's roots, but it is mounted.
 *
 * {searchable} does not switch search on. Everywhere, search matches and
 * highlights what is rendered — like a browser's own find-in-page. Under
 * {searchable}, matching additionally descends into authored-but-unrendered
 * children, which is what produces the breadcrumb dots below. It never mounts
 * or expands anything on its own.
 *
 * Scope is a property of the source tree, not of the DOM: {searchable} is
 * inherited to descendants at parse time (markSearchable in parser.ts, next to
 * meta), and isSearchable is a plain lookup on the SourceNode. Deriving scope
 * from rendered ancestors instead is wrong in the common case — the node
 * carrying the attribute is usually a root, and a root is not itself a row on
 * the page, so nothing would ever be in scope and no dot could ever appear.
 *
 * Mounted matches get a native-find-style highlight: every match is wrapped
 * in a <mark class="search-mark">, one consistent color — there is no
 * separate "current match" tint tied to selection, since stepping to a
 * result (Enter/Shift+Enter) just moves ordinary tree selection
 * (RenderNode.setSelection), and selection can change for reasons unrelated
 * to search (e.g. clicking elsewhere), so marks don't react to it.
 * Highlighting wraps the matched substring anywhere in a node's own rendered
 * .node-content — .node-label, a block's .block-body, or table/tr .tr-cells,
 * since a row's visible text does not all live in .node-label. A match that
 * spans an inline formatting boundary (e.g. part bold, part not) still counts
 * as a match but isn't wrapped, since splitting across element boundaries
 * safely would mean reimplementing a layout-aware algorithm — accepted
 * imprecision, same as everywhere else this feature touches raw vs. rendered
 * text.
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
import { resolveAttrs } from './source-file.js';
import { isSearchable, RenderNode } from './render-node.js';
import { scrollRowIntoMiddle } from './scroll.js';
import { mountSearchRoot } from './shell.js';
import { resolveTagDef } from './tags.js';
import { resolveSlugInFile } from './shared.js';
import { nodeTextMatches, tagDisplayText } from './origin.js';

interface SearchMatch {
  node:    SourceNode;
  li:      HTMLElement | null; // the mounted <li class="node"> for this SourceNode, if any
}

// ── Matching ──────────────────────────────────────────────────────────────────

// The text a tag actually puts on screen, or null if it renders no chip.
// Mirrors buildTagChips: `internal` tags (including the automatic ones on
// dot-prefixed names like .minor) render nothing, and a `label` prop replaces
// the tag's name as the visible text. Search matches what the reader can see,
// so it has to apply the same two rules rather than looking at tag.name —
// otherwise queries would hit invisible styling tags and miss relabelled ones.
// Map every currently-mounted SourceNode to its <li>, in one DOM pass.
function mountedNodes(): Map<SourceNode, HTMLElement> {
  const map = new Map<SourceNode, HTMLElement>();
  for (const li of document.querySelectorAll<HTMLElement>('li.node')) {
    const rn = (li as any)._renderNode;
    if (rn?.sourceNode) map.set(rn.sourceNode, li);
  }
  return map;
}

// Search always works over what is actually rendered — matching starts from
// the mounted tree, not from any one file's roots. That is what makes it work
// on a mixed page like a site index: transcluded content belongs to a
// different SourceFile entirely and never appears in the page file's roots,
// but it is mounted, so the DOM sees it.
//
// {searchable} is not a switch that turns search on. It licenses the *deep*
// walk: descending past what is mounted into authored-but-unrendered children,
// which is what produces the "match below — expand to view" breadcrumb dots.
// Without it, a node contributes only itself, exactly like a browser's own
// find-in-page. With it, its whole authored subtree becomes reachable.
//
// Unresolved transclusion hosts are a hard limit either way: their children do
// not exist until they resolve, so nothing can see into them. Consistent with
// search never mounting or expanding anything on its own.
// A same-file `{=> #id}` target, or null when the ref is cross-file or
// unresolvable. Transclusion hosts are otherwise opaque to search: their
// children do not exist until they resolve at expand time, so the deep walk
// would stop at the host and miss content that is authored, addressable, and
// — once expanded — visible. Resolving the local case is a synchronous nodeMap
// lookup (no fetch, nothing mounted), which keeps the "search never mounts or
// expands anything" contract intact.
//
// Deliberately local-only for now: a cross-file ref would need its file loaded,
// and a miss there is indistinguishable from a broken ref.
function localTranscludeTarget(node: SourceNode): SourceNode | null {
  const attrs = resolveAttrs(node);
  const raw = attrs.get('transclude');
  // Only a single bare `#id`. A list, a `*`, or any path-bearing ref is
  // cross-file or children-mode and out of scope here.
  if (!raw || !raw.startsWith('#') || raw.includes(',')) return null;
  const sf = node.sourceFile;
  if (!sf) return null;
  return resolveSlugInFile({ nodeMap: sf.nodeMap, roots: sf.roots }, raw.slice(1))?.node ?? null;
}

function searchTree(query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const mounted = mountedNodes();
  const out: SearchMatch[] = [];
  const seen = new Set<SourceNode>();

  const record = (node: SourceNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (nodeTextMatches(node, needle)) out.push({ node, li: mounted.get(node) ?? null });
  };

  // Descend into authored children — only reached under a {searchable} scope.
  // `activeRefs` guards the transclusion hops: transclusions may be recursive
  // (the tree is really a graph), so a ref already being walked on this path is
  // skipped rather than followed into an infinite regress.
  const walkDeep = (node: SourceNode, activeRefs: Set<SourceNode>) => {
    record(node);
    for (const child of node.children) walkDeep(child, activeRefs);

    const target = localTranscludeTarget(node);
    if (target && !activeRefs.has(target)) {
      activeRefs.add(target);
      walkDeep(target, activeRefs);
      activeRefs.delete(target);
    }
  };

  for (const [node] of mounted) {
    record(node);
    // A mounted node's own children may themselves be mounted (visited by this
    // same loop) or not (only reachable here, and only when licensed).
    // isSearchable already accounts for ancestry — {searchable} is inherited
    // down the source tree at parse time — so no ancestor walk is needed, and
    // in particular scope does not depend on the node that carries the
    // attribute being rendered. It usually isn't: it is typically a root, and
    // roots are not themselves rows on the page.
    if (isSearchable(node)) {
      for (const child of node.children) walkDeep(child, new Set([node]));
      // The mounted node may itself be an unexpanded transclusion host.
      const target = localTranscludeTarget(node);
      if (target) walkDeep(target, new Set([node, target]));
    }
  }
  return out;
}

// Mounted nodes whose subtree contains a hidden (unmounted) match — the ones
// eligible for a breadcrumb dot once also collapsed. Shared by markIndicators
// (which draws the dot) and stepTargets (which also treats these as stepping
// stops, in document order alongside real .search-marks — see stepTargets).
function nodesWithHiddenMatch(results: SearchMatch[]): Map<SourceNode, HTMLElement> {
  const mounted = mountedNodes();
  const out = new Map<SourceNode, HTMLElement>();

  // Matched nodes that are not themselves mounted — the ones a reader cannot
  // see. Anything mounted is already visible (and marked), so it needs no dot.
  const hiddenMatches = new Set(results.filter(r => !r.li).map(r => r.node));
  if (!hiddenMatches.size) return out;

  // Mirrors searchTree's walk, transclusion hop included: a match reached only
  // through a `{=> #id}` still needs the host to carry the dot, or it would be
  // counted as a result with nothing on screen pointing at it.
  const containsHidden = (node: SourceNode, activeRefs: Set<SourceNode>): boolean => {
    for (const child of node.children) {
      if (hiddenMatches.has(child) || containsHidden(child, activeRefs)) return true;
    }
    const target = localTranscludeTarget(node);
    if (target && !activeRefs.has(target)) {
      activeRefs.add(target);
      const hit = hiddenMatches.has(target) || containsHidden(target, activeRefs);
      activeRefs.delete(target);
      if (hit) return true;
    }
    return false;
  };

  for (const [node, li] of mounted) {
    if (containsHidden(node, new Set([node]))) out.set(node, li);
  }
  return out;
}

// Breadcrumb dots are the visible half of {searchable}: they mark a collapsed
// mounted node whose hidden subtree contains a match. Only mounted nodes can
// carry one, so this is driven from the mounted set (the same reason
// searchTree is — a page's own file roots cannot see transcluded content).
//
// A node's own match never warrants a dot: a collapsed node still shows its
// own label, so its match already gets a real .search-mark. Only matches
// strictly below the collapse point are hidden and need announcing — and a
// node can both match itself and hide a separate match below.
function markIndicators(results: SearchMatch[], query: string): void {
  const needle = query.trim().toLowerCase();
  if (!needle) return;

  const withHidden = nodesWithHiddenMatch(results);
  for (const [node, li] of mountedNodes()) {
    const content = li.querySelector<HTMLElement>(':scope > .node-content');
    const collapsed = content?.getAttribute('aria-expanded') === 'false';
    setIndicator(li, collapsed && withHidden.has(node));
  }
}

// The breadcrumb dot always goes inside .toggle — one placement for every node
// type, so a single CSS rule positions it (see .toggle > .search-indicator).
//
// .toggle is the only element every layout agrees on: it is always exactly
// --bullet-w wide with its bullet centred, so a fixed offset within it is
// stable no matter which glyph the node uses. Positioning against anything
// outside it does not generalise — .tr-row and the table's children container
// are display: contents, so a table row's .node generates no box at all, and a
// dot positioned against it escapes to the table's grid container and lands
// beside the header instead of on its own row.
//
// It is a real element rather than a .toggle::after pseudo-element because
// .toggle already owns its ::after (the "expandable" subscript badge on
// custom-bullet/{.li} nodes).
//
// The toggle itself sits inside .node-content for ordinary nodes but directly
// on the <li> for table/tr rows, so both spots are checked to find it.
function setIndicator(li: HTMLElement, show: boolean): void {
  const content = li.querySelector<HTMLElement>(':scope > .node-content');
  const toggle = content?.querySelector<HTMLElement>(':scope > .toggle')
              ?? li.querySelector<HTMLElement>(':scope > .toggle');
  let dot = toggle?.querySelector<HTMLElement>(':scope > .search-indicator') ?? null;

  if (show && !dot) {
    if (!toggle) return; // nothing to anchor to
    dot = document.createElement('span');
    dot.className = 'search-indicator';
    toggle.appendChild(dot);
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

// Marks are scoped to the node's own .node-content — not just its .node-label.
// A row's visible text does not all live in .node-label: block bodies render
// into a sibling .block-body, and table/tr rows have no .node-label at all (their
// cells are .tr-cell children of .node-content). Walking .node-content covers
// all three, and the `:scope >` keeps it to this node's own row — descendant
// rows are separate <li>s and get marked from their own SearchMatch.
// .search-indicator is skipped: it is our own injected element, not content.
function markMatchesIn(li: HTMLElement, needle: string): void {
  const content = li.querySelector<HTMLElement>(':scope > .node-content');
  if (!content) return;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n: Node) =>
      (n.parentElement?.closest('.search-indicator'))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
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

let _widget:          HTMLElement | null = null;
let _input:           HTMLInputElement | null = null;
let _status:          HTMLElement | null = null;
let _results:         SearchMatch[] = [];
let _preActivationFocus: HTMLElement | null = null;

// Recompute matches/indicators/marks for the current query. Selection is left
// untouched — stepActive derives its position from the live tree selection
// (RenderNode.currentSelection) rather than any state tracked here, so there
// is nothing else to reset or preserve across a recompute.
function recomputeResults(): void {
  clearIndicators();
  clearMarks();

  const query = _input?.value ?? '';
  const needle = query.trim().toLowerCase();
  _results = searchTree(query);
  markIndicators(_results, query);
  if (needle) applyMarks(_results, needle);
  updateResultState();
}

// Recompute for a new query (typing).
function applyResults(): void {
  recomputeResults();
}

// The tree's mounted shape (expand/collapse, show-when) can change without
// the query changing at all — re-run matching/marking so newly-mounted
// content is covered and no-longer-mounted content's marks are cleared.
// Global rerun rather than diffing the changed subtree: cost is bounded by
// however much is currently mounted (only what the reader has expanded),
// not by document size, so scoping it would save little for real added
// complexity. Selection is left alone — a shape change is not the reader
// committing to a different result.
function refreshForTreeChange(): void {
  if (!_input?.value.trim()) return; // nothing to refresh without a query
  recomputeResults();
}

// Zero matches is signalled by dimming the query text itself, not by a label.
// Matches are shown in place (marks, breadcrumb dots), so their absence is
// most legible in the same place the reader is already looking — their own
// query — and it needs no reading. Deliberately not a count: any count would
// be either over mounted matches (which shifts as the reader expands or
// collapses, for reasons unrelated to the query) or over all matches (a number
// that can't be reconciled with the marks actually on screen).
function updateResultState(): void {
  if (!_input) return;
  const empty = !!_input.value.trim() && !_results.length;
  _input.classList.toggle('search-input--no-matches', empty);
  if (_status) _status.textContent = empty ? 'No matches' : '';
}

// Rows Enter/Shift+Enter can land on: every mounted match's <li>, plus every
// collapsed ancestor carrying a breadcrumb dot (nodesWithHiddenMatch) — a dot
// means a match exists below that the reader cannot otherwise reach without
// first finding and expanding that exact row, so stepping treats it as a stop
// in its own right rather than only ever landing on real .search-marks.
// Deduplicated and put in document order (mountedNodes() preserves
// querySelectorAll order) since a direct match and a dot can interleave freely
// — e.g. a collapsed node can itself match *and* hide a further match below.
function stepTargets(results: SearchMatch[]): HTMLElement[] {
  const ordered = mountedNodes();
  const withHidden = nodesWithHiddenMatch(results);
  const direct = new Set(results.filter(r => r.li).map(r => r.node));
  const out: HTMLElement[] = [];
  for (const [node, li] of ordered) {
    if (direct.has(node)) { out.push(li); continue; }
    // Only a node that's *actually showing* a dot right now is a target —
    // matching markIndicators' own condition. An expanded ancestor in
    // withHidden has no dot (its hidden descendant may since have been
    // mounted, or a still-collapsed descendant carries the dot instead), so
    // stepping onto it would be a stop with nothing to show for it.
    const content = li.querySelector<HTMLElement>(':scope > .node-content');
    const collapsed = content?.getAttribute('aria-expanded') === 'false';
    if (collapsed && withHidden.has(node)) out.push(li);
  }
  return out;
}

// Step to the next/previous target and select it exactly as a click would
// (RenderNode.setSelection) — there is no separate "search result" visual
// state, a stepped-to row just becomes the selection. Marks themselves don't
// change appearance based on which one this is — that would make them shift
// color as a side effect of selection changing for any other reason (e.g.
// clicking elsewhere in the tree).
//
// Deliberately does not move DOM focus to the row (unlike a plain click,
// which focuses via focusin): Enter is typed from the search input, and
// stepping through results should keep it focused so the reader can keep
// pressing Enter/Shift+Enter without refocusing the widget. aria-selected
// styling doesn't depend on focus (see .node-content[aria-selected="true"] in
// styles.css), so the row still shows as current; scrollRowIntoMiddle is
// called directly since that scroll normally rides along with focus().
//
// Steps from the *current tree selection*, not from a private bookmark — the
// reader can change selection some other way (e.g. clicking a different row)
// while the widget stays focused, and the next Enter should continue from
// there rather than jumping back to wherever this widget last left off.
//
// The selection is often not itself a target — most notably right after
// expanding a breadcrumb-only stop: that reveals its child as a real match,
// but the just-expanded row drops out of stepTargets entirely (it's neither a
// direct match nor collapsed anymore), while staying selected. So rather than
// requiring an exact match, curPos is "the last target at or before the
// selection" in document order — one rule that covers both cases: an exact
// match is trivially at-or-before itself (yielding its own index), and a
// non-target selection resolves to whatever target precedes it, so stepping
// forward continues on to the next one instead of restarting from the top.
function stepActive(dir: 1 | -1): void {
  const targets = stepTargets(_results);
  if (!targets.length) return;
  const selectionLi = RenderNode.currentSelection?.li ?? null;

  let curPos = -1;
  if (selectionLi) {
    for (let i = 0; i < targets.length; i++) {
      const rel = selectionLi.compareDocumentPosition(targets[i]);
      const targetIsAfter = targets[i] !== selectionLi && !!(rel & Node.DOCUMENT_POSITION_FOLLOWING);
      if (targetIsAfter) break;
      curPos = i;
    }
  }
  const nextPos = curPos === -1
    ? (dir === 1 ? 0 : targets.length - 1)
    : (curPos + dir + targets.length) % targets.length;
  const li = targets[nextPos];

  const rn: RenderNode | undefined = (li as any)._renderNode;
  if (rn) {
    RenderNode.setSelection(rn);
    scrollRowIntoMiddle(rn.contentEl);
  }
}

// ── Widget DOM ────────────────────────────────────────────────────────────────

// A footer chip like any other: the loupe icon (.search-toggle, styled the
// same understated way as the view-menu's ≡) stays put permanently, closed or
// open — opening only reveals the input beside it, never replacing the icon,
// so there's always a stable, permanent affordance to click back into.
// Separated by an actual space character, not CSS spacing (gap/margin) — the
// same mechanism every other gap in this footer uses (chips are joined by
// literal ' · ' text nodes; see mountSearchRoot in shell.ts).
function buildWidget(): HTMLElement {
  const widget = document.createElement('div');
  widget.className = 'search-widget';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'search-toggle';
  toggle.setAttribute('aria-label', 'Search this page');
  toggle.addEventListener('click', () => activate());
  widget.appendChild(toggle);
  widget.appendChild(document.createTextNode(' '));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.placeholder = 'Find in page…';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search this page');
  widget.appendChild(input);

  // The dimmed-input cue is visual only, so the same fact goes to assistive
  // tech through a live region. Visually hidden, not display:none — a
  // display:none region is not announced.
  const status = document.createElement('span');
  status.className = 'search-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  widget.appendChild(status);

  input.addEventListener('input', () => {
    applyResults();
    updateVisibility();
  });

  // Captured on every focus-in, not just the first Ctrl+F — the input can
  // regain focus later (e.g. clicking back into it), and Escape should
  // fall back to wherever focus was immediately before that when there's no
  // current tree selection to prefer instead (see the Escape handler below).
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
  // text still in it (e.g. after Enter selects a match) does not.
  input.addEventListener('focusout', () => updateVisibility());

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepActive(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Only return focus — the widget, its query, its marks and indicators
      // all stay exactly as they were. Clearing the query is what hides it.
      //
      // Prefer the current tree selection over _preActivationFocus: since
      // Enter no longer moves DOM focus (see stepActive), _preActivationFocus
      // stays stuck at whatever was focused before the widget was activated.
      // Reading RenderNode.currentSelection live (rather than the search
      // widget's own stepped-to match) also follows selection changes made
      // some other way — e.g. a click into the tree — while the widget kept
      // focus. Falls back to _preActivationFocus when there's no selection.
      (RenderNode.currentSelection?.contentEl ?? _preActivationFocus)?.focus();
    }
  });

  _input = input;
  _status = status;
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
  // Must add the class before focusing — CSS gates the input's own display on
  // .search-widget--active (see styles.css), and a display:none input
  // silently refuses focus (no error, focus just stays wherever it was).
  _widget.classList.add('search-widget--active');
  _input?.focus();
  _input?.select();
}

function isWidgetFocused(): boolean {
  return !!_input && document.activeElement === _input;
}

// ── Init ──────────────────────────────────────────────────────────────────────

// The widget mounts on every interactive page. It is not gated on {searchable}
// anywhere in the document: search over rendered content works everywhere, and
// {searchable} only adds reach past what is rendered (see searchTree). Gating
// on it made search vanish entirely on mixed pages like a site index, where
// the searchable material arrives by transclusion and so never appears in the
// page file's own roots.
//
// Lives in the footer as an ordinary chip, not the header: the search input
// can be taller than a themed header's own h1 (a compact theme can run its h1
// smaller than the input's line height), and whichever flex child is tallest
// sets that row's height — so opening/closing search used to grow and shrink
// the whole header, shifting every bit of page content below it by a couple
// tenths of a pixel each time. footer sits after #tree-scroll (the flexible
// element that absorbs any size change), so the same growth there only
// nudges the tree's own scrollable height instead of shifting anything.
//
// #search-root doesn't exist in template.html — it's created here and handed
// to shell.ts's mountSearchRoot, which places it as a footer chip (shell.ts
// owns all mutation of footer's children). No IntersectionObserver/floating
// mode: the footer scrolling out of view while reading a long tree is
// accepted (Ctrl+F still activates search from anywhere; there just isn't a
// visible affordance for it while scrolled away from the footer).
export function initSearch(): void {
  const root = document.createElement('div');
  root.id = 'search-root';

  _widget = buildWidget();
  root.appendChild(_widget);
  mountSearchRoot(root);

  // field-sizing: content (styles.css) sizes the input to whatever's actually
  // showing — the placeholder while empty, the typed value once there is one.
  // Typing a single character then makes it visibly narrower than the
  // placeholder it just replaced, since field-sizing only ever measures
  // *current* content, not "whichever of these is wider". min-width pins the
  // floor to the placeholder's own rendered width so it can only grow from
  // there, never shrink below it — measured directly (not a hand-picked ch
  // count) so it can't drift if the placeholder copy ever changes.
  //
  // Done here, after mounting, rather than inside buildWidget: getBoundingClientRect
  // is always a zero rect on a detached element (buildWidget's return value
  // isn't in the document yet), so this needs the real DOM insertion above to
  // have already happened. It also starts display: none (gated on
  // .search-widget--active) — a display:none element reports zero size too,
  // placeholder or not — so visibility: hidden overrides that just for this
  // synchronous measurement, keeping layout without ever painting the
  // placeholder-as-value state the reader would otherwise glimpse.
  if (_input) {
    const input = _input;
    input.style.display = 'inline-block';
    input.style.visibility = 'hidden';
    input.value = input.placeholder;
    input.style.minWidth = `${input.getBoundingClientRect().width}px`;
    input.value = '';
    input.style.removeProperty('display');
    input.style.removeProperty('visibility');
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

  // Our own writes are mark wrapping and the .search-indicator dots — both are
  // recomputes, not real tree-shape changes, so they must not retrigger us.
  // Identified by the injected elements themselves (.search-mark /
  // .search-indicator) rather than by which container they landed in: marks go
  // wherever a node's visible text lives (.node-label, .block-body, .tr-cell …),
  // so a container-based check would silently miss cases and self-retrigger.
  const isOwnWrite = (m: MutationRecord): boolean => {
    const el = m.target instanceof HTMLElement ? m.target : m.target.parentElement;
    if (el?.closest('.search-mark, .search-indicator')) return true;
    // A mark being wrapped/unwrapped shows up as added/removed nodes on the
    // surrounding container; the container itself is ordinary content.
    const touched = [...m.addedNodes, ...m.removedNodes];
    return touched.length > 0 && touched.every(n =>
      n instanceof HTMLElement
        ? n.matches('.search-mark, .search-indicator')
        : n.nodeType === Node.TEXT_NODE); // text left behind by clearMarks()
  };

  new MutationObserver((mutations) => {
    const relevant = mutations.some(m => {
      if (m.type === 'attributes') {
        return m.attributeName === 'aria-expanded' && !isOwnWrite(m);
      }
      // childList: a real tree mount/unmount adds/removes rows and containers,
      // which never look like a pure mark/indicator write.
      return !isOwnWrite(m);
    });
    if (relevant) scheduleRefresh();
  }).observe(treeRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
}
