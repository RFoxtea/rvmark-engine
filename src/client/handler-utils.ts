/**
 * handler-utils.ts
 *
 * Utilities for TypeHandler implementations.
 * This is the canonical import for type authors — everything a handler needs
 * beyond the RenderNode interface itself.
 *
 * Exports:
 *   buildPermalinkHref — build relative href for a permalink anchor
 *   copyPermalink      — copy absolute permalink to clipboard
 *   treeNavKeydown     — handle positional navigation keys in a handler keydown listener
 */

import { addressToHref } from '../shared/shared.js';
import { scrollRowIntoMiddle } from './scroll.js';
import type { SourceNode } from '../shared/parser.js';
import { parseStateEntries } from '../shared/parser.js';
import { Multimap } from '../shared/multimap.js';
import { bagOf } from '../shared/inherited.js';
import type { ResolvedAttrs } from '../shared/served.js';
import { RenderNode } from './render-node.js';
import { resolveEffectiveChildren, resolveTransclusionConfig } from './transclusion.js';
import { resolveRefOn, resolveMediaOn, resolveMediaAllOn, childrenOf } from './origin-host.js';
import { parseTranscludeEntry } from '../shared/shared.js';
import { TRANSCLUDE_DEADLINE_MS } from './constants.js';
import type { PassEntry, PassMode, StateNode } from './state.js';
import { exhibitOpenFromNode } from './exhibit.js';
export { exhibitOpenFromNode };

// ── parsePass ──────────────────────────────────────────────────────────────
// Parse a `pass` or `children-pass` attribute value into PassEntry[].
// Grammar per entry (comma-separated):
//   &foo           → remoteKey=foo, localKey=foo, mode=r
//   &foo w         → mode=w
//   &foo rw        → mode=rw
//   &remote=&local → remoteKey=remote, localKey=local, mode=r
//   &remote=&local rw → mode=rw
//
// Keys are always '&'-prefixed, as in let/set/remove and show-when; the sigil is
// stripped here because state keys are stored bare. An unprefixed key or an
// unrecognised mode throws, so a typo surfaces as a parse error rather than as a
// silently read-only (or silently absent) permission.

const PASS_KEY_RE = /^&([\w-]+)$/;

function passKey(tok: string, whole: string): string {
  const m = tok.match(PASS_KEY_RE);
  if (!m) throw new Error(`rvmark: pass key must be &-prefixed, got: ${whole}`);
  return m[1];
}

export function parsePass(raw: string): PassEntry[] {
  const result: PassEntry[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const tokens = s.split(/\s+/);
    if (tokens.length > 2) throw new Error(`rvmark: unexpected text after pass mode in: ${s}`);
    const keyPart = tokens[0];
    const modePart = tokens[1];
    if (modePart !== undefined && modePart !== 'r' && modePart !== 'w' && modePart !== 'rw') {
      throw new Error(`rvmark: pass mode must be 'r', 'w', or 'rw', got: ${s}`);
    }
    const mode: PassMode = modePart ?? 'r';
    const eqIdx = keyPart.indexOf('=');
    if (eqIdx !== -1) {
      result.push({
        childKey:  passKey(keyPart.slice(0, eqIdx), s),
        parentKey: passKey(keyPart.slice(eqIdx + 1), s),
        mode,
      });
    } else {
      const key = passKey(keyPart, s);
      result.push({ childKey: key, parentKey: key, mode });
    }
  }
  return result;
}

// ── Transclusion expand ────────────────────────────────────────────────────

