/**
 * handler-utils.ts
 *
 * Utilities for TypeHandler implementations.
 * This is the canonical import for type authors — everything a handler needs
 * beyond the RenderNode interface itself.
 *
 * Exports:
 *   resolveAttrs       — merge tag attrs + node attrs (factory should call at construction)
 *   buildPermalinkHref — build relative href for a permalink anchor
 *   copyPermalink      — copy absolute permalink to clipboard
 *   treeNavKeydown     — handle positional navigation keys in a handler keydown listener
 */

import { addressToHref } from './shared.js';
import { tagsNodeAttrs, mergeNodeAttrs, resolveTagDef } from './tags.js';
import { scrollRowIntoMiddle } from './scroll.js';
import type { SourceNode } from './parser.js';
import { parseOnSpawn } from './parser.js';
import type { ResolvedAttrs } from './render-node.js';
import { RenderNode } from './render-node.js';
import { resolveRef, resolveEffectiveChildren, resolveTransclusionConfig } from './transclusion.js';
import type { PassEntry, PassMode, StateNode } from './state.js';
import { exhibitStampScope, exhibitHandleNode, exhibitOpenFromNode } from './exhibit.js';
export { exhibitOpenFromNode };

// ── parsePass ──────────────────────────────────────────────────────────────
// Parse a `pass` or `children-pass` attribute value into PassEntry[].
// Grammar per entry (comma-separated):
//   foo          → remoteKey=foo, localKey=foo, mode=r
//   foo w        → mode=w
//   foo rw       → mode=rw
//   remote=local → remoteKey=remote, localKey=local, mode=r
//   remote=local rw → mode=rw

export function parsePass(raw: string): PassEntry[] {
  const result: PassEntry[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const tokens = s.split(/\s+/);
    const keyPart = tokens[0];
    const modePart = tokens[1] as PassMode | undefined;
    const mode: PassMode = (modePart === 'w' || modePart === 'rw') ? modePart : 'r';
    const eqIdx = keyPart.indexOf('=');
    if (eqIdx !== -1) {
      result.push({ childKey: keyPart.slice(0, eqIdx), parentKey: keyPart.slice(eqIdx + 1), mode });
    } else {
      result.push({ childKey: keyPart, parentKey: keyPart, mode });
    }
  }
  return result;
}

// ── Transclusion expand ────────────────────────────────────────────────────

export async function expandNode(rn: RenderNode, transcludeRef?: string): Promise<void> {
  const sourceNode = rn.sourceNode;
  const attrs = mergeNodeAttrs(tagsNodeAttrs(sourceNode.tags, sourceNode.sourceFile?.tagDefs), sourceNode.attrs);
  const { embedVal: _embedVal, childrenList } = resolveTransclusionConfig(sourceNode, attrs);
  const embedVal = transcludeRef ?? _embedVal;

  const passChildrenRaw = attrs.get('children-pass');
  const passChildrenEntries = passChildrenRaw !== undefined ? parsePass(passChildrenRaw) : undefined;

  if (embedVal) {
    const node = await resolveRef(embedVal, sourceNode.sourceFile.pageAddress) as any;
    if (!node || !node.children.length) return;
    rn.setChildren(node.children, null, rn.meta, passChildrenEntries);
  } else if (childrenList) {
    const preloads = childrenList.map(r => r === '*' ? null : resolveRef(r, sourceNode.sourceFile.pageAddress));
    const allNodes: SourceNode[] = [];
    for (let i = 0; i < childrenList.length; i++) {
      const rawRef = childrenList[i];
      if (rawRef === '*') {
        if (sourceNode.children.length) allNodes.push(...sourceNode.children as SourceNode[]);
      } else {
        const node = await preloads[i] as any;
        if (!node) continue;
        allNodes.push(...await resolveEffectiveChildren(node, new Set([childrenList[i]])));
      }
    }
    rn.setChildren(allNodes.length ? allNodes : [], null, rn.meta, passChildrenEntries);
  } else if (sourceNode.children.length) {
    rn.setChildren(sourceNode.children as SourceNode[], null, rn.meta, passChildrenEntries);
  }
}

// ── Exhibit wiring ─────────────────────────────────────────────────────────