export async function expandNode(rn: RenderNode, transcludeRef?: string): Promise<void> {
  const sourceNode = rn.sourceNode;
  const attrs = sourceNode.attrs;
  const { embedVal, childrenList: _childrenList } = resolveTransclusionConfig(sourceNode, attrs);
  // A caller-supplied ref (listbox option) or a link-mode embedVal is just a
  // single-ref children list. Route both through the list path below so the
  // target's own transclude chain is followed (resolveEffectiveChildren) — the
  // link-mode vs children-mode distinction is only about the node's own chrome.
  const childrenList = transcludeRef ? [transcludeRef] : (_childrenList ?? (embedVal ? [embedVal] : null));

  const passChildrenRaw = attrs.get('children-pass');
  const passChildrenEntries = passChildrenRaw !== undefined ? parsePass(passChildrenRaw) : undefined;

  if (childrenList) {
    const needsResolve = childrenList.some(r => r !== '*');

    // Phase 1: while any ref is in flight, show a single loading marker. It rides
    // the setChildren mount race (MOUNT_SETTLE_MS), so a fast resolve supersedes it
    // before it ever paints — no flash — while a slow one reveals it.
    if (needsResolve) {
      rn.setChildren([makeLoadingNode(sourceNode)], null, passChildrenEntries);
    }

    // Phase 2: race every ref against one shared deadline. A ref still unresolved
    // when the deadline fires becomes a timeout marker; an unresolvable ref becomes
    // a not-found marker. Refs settle together (no progressive per-ref mounting):
    // one wholesale swap into the flattened result. `*` contributes local children.
    const TIMED_OUT = Symbol('timed-out');
    const deadline = new Promise<typeof TIMED_OUT>(res => setTimeout(() => res(TIMED_OUT), TRANSCLUDE_DEADLINE_MS));
    const outcomes = await Promise.all(childrenList.map(async (rawRef) => {
      if (rawRef === '*') return { rawRef, star: true, wholeNode: false, node: null as SourceNode | null, timedOut: false };
      const { wholeNode } = parseTranscludeEntry(rawRef);
      const node = await Promise.race([resolveRefOn(sourceNode, rawRef), deadline]);
      if (node === TIMED_OUT) return { rawRef, star: false, wholeNode, node: null, timedOut: true };
      return { rawRef, star: false, wholeNode, node: node as SourceNode | null, timedOut: false };
    }));

    const allNodes: SourceNode[] = [];
    for (const o of outcomes) {
      if (o.star) {
        allNodes.push(...await childrenOf(sourceNode));
      } else if (o.node) {
        // '^' asks for the target as a row rather than for what is under it —
        // so it is pushed whole, subtree and all, and the unwrap is skipped.
        if (o.wholeNode) allNodes.push(o.node);
        else allNodes.push(...await resolveEffectiveChildren(o.node, new Set([o.rawRef])));
      } else {
        allNodes.push(makeErrorNode(sourceNode, o.rawRef, o.timedOut ? 'timeout' : 'error'));
      }
    }
    await rn.setChildren(allNodes, null, passChildrenEntries);
  } else if (sourceNode.hasChildren) {
    await rn.setChildren(await childrenOf(sourceNode), null, passChildrenEntries);
  }
}

// ── Synthetic transclusion markers ─────────────────────────────────────────
// Programmatically-minted child nodes shown while a children-mode transclusion
// resolves. They stand in for the host — rendered in its place, in its document
// — so they resolve media the way it does and sit at its page address. What they
// do not have is an identity: nothing served them, so their key is empty and
// asking an origin about it would be asking about a node that does not exist.

function syntheticChild(host: SourceNode, attrs: Multimap, label: string): SourceNode {
  return {
    slug: '', permalinkId: '', numbering: '',
    attrs, tags: [], label, bodyLines: [],
    children: [], hasChildren: false,
    address:     { baseUrl: host.address.baseUrl, key: '' },
    pageAddress: host.pageAddress,
    // Rendered in the host's place, so it takes the host's scope: a marker must
    // never raise a barrier the node it stands in for would not have raised.
    stateScope:  host.stateScope,
    // Stands in for the host, so it inherits exactly what the host has.
    ...bagOf(host),
  } as SourceNode;
}

// The single "resolving…" marker (loading type → animated placeholder).
function makeLoadingNode(host: SourceNode): SourceNode {
  const attrs = new Multimap();
  attrs.set('type', 'loading');
  return syntheticChild(host, attrs, '');
}

// A per-ref marker for a broken ('not found') or timed-out ref: a plain text node,
// so it renders exactly like any other row (bullet + label). Exported so the
// link-mode transclusion path (blastocyte) produces an identical error row — the
// broken link-mode and children-mode cases must look the same.
export function makeErrorNode(host: SourceNode, ref: string, reason: 'error' | 'timeout'): SourceNode {
  const attrs = new Multimap();
  attrs.set('type', 'text');
  // Distinct error marker + muted row; both drawn from CSS on this class, so the
  // marker needs no font and no fetch (see .node-load-error in styles.css).
  attrs.append('class', 'node-load-error');
  const label = reason === 'timeout' ? `${ref} timed out` : `${ref} not found`;
  return syntheticChild(host, attrs, label);
}

// ── Listbox keydown dispatch ───────────────────────────────────────────────
// Centralized keyboard handling for inline option spans in a node's label.
// Handlers with a listbox should call this from their keydown listener.
//
//   Enter + active option → activate + fire on-action (only if the option acts)
//   ArrowRight            → next option
//   ArrowLeft             → prev option (returns false at leftmost so caller can fall through)
//
// Returns true if the event was consumed.
//
// An option with no action of its own does not consume Enter: activate()
// reports false and this returns false, so the caller's own Enter branch runs
// and the node keeps its key. Without that, a node whose options are targetless
// — Euclid's highlight spans — would lose Enter to the listbox the moment any
// option was selected, and a block node could never focus its scroll area.
// on-action is left to the caller on that path; firing it here too would run
// the node's mutations twice for one keypress.
export function listboxKeydown(
  e: KeyboardEvent,
  listboxNav: { activeIdx(): number; activate(): boolean; next(): boolean; prev(): boolean } | null | undefined,
  rn: RenderNode,
): boolean {
  if (!listboxNav) return false;
  const content = rn.content;

  if (e.key === 'Enter' && e.target === content && listboxNav.activeIdx() >= 0) {
    if (!listboxNav.activate()) return false;
    applyOnAction(rn);
    e.preventDefault();
    return true;
  }
  if (e.key === 'ArrowRight') {
    if (listboxNav.next()) { e.preventDefault(); return true; }
    return false;
  }
  if (e.key === 'ArrowLeft') {
    if (listboxNav.prev()) { e.preventDefault(); return true; }
    return false;
  }
  return false;
}

// ── Action keydown dispatch ────────────────────────────────────────────────
// Centralized handling of the `action` attribute for Enter/Space (and
// ArrowRight for action: link). Handlers should call this at the top of their
// keydown listener and bail if it returns true.
//
// Recognized actions: 'exhibit', 'link', 'none'.
export function actionKeydown(e: KeyboardEvent, rn: RenderNode): boolean {
  const actionVal = rn.sourceNode.attrs.get('action');
  if (actionVal === undefined) return false;
  const content = rn.content;

  if (actionVal === 'exhibit') {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target !== content) return false;
      exhibitOpenFromNode(rn);
      applyOnAction(rn);
      e.preventDefault();
      return true;
    }
    return false;
  }

  if (actionVal === 'link') {
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      if (e.target !== content) return false;
      // For expandable nodes, ArrowRight expands first; only follow the link
      // once the node is already expanded. Enter always follows the link.
      if (e.key === 'ArrowRight' && rn.toggleable && !rn.expanded) return false;
      const lbl = content.querySelector<HTMLElement>('.node-label');
      const a   = lbl?.querySelector<HTMLElement>('a:not(.node-tag)');
      if (a) {
        a.focus();
        applyOnAction(rn);
        e.preventDefault();
        return true;
      }
    }
    return false;
  }

  if (actionVal === 'none') {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target !== content) return false;
      e.preventDefault();
      return true;
    }
    return false;
  }

  return false;
}

// ── State declare on expand ────────────────────────────────────────────────

export function resolveStateVal(val: string | undefined, state: StateNode): string {
  if (val?.startsWith('&')) return state.get(val.slice(1)) ?? '';
  return String(val ?? '');
}