export function applyExhibit(rn: RenderNode, attrs: ResolvedAttrs): void {
  const exhibitVal = attrs.get('exhibit');
  if (exhibitVal)
    exhibitStampScope(rn, exhibitVal, rn.sourceNode.sourceFile.pageAddress, attrs);
}

export function applyExhibitAction(rn: RenderNode, content: HTMLElement): void {
  if (resolveAttrs(rn.sourceNode).get('action') === 'exhibit')
    exhibitHandleNode(rn, content);
}

// ── Listbox keydown dispatch ───────────────────────────────────────────────
// Centralized keyboard handling for inline option spans in a node's label.
// Handlers with a listbox should call this from their keydown listener.
//
//   Enter + active option → activate + fire on-action
//   ArrowRight            → next option
//   ArrowLeft             → prev option (returns false at leftmost so caller can fall through)
//
// Returns true if the event was consumed.
export function listboxKeydown(
  e: KeyboardEvent,
  listboxNav: { activeIdx(): number; activate(): void; next(): boolean; prev(): boolean } | null | undefined,
  rn: RenderNode,
): boolean {
  if (!listboxNav) return false;
  const content = rn.content;

  if (e.key === 'Enter' && e.target === content && listboxNav.activeIdx() >= 0) {
    listboxNav.activate();
    for (const v of rn.sourceNode.attrs.getAll('on-action')) applyEventAttr(v, rn);
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
  const actionVal = resolveAttrs(rn.sourceNode).get('action');
  if (actionVal === undefined) return false;
  const content = rn.content;

  if (actionVal === 'exhibit') {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target !== content) return false;
      exhibitOpenFromNode(rn);
      for (const v of rn.sourceNode.attrs.getAll('on-action')) applyEventAttr(v, rn);
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
        for (const v of rn.sourceNode.attrs.getAll('on-action')) applyEventAttr(v, rn);
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

// Call at handler construction to process the {&} / on-spawn attr.
export function applyOnSpawn(attrs: ResolvedAttrs, rn: RenderNode): void {
  for (const raw of attrs.getAll('on-spawn')) {
    for (const entry of parseOnSpawn(raw)) {
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
  for (const entry of parseOnSpawn(attrVal)) {
    if (entry.op === 'delete')   rn.state.delete(entry.key);
    else if (entry.op === 'set') rn.state.set(entry.key, resolveStateVal(entry.val, rn.state));
    else                         rn.state.declare(entry.key, resolveStateVal(entry.val, rn.state));
  }
}

// ── Tag class application ──────────────────────────────────────────────────

export function applyTagClasses(content: HTMLElement, sourceNode: SourceNode, attrs: ResolvedAttrs): void {
  for (const { name, props } of sourceNode.tags) {
    const def = resolveTagDef(name, props, sourceNode.sourceFile.tagDefs);
    for (const cls of def.getAll('class')) {
      content.classList.add(...cls.split(/\s+/).filter(Boolean));
    }
  }
  for (const cls of attrs.getAll('class')) {
    content.classList.add(...cls.split(/\s+/).filter(Boolean));
  }
}

// ── Attr resolution ────────────────────────────────────────────────────────

// Merge tag node.* overrides onto node attrs. Call in factory.create() and
// store result as handler field — SourceNode stays pure, resolution happens once.
export function resolveAttrs(node: SourceNode): ResolvedAttrs {
  return mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile.tagDefs), node.attrs);
}

// ── Permalink helpers ──────────────────────────────────────────────────────

// Build the href for a permalink anchor.
// prefix is a canonical address '/_rvmark/docs.rvmark' or '' for the current page.
// Converts to a navigable href via addressToHref.
export function buildPermalinkHref(rn: RenderNode): string {
  const state    = rn.state.serialize();
  const basePath = rn.sourceNode ? addressToHref(rn.sourceNode.sourceFile.pageAddress ?? '') : '';
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

// ── Toggle font pre-warming ────────────────────────────────────────────────

// Call after appending a .toggle element to the DOM. Reads the resolved
// font-family from its ::before computed style and eagerly loads each font
// so they are cached before any custom glyph first appears mid-session.
export function prewarmToggleFonts(tog: HTMLElement): void {
  const family = getComputedStyle(tog, '::before').fontFamily;
  for (const part of family.split(',')) {
    const name = part.trim().replace(/^['"]|['"]$/g, '');
    if (name) document.fonts.load(`1em '${name}'`);
  }
}