// Call at handler construction to process the bare-`let` / on-spawn attr.
export function applyOnSpawn(attrs: ResolvedAttrs, rn: RenderNode): void {
  for (const raw of attrs.getAll('on-spawn')) {
    for (const entry of parseStateEntries(raw)) {
      if (entry.op === 'delete')   rn.state.delete(entry.key);
      else if (entry.op === 'set') rn.state.set(entry.key, resolveStateVal(entry.val, rn.state));
      else                         rn.state.declare(entry.key, resolveStateVal(entry.val, rn.state));
    }
  }
}

// ── Event attribute application ───────────────────────────────────────────

// Apply state mutations for a given event attribute (on-select, on-expand, etc.).
export function applyEventAttr(attrVal: string | undefined, rn: RenderNode): void {
  if (!attrVal) return;
  for (const entry of parseStateEntries(attrVal)) {
    if (entry.op === 'delete')   rn.state.delete(entry.key);
    else if (entry.op === 'set') rn.state.set(entry.key, resolveStateVal(entry.val, rn.state));
    else                         rn.state.declare(entry.key, resolveStateVal(entry.val, rn.state));
  }
}

// Fire a node's `on-action` mutations.
//
// "Action" is one concept with two gestures: Enter/Space on the keyboard, and
// re-clicking an already-selected node (see wireSelectThenAction). Both must run
// this, or a bare `{set &x = "1"}` would work for only one kind of user. Call it
// from every doAction callback and every keyboard action path.
export function applyOnAction(rn: RenderNode): void {
  for (const v of rn.sourceNode.attrs.getAll('on-action')) applyEventAttr(v, rn);
}

// ── Tag class application ──────────────────────────────────────────────────

export function applyTagClasses(content: HTMLElement, sourceNode: SourceNode, attrs: ResolvedAttrs): void {
  for (const { def } of sourceNode.tags) {
    for (const cls of def.getAll('class')) {
      content.classList.add(...cls.split(/\s+/).filter(Boolean));
    }
  }
  for (const cls of attrs.getAll('class')) {
    content.classList.add(...cls.split(/\s+/).filter(Boolean));
  }
}

// The subscript ▶ badge that marks an expandable node whose bullet is a custom
// icon (the icon replaces the toggle triangle, so the affordance moves to a
// corner badge). CSS decides whether it shows.
//
// It is a real element rather than .toggle::after because the badge is a MASKED
// shape that needs a 1px separation ring, and `filter` is applied BEFORE `mask`
// on the same element — a drop-shadow there is computed on the unmasked box and
// then clipped away by the mask, drawing nothing. Splitting it across two
// elements fixes the order: the inner ::before carries the mask and the
// rotation, this span carries the filter, so the shadow sees the finished,
// rotated, masked triangle.
//
// A painted halo is not an option: it would have to match the row's backdrop,
// and an author can give a node any background — including an image. An alpha
// outset needs no such assumption.
//
// No geometry is duplicated: this span owns the position/size, and its ::before
// is inset:0, so both are the same box.
export function makeToggleBadge(): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'toggle-badge';
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// Give a bullet its `bullet-alt` name, if it has one.
//
// The marker is a masked box: no text, no alt, nothing in the accessibility
// tree. So a {.warning} row announces its label and nothing else, and the icon's
// meaning — often NOT repeated in the label — is lost to anyone not looking at
// it. This adds that meaning as visually-hidden text inside .toggle.
//
// Real text rather than aria-label, because .toggle is a bare span with no role:
// aria-label on a roleless element is ignored by most screen readers. Hidden
// with the clip pattern rather than display:none, which would drop it from the
// accessibility tree along with the pixels.
//
// Called after the bullet props are applied — applyBulletProps parks the value
// on the dataset, since it runs on .node-content but the text belongs in the
// toggle, which types build separately.
export function applyBulletAlt(content: HTMLElement, tog: HTMLElement): void {
  const alt = content.dataset.bulletAlt;
  if (!alt) return;
  const name = document.createElement('span');
  name.className = 'visually-hidden';
  // Trailing space so the name does not run into the label in the flat string a
  // screen reader builds from the row: "WarningDo not…".
  name.textContent = alt + ' ';
  tog.prepend(name);
}

// ── Bullet-column clickability ─────────────────────────────────────────────
//
// The bullet column takes clicks for two unrelated reasons: expanding a node,
// and clearing a listbox's option selection. A node may afford either, both, or
// neither, and every type resolves that differently — a text row's bullet is one
// element doing double duty, a table row's is the same shape in a grid cell, and
// a block node has no bullet at all (markdown.ts appends a strip instead).
//
// What must NOT differ is when the column claims to be clickable. Keying the
// cursor off :focus, as the per-type rules used to, lit up a leaf bullet with no
// listbox behind it — a pointer over a target that does nothing. So the class
// this sets is the single condition, asserted where the handler already knows
// the answer, and CSS styles that rather than guessing from focus.
export interface BulletActions {
  /** Called on click when the node can expand/collapse. */
  expand?: () => void;
  /** Resolves the listbox to reset, if the node has one. Called per click. */
  listbox?: () => { reset(): void; activeIdx(): number } | null | undefined;
}

// Wire a bullet-column element and mark whether it is actually clickable.
// Returns true if it took any action wiring at all.
export function wireBulletActions(
  el:      HTMLElement,
  content: HTMLElement,
  actions: BulletActions,
): boolean {
  const { expand, listbox } = actions;
  // `listbox` is resolved lazily: a type handler wires its bullet before the
  // listbox exists (the body may still be fetching), so the presence of a
  // resolver — not a live nav — is what marks the column clickable.
  const clickable = !!expand || !!listbox;
  el.classList.toggle('bullet-clickable', clickable);
  if (!clickable) return false;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    content.focus();
    // Expansion wins where a node affords both: it is the bullet's primary job,
    // and a node that expands shows its listbox reset elsewhere (ArrowLeft, or
    // deselect when {listbox-volatile}).
    if (expand) { expand(); return; }
    listbox?.()?.reset();
  });
  return true;
}

// Apply the custom marker attrs to a node's content element. Shared by every
// type that shows a gutter marker (text rows, table rows, hr dividers) so the
// supported set lives in one place.
//   bullet / bullet-spins — custom marker image + spin
//
// `bullet` is an image ref ('./icons/tip.svg'), never a glyph. Glyph bullets
// were removed deliberately: a character marker only renders if the reader has
// a font covering it, so supporting them pushed every site into shipping an
// emoji/symbol font stack (~2MB) as the price of decorated bullets, and made
// markers unreliable across federation — a transcluded foreign node's glyph is
// at the mercy of the HOST's fonts. An image ref has neither problem: it is
// addressed, so it resolves against the origin that wrote it, and it costs one
// small lazy fetch instead of a font.
export function applyBulletProps(content: HTMLElement, attrs: ResolvedAttrs, sourceNode?: SourceNode): void {
  // The non-media props are applied synchronously, before the icon is asked for.
  // They are what a node looks like without its bullet image, and holding them
  // back behind a resolution they do not need would make every decorated row
  // wait on a round trip to learn it spins.
  if (attrs.has('bullet-spins')) content.classList.add('node-content--bullet-spins');

  // The marker is a masked box with no text and no alt, so without this a
  // decorated node announces only its label — and the icon carries meaning the
  // label often does not repeat ("Warning", "To do"). Applied whatever the
  // marker is: an author may name the default bullet too.
  const alt = attrs.get('bullet-alt');
  if (alt) content.dataset.bulletAlt = alt;

  void applyBulletImages(content, attrs, sourceNode);
}

async function applyBulletImages(content: HTMLElement, attrs: ResolvedAttrs, sourceNode?: SourceNode): Promise<void> {
  const bullet = attrs.get('bullet');
  if (bullet !== undefined && sourceNode) {
    // Relative refs resolve against the file the node came FROM — so a
    // transcluded foreign node gets its OWN origin's icons, the same rule
    // markdown media and transclusion refs already follow.
    //
    // Both icons in one query: they are held together, so they are asked for
    // together — one message rather than two once the origin is behind a wire.
    const open = attrs.get('bullet-open');
    const [url, openUrl] = await resolveMediaAllOn(sourceNode, [bullet, open]);
    if (url) {
      setBulletImage(content, '--node-bullet-image', url, () => {
        content.classList.remove('node-content--bullet-image');
        content.style.removeProperty('--node-bullet-image');
      });
      content.classList.add('node-content--bullet-image');
    }

    // `bullet-open` swaps the icon while the node is expanded, so the marker
    // itself carries the open/closed state that the corner badge otherwise
    // would. Only meaningful alongside a `bullet`: the default triangle already
    // shows its own state by rotating.
    if (open !== undefined) {
      if (openUrl) {
        // Falling back to the closed icon (rather than the default marker) on a
        // dead URL keeps the bullet the author chose; only the state cue is lost.
        setBulletImage(content, '--node-bullet-image-open', openUrl, () => {
          content.classList.remove('node-content--bullet-open');
          content.style.removeProperty('--node-bullet-image-open');
        });
        content.classList.add('node-content--bullet-open');
      }
    }
  }
}

// Resolve one bullet image into a custom property, with a load probe that
// reverts it if the URL never arrives. A masked box paints nothing when the
// icon 404s or the origin is offline — a silently empty gutter — and the probe
// hits the same URL the mask does, so it is served from cache rather than
// fetched twice.
function setBulletImage(content: HTMLElement, prop: string, url: string, onFail: () => void): void {
  // CSS url() token: escape backslashes and quotes only — the value is a
  // resolved address, never author markup.
  content.style.setProperty(prop, `url("${url.replace(/[\\"]/g, '\\$&')}")`);
  const probe = new Image();
  probe.onerror = onFail;
  probe.src = url;
}

// Apply ordered-list-item marking. Separate from applyBulletProps because only
// list-item types (text rows, table rows) may be numbered — a divider must not
// carry `.li`, or it would consume a list number via the CSS counter.
//   li / li: N — N restarts the list counter so this item shows N.
// The value is reparsed to a canonical integer before it reaches CSS, so only
// digits can flow into --li-start (anything else leaves normal sequence).
export function applyListItemProps(content: HTMLElement, attrs: ResolvedAttrs): void {
  if (!attrs.has('li')) return;
  content.classList.add('li');
  const raw = attrs.get('li');
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) content.style.setProperty('--li-start', String(n));
  }
}

// ── Permalink helpers ──────────────────────────────────────────────────────

// Build the href for a permalink anchor.
// prefix is a canonical address '/_rvmark/docs.rvmark' or '' for the current page.
// Converts to a navigable href via addressToHref.
export function buildPermalinkHref(rn: RenderNode): string {
  const state    = rn.state.serialize();
  const basePath = rn.sourceNode ? addressToHref(rn.sourceNode.pageAddress ?? '') : '';
  return basePath + (state ? '?' + state : '') + (rn.permalinkId ? '#' + rn.permalinkId : '');
}

export function copyPermalink(rn: RenderNode): void {
  const href = buildPermalinkHref(rn);
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {});
}

// ── Focus gating ───────────────────────────────────────────────────────────
// Suppresses tab-reachable focusables inside content when the node is not
// selected, and tracks whether focus has moved inside the row (modeActive).
// Returns { activate, deactivate, modeActive } — caller wires activate/deactivate
// to TypeHandler.activate/deactivate and reads modeActive in keydown handlers.

export interface FocusGating {
  activate():   void;
  deactivate(): void;
  modeActive:   boolean;
}

export function wireFocusGating(
  content: HTMLElement,
  getFocusable: () => Iterable<HTMLElement>,
): FocusGating {
  function snapshotAndDisable(el: HTMLElement) {
    if ('rvmarkTabindex' in el.dataset) return;
    el.dataset['rvmarkTabindex'] = el.hasAttribute('tabindex') ? String(el.tabIndex) : 'implicit';
    el.tabIndex = -1;
  }
  function restoreTabIndex(el: HTMLElement) {
    const saved = el.dataset['rvmarkTabindex'];
    if (saved === undefined) return;
    delete el.dataset['rvmarkTabindex'];
    if (saved === 'implicit') el.removeAttribute('tabindex');
    else el.tabIndex = Number(saved);
  }

  const gating: FocusGating = {
    modeActive: false,
    activate()   { for (const el of getFocusable()) restoreTabIndex(el); },
    deactivate() { for (const el of getFocusable()) snapshotAndDisable(el); },
  };

  const observer = new MutationObserver(() => {
    const rn: RenderNode | undefined = (content.closest<HTMLElement>('.node') as any)?._renderNode;
    if (!rn || RenderNode.currentSelection !== rn) {
      observer.disconnect();
      requestAnimationFrame(() => {
        gating.deactivate();
        observer.observe(content, { childList: true, subtree: true });
      });
    }
  });
  observer.observe(content, { childList: true, subtree: true });

  content.addEventListener('focusin', () => {
    gating.modeActive = content.contains(document.activeElement) && document.activeElement !== content;
  });
  content.addEventListener('focusout', () => {
    Promise.resolve().then(() => {
      gating.modeActive = content.contains(document.activeElement) && document.activeElement !== content;
    });
  });

  content.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && e.target !== content) {
      e.preventDefault();
      content.focus();
    }
  }, true);

  return gating;
}

// ── Tree navigation ────────────────────────────────────────────────────────
// Stage 1 bridge: in stage 2 these calls move onto RenderNode traversal methods.

function visibleContents(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.node-content')]
    .filter(r => r.offsetParent !== null && (r.closest<HTMLElement>('.node') as any)?._renderNode?.selectable !== false);
}

function siblingContents(li: HTMLElement): HTMLElement[] {
  const parentUl = li.parentElement;
  if (!parentUl) return [];
  return [...parentUl.children]
    .filter(el => el.classList.contains('node'))
    .map(el => el.querySelector<HTMLElement>(':scope > .node-content'))
    .filter((c): c is HTMLElement => !!c && c.offsetParent !== null && (c.closest<HTMLElement>('.node') as any)?._renderNode?.selectable !== false);
}

function focusAndScroll(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus();
  scrollRowIntoMiddle(el);
}

// Handle positional navigation keys in a handler keydown listener.
// Returns true if the event was consumed.
export function treeNavKeydown(e: KeyboardEvent, content: HTMLElement, li: HTMLElement): boolean {
  switch (e.key) {
    case 'ArrowDown': {
      if (e.altKey) {
        const sibs = siblingContents(li);
        focusAndScroll(sibs[sibs.indexOf(content) + 1] ?? null);
      } else {
        const all = visibleContents();
        focusAndScroll(all[all.indexOf(content) + 1] ?? null);
      }
      e.preventDefault();
      return true;
    }
    case 'ArrowUp': {
      if (e.altKey) {
        const sibs = siblingContents(li);
        focusAndScroll(sibs[sibs.indexOf(content) - 1] ?? null);
      } else {
        const all = visibleContents();
        focusAndScroll(all[all.indexOf(content) - 1] ?? null);
      }
      e.preventDefault();
      return true;
    }
    case 'ArrowLeft':
      focusAndScroll(li.parentElement?.closest<HTMLElement>('.node')?.querySelector<HTMLElement>(':scope > .node-content'));
      e.preventDefault();
      return true;
    case 'Home': {
      const all = visibleContents();
      focusAndScroll(all[0] ?? null);
      e.preventDefault();
      return true;
    }
    case 'End': {
      const all = visibleContents();
      focusAndScroll(all[all.length - 1] ?? null);
      e.preventDefault();
      return true;
    }
  }
  return false;
}

