/**
 * render-node.ts
 *
 * RenderNode — the kernel of the rendered tree. One per visible tree entry.
 * Owns the ARIA tree contract, DOM structure, children, and state frame.
 * Delegates all type-specific behavior to a TypeHandler instance.
 *
 * TypeHandler — interface for per-node type behavior. One instance per RenderNode.
 * Constructed by a NodeTypeFactory. Construction IS rendering — the factory receives
 * a live RenderNode and builds content + wires behaviour during create(). No separate
 * render step.
 *
 * SourceNode — the markup-level unit, one per source line. Defined in parser.ts.
 */

import type { SourceNode, NodeAttrs } from './parser.js';
import { parseShowWhen } from './parser.js';
export type { SourceNode };
export { parseShowWhen };
import { StateFrame, buildStatePass, prerootFrame } from './state.js';
import type { StateNode, PassEntry } from './state.js';
import { tagsNodeAttrs, mergeNodeAttrs } from './tags.js';
import { isOrContainsPermalink } from './transclusion.js';
import { exhibitNotifySelection } from './exhibit.js';
import type { ExhibitConfig } from './exhibit.js';
import { applyEventAttr } from './handler-utils.js';
import { scrollRowIntoMiddle } from './scroll.js';
import { blastocyteFactory } from './types/blastocyte.js';
import { MOUNT_SETTLE_MS } from './constants.js';
export type { StateFrame as StateView };

// ── ResolvedAttrs ─────────────────────────────────────────────────────────────
export type ResolvedAttrs = NodeAttrs;

// ── TypeHandler ───────────────────────────────────────────────────────────────
export interface TypeHandler {
  readonly content:      HTMLElement;
  readonly selectable:   boolean;
  readonly attrs?:       ResolvedAttrs;
  readonly managesReady?: true;

  readonly modeActive?: boolean;

  onSelect?():          void;
  onDeselect?():        void;
  onChildrenCleared?(): void;
  onDestroy?():         void;
  onConnected?():       void;
  activate?():          void;
  deactivate?():        void;
}

// ── NodeTypeFactory ───────────────────────────────────────────────────────────

/** Build-time context passed to staticRenderBody. Lets type handlers read
 *  sibling files (e.g. inline a referenced .md section) without importing
 *  Node-only APIs that would break browser builds. */
export interface StaticBuildContext {
  /** Read a file from the rvmark source tree by its tree-relative path
   *  (e.g. 'docs/philosophy.md'). Returns null if not found. */
  readFile(relPath: string): string | null;
}

export interface NodeTypeFactory {
  readonly defaultOpen?: boolean;
  create(renderNode: RenderNode): TypeHandler;
  staticRenderBody?(node: SourceNode, ctx: StaticBuildContext): string | null;
}

// ── Factory registry ──────────────────────────────────────────────────────────
export { factoryRegister, factoryGet } from './type-registry.js';

// ── show-when evaluation ──────────────────────────────────────────────────────
// Returns true if the node should be HIDDEN (condition means "hide when").
export function evalShowWhen(raw: string, state: StateNode): boolean {
  return parseShowWhen(raw).some(cond => {
    const lhs = state.get(cond.key);
    if (cond.op === 'truthy')  return !lhs;
    if (cond.op === '!truthy') return !!lhs;
    if (lhs === undefined) return cond.op !== '!=';
    const lhsNum = Number(lhs);
    const rhsRaw = cond.val ?? '';
    const rhs: string | number = Number.isNaN(Number(rhsRaw)) ? rhsRaw : Number(rhsRaw);
    const lhsComp: string | number = (typeof rhs === 'number' && !Number.isNaN(lhsNum)) ? lhsNum : lhs;
    switch (cond.op) {
      case '==': return lhsComp != rhs;
      case '!=': return lhsComp == rhs;
      case '>':  return (lhsComp as number) <= (rhs as number);
      case '<':  return (lhsComp as number) >= (rhs as number);
      case '>=': return (lhsComp as number) <  (rhs as number);
      case '<=': return (lhsComp as number) >  (rhs as number);
    }
    return false;
  });
}

// ── ChildSlot ─────────────────────────────────────────────────────────────────
// Represents one position in a parent's child list. Owns the spawn/destroy
// lifecycle for that position and holds the show-when subscription if deferred.

interface ChildSlot {
  readonly index:       number;
  readonly node:        SourceNode;
  readonly parentState: StateNode;
  readonly ul:          HTMLUListElement;
  readonly slots:       ChildSlot[];
  live:                 RenderNode | null;
  teardown:             (() => void) | null;
}

function recomputeAria(slots: ChildSlot[]): void {
  const live = slots.filter(s => s.live !== null);
  const total = live.length;
  live.forEach((s, i) => {
    s.live!.contentEl.setAttribute('aria-setsize',  String(total));
    s.live!.contentEl.setAttribute('aria-posinset', String(i + 1));
  });
}

function insertSlot(slot: ChildSlot): void {
  // Find nearest preceding live sibling for insertion position.
  let refLi: HTMLElement | null = null;
  for (let i = slot.index - 1; i >= 0; i--) {
    if (slot.slots[i].live) { refLi = slot.slots[i].live!.li; break; }
  }
  if (refLi) refLi.after(slot.live!.li);
  else slot.ul.prepend(slot.live!.li);
}

function spawnSlot(
  slot:       ChildSlot,
  focusSlug:  string | null,
  parentMeta: Record<string, unknown>,
): RenderNode {
  const rn = buildRenderNode(slot.node, focusSlug, parentMeta, slot.parentState);
  rn._onVacate = () => {
    slot.live = null;
    recomputeAria(slot.slots);
  };
  slot.live = rn;
  return rn;
}

function reactiveSpawnSlot(
  slot:       ChildSlot,
  focusSlug:  string | null,
  parentMeta: Record<string, unknown>,
): void {
  spawnSlot(slot, focusSlug, parentMeta);
  insertSlot(slot);
  recomputeAria(slot.slots);
  if (slot.ul.isConnected) slot.live!.fireConnected();
}

// Returns the spawned RenderNode if visible immediately, null if deferred.
function initSlot(
  slot:         ChildSlot,
  showWhenRaws: string[],
  focusSlug:    string | null,
  parentMeta:   Record<string, unknown>,
): RenderNode | null {
  if (showWhenRaws.length === 0) {
    return spawnSlot(slot, focusSlug, parentMeta);
  }

  const isHidden = () => showWhenRaws.some(sw => evalShowWhen(sw, slot.parentState));

  const keys = [...new Set(showWhenRaws.flatMap(sw => parseShowWhen(sw)).map(c => c.key))];

  const check = () => {
    const hidden = isHidden();
    if (!hidden && slot.live === null) {
      reactiveSpawnSlot(slot, focusSlug, parentMeta);
    } else if (hidden && slot.live !== null) {
      slot.live.destroy();
    }
  };

  const fns = keys.map(() => check);
  keys.forEach((k, i) => slot.parentState.subscribe(k, fns[i]));
  slot.teardown = () => keys.forEach((k, i) => slot.parentState.unsubscribe(k, fns[i]));

  if (!isHidden()) return spawnSlot(slot, focusSlug, parentMeta);
  return null;
}


// Returns true if the node is hidden due to {draft} attr.
export function isHiddenByModifier(attrs: NodeAttrs): boolean {
  return attrs.has('draft');
}

// ── buildRenderNode ───────────────────────────────────────────────────────────
// Build one RenderNode from a SourceNode. Used by RenderNode.setChildren and
// by the renderer bootstrap. Exported so handlers can call it for transclusion
// child segments without depending on renderer.js.
export function buildRenderNode(
  node:        SourceNode,
  focusSlug:   string | null,
  parentMeta:  Record<string, unknown> = {},
  parentState: StateNode = prerootFrame,
): RenderNode {
  const permalinkBase = node.permalinkId;

  const isFocusTarget   = !!focusSlug && (node.slug === focusSlug || node.attrs.get('id') === focusSlug || permalinkBase === focusSlug);
  const isFocusAncestor = !!focusSlug && !isFocusTarget && isOrContainsPermalink(node, permalinkBase, focusSlug);

  const attrs = mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile?.tagDefs), node.attrs);

  const rn = new RenderNode(node, parentState);
  rn.permalinkId = permalinkBase ?? '';
  if ('draft' in attrs) rn.li.classList.add('node--draft');

  blastocyteFactory.create(rn);
  rn.meta = { ...parentMeta, ...rn.meta };

  if ((isFocusAncestor || isFocusTarget) && rn.contentEl.hasAttribute('aria-expanded')) {
    rn.setChildren(node.children, focusSlug, {}, undefined, false);
  }

  if (isFocusTarget) {
    requestAnimationFrame(() => { rn.contentEl.tabIndex = 0; rn.contentEl.focus(); });
  }

  return rn;
}

// ── RenderNode ────────────────────────────────────────────────────────────────
let _rnIndex = 0;

export class RenderNode {
  static currentSelection: RenderNode | null = null;

  static setSelection(next: RenderNode | null): void {
    const prev = RenderNode.currentSelection;

    // `aria-selected` is the authoritative "this node's select side-effects are
    // currently applied" marker (set/cleared only here). Use it — not pointer
    // identity — to decide whether `next` is already selected. A node can remain
    // `currentSelection` while its select effects were undone by a transient
    // on-deselect: e.g. arrowing onto a show-when child that flips false and
    // self-destroys, returning focus to this same node. There, prev === next but
    // on-deselect already ran (state mutated), so we must re-run the select block
    // to honour the invariant "currentSelection is always actually selected".
    const nextSelected = next === null || next._handler?.content.getAttribute('aria-selected') === 'true';
    if (prev === next && nextSelected) return;

    // Run the deselect block only when leaving a DIFFERENT node. When prev === next
    // (the stale-selection repair case) we must not deselect-then-reselect the same
    // node — that would fire a spurious on-deselect/rvmark-deselect; we only need
    // to re-apply the select side-effects below.
    if (prev && prev !== next && prev._handler) {
      const prevContent = prev._handler.content;
      prevContent.setAttribute('aria-selected', 'false');
      prevContent.tabIndex = -1;
      prev._handler.deactivate?.();
      prev._handler.onDeselect?.();
      for (const v of prev.attrs.getAll('on-deselect')) applyEventAttr(v, prev);
      prevContent.dispatchEvent(new CustomEvent('rvmark-deselect', { bubbles: true, detail: { meta: prev.meta } }));
    }

    RenderNode.currentSelection = next;

    if (next && next._handler) {
      const nextContent = next._handler.content;
      nextContent.setAttribute('aria-selected', 'true');
      nextContent.tabIndex = 0;
      next._handler.activate?.();
      next._handler.onSelect?.();
      for (const v of next.attrs.getAll('on-select')) applyEventAttr(v, next);
      exhibitNotifySelection(next);
      scrollRowIntoMiddle(nextContent, { vertical: false } as any);
      nextContent.dispatchEvent(new CustomEvent('rvmark-select', { bubbles: true, detail: { meta: next.meta } }));
    }
  }

  readonly li:         HTMLElement;
  readonly children:   HTMLElement;
  readonly index:      number;
  sourceNode: SourceNode;
  permalinkId:         string = '';
  selectable:          boolean = true;
  meta:                Record<string, unknown> = {};

  posInSet:   number  = 1;
  setSize:    number  = 1;
  toggleable: boolean = false;

  readonly state: StateFrame;

  exhibitConfig: ExhibitConfig | null = null;

  // Called by the parent slot when this node is destroyed, to clear slot.live.
  _onVacate: (() => void) | null = null;

  // Set at the start of destroy() so a descendant's destroy() can walk past
  // ancestors that are themselves mid-teardown when picking a new selection.
  _destroying: boolean = false;

  private _handler:          TypeHandler | null = null;
  private _attrs:            ResolvedAttrs;
  private _slots:            ChildSlot[] = [];
  private _pendingSlots:     ChildSlot[] | null = null;
  private _pendingChildren:  Array<[SourceNode[], string | null, Record<string, unknown>, PassEntry[] | undefined]> = [];

  get attrs(): ResolvedAttrs {
    return (this._handler?.attrs ?? this._attrs);
  }

  whenReady: Promise<void>;
  private _resolveReady!: () => void;

  ready(): void { this._resolveReady(); }

  constructor(node: SourceNode, parentState: StateNode = prerootFrame) {
    this.index      = _rnIndex++;
    this.sourceNode = node;
    this._attrs     = mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile?.tagDefs), node.attrs);
    this.li         = document.createElement('li');
    this.children   = document.createElement('div');

    this.state = new StateFrame(parentState);
    this.whenReady = new Promise<void>(resolve => { this._resolveReady = resolve; });

    this.li.id        = `rn-${this.index}`;
    this.li.className = 'node';
    this.li.setAttribute('role', 'none');
    (this.li as any)._renderNode = this;

    this.children.className = 'node-children';
    this.li.appendChild(this.children);
  }

  attachHandler(handler: TypeHandler): this {
    if (this._handler) {
      this.li.removeChild(this._handler.content);
    }
    this._handler = handler;
    this.selectable = handler.selectable;
    const content = handler.content;
    content.classList.add('node-content');
    content.setAttribute('role', handler.selectable ? 'treeitem' : 'none');
    if (handler.selectable) {
      content.tabIndex = -1;
      content.setAttribute('aria-selected', 'false');
      content.addEventListener('focusin', (e) => {
        RenderNode.setSelection(this);
        if (e.target === content) {
          for (const v of this.attrs.getAll('on-focus')) applyEventAttr(v, this);
        }
      });
      content.addEventListener('focusout', (e) => {
        if (e.target === content) {
          for (const v of this.attrs.getAll('on-blur')) applyEventAttr(v, this);
        }
      });
    }
    content.setAttribute('aria-setsize',  String(this.setSize));
    content.setAttribute('aria-posinset', String(this.posInSet));
    this.li.insertBefore(content, this.children);
    if (this.toggleable && !this.expanded) content.setAttribute('aria-expanded', 'false');
    if (!handler.managesReady) this.ready();
    for (const args of this._pendingChildren) this.setChildren(...args as Parameters<RenderNode['setChildren']>);
    this._pendingChildren = [];
    return this;
  }

  watchChildren(nodes: SourceNode[], callback: (anyVisible: boolean) => void): () => void {
    const nodeAttrs = (n: SourceNode) => mergeNodeAttrs(tagsNodeAttrs(n.tags, n.sourceFile?.tagDefs), n.attrs);
    const isVisible = (c: SourceNode) => {
      const a = nodeAttrs(c);
      if (a.has('draft')) return false;
      return !a.getAll('show-when').some(sw => evalShowWhen(sw, this.state));
    };

    callback(nodes.some(isVisible));

    const keys = new Set<string>();
    for (const child of nodes) {
      for (const sw of nodeAttrs(child).getAll('show-when'))
        for (const cond of parseShowWhen(sw)) keys.add(cond.key);
    }
    if (!keys.size) return () => {};

    const recheck = () => { callback(nodes.some(isVisible)); };
    const unsubs: (() => void)[] = [];
    for (const key of keys) {
      this.state.subscribe(key, recheck);
      unsubs.push(() => { this.state.unsubscribe(key, recheck); });
    }
    return () => { for (const u of unsubs) u(); };
  }

  get handler(): TypeHandler | null { return this._handler; }

  activate(): void   { this._handler?.activate?.(); }
  deactivate(): void { this._handler?.deactivate?.(); }

  destroy(): void {
    this._destroying = true;
    const selection = RenderNode.currentSelection;
    const selectionInside = selection === this
      || (!!selection && this.li.contains(selection.li));
    const focusInside = !!this._handler?.content.contains(document.activeElement);
    let pushedTo: RenderNode | null = null;
    if (selectionInside || focusInside) {
      let liveAncestor = this.parent();
      while (liveAncestor && (liveAncestor._destroying || !liveAncestor._handler?.selectable)) {
        liveAncestor = liveAncestor.parent();
      }
      // focus() fires focusin which selects via the handler in attachHandler,
      // so only call setSelection when we aren't also moving focus.
      if (focusInside) liveAncestor?.content.focus();
      else RenderNode.setSelection(liveAncestor);
      pushedTo = liveAncestor ?? null;
    }
    this._destroyExistingChildren();
    this._handler?.onDestroy?.();
    for (const v of this.attrs.getAll('on-destroy')) applyEventAttr(v, this);
    this.li.remove();
    this._onVacate?.();
    // Selection pushed to an ancestor on destroy isn't a keyboard/click move, so
    // nothing else scrolls it into view (setSelection only scrolls horizontally).
    // Scroll after removal so layout reflects the now-gone subtree.
    if (pushedTo?._handler) {
      const ancestorContent = pushedTo._handler.content;
      requestAnimationFrame(() => scrollRowIntoMiddle(ancestorContent));
    }
  }

  fireConnected(): void {
    this._handler?.onConnected?.();
    for (const child of this.children.querySelectorAll<HTMLElement>(':scope > ul > li')) {
      const rn = (child as any)._renderNode as RenderNode | undefined;
      rn?.fireConnected();
    }
  }

  replaceHandler(sourceNode: SourceNode): void {
    this.sourceNode = sourceNode;
    this._attrs = mergeNodeAttrs(tagsNodeAttrs(sourceNode.tags, sourceNode.sourceFile?.tagDefs), sourceNode.attrs);
    blastocyteFactory.create(this);
  }

  // ── ARIA tree contract ─────────────────────────────────────────────────────

  get selected(): boolean {
    return RenderNode.currentSelection === this;
  }

  set selected(val: boolean) {
    if (!this._handler?.selectable) return;
    if (val) RenderNode.setSelection(this);
    else if (RenderNode.currentSelection === this) RenderNode.setSelection(null);
  }

  get expanded(): boolean {
    return this._handler?.content.getAttribute('aria-expanded') === 'true';
  }

  set expanded(val: boolean) {
    if (!this._handler) return;
    this._handler.content.setAttribute('aria-expanded', String(val));
  }

  get contentEl(): HTMLElement {
    return this._handler!.content;
  }

  get content(): HTMLElement {
    return this._handler!.content;
  }

  // ── Children management ────────────────────────────────────────────────────

  setChildren(
    nodes:               SourceNode[],
    focusSlug:           string | null = null,
    parentMeta:          Record<string, unknown> = {},
    passChildrenEntries: PassEntry[] | undefined = undefined,
    delay = true,
  ): void {
    if (!this._handler) { this._pendingChildren.push([nodes, focusSlug, parentMeta, passChildrenEntries]); return; }
    if (!nodes.length) {
      this._destroyExistingChildren();
      if (this.toggleable) this.expanded = false;
      else this._handler.content.removeAttribute('aria-expanded');
      this._handler.onChildrenCleared?.();
      return;
    }

    const ul = document.createElement('ul') as HTMLUListElement;
    ul.className = 'tree';
    ul.setAttribute('role', 'group');

    const hostAddress = this.sourceNode.sourceFile?.pageAddress;
    const explicitPass = passChildrenEntries !== undefined
      ? buildStatePass(this.state, passChildrenEntries)
      : null;
    const defaultBarrier = explicitPass === null
      ? buildStatePass(this.state, [])
      : null;

    const slots: ChildSlot[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let parentState: StateNode;
      if (explicitPass) {
        parentState = explicitPass;
      } else if (node.sourceFile?.pageAddress !== hostAddress) {
        parentState = defaultBarrier!;
      } else {
        parentState = this.state;
      }

      const slot: ChildSlot = {
        index: i, node, parentState: parentState as StateFrame,
        ul, slots, live: null, teardown: null,
      };
      slots.push(slot);
    }

    // Keep _slots pointing at the current live children until mount, so the
    // old children stay visible while the new ones prepare (no flicker). The
    // pending off-DOM nodes live in _pendingSlots so they can be torn down if
    // a later setChildren supersedes us or the host is destroyed.
    if (this._pendingSlots) this._drainSlots(this._pendingSlots);
    this._pendingSlots = slots;

    const nodeAttrs = (node: SourceNode) => mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile?.tagDefs), node.attrs);

    // Spawn the initial batch (those not deferred by show-when).
    const initialRns: RenderNode[] = [];
    for (const slot of slots) {
      const showWhenRaws = nodeAttrs(slot.node).getAll('show-when');
      const rn = initSlot(slot, showWhenRaws, focusSlug, parentMeta);
      if (rn) { ul.appendChild(rn.li); initialRns.push(rn); }
    }
    recomputeAria(slots);

    const mount = () => {
      if (this._pendingSlots !== slots) return; // superseded or host destroyed
      this._pendingSlots = null;
      // Tear down only the currently-live children, not the pending ones we're
      // about to install (still reachable via the closure-captured `slots`).
      const oldSlots = this._slots;
      this._slots = slots;
      for (const slot of oldSlots) {
        slot.teardown?.();
        if (slot.live) { slot.live._onVacate = null; slot.live.destroy(); slot.live = null; }
      }
      // Swap the children container's contents to the new ul.
      this.children.innerHTML = '';
      this.children.appendChild(ul);
      this.expanded = true;
      if (this.li.isConnected) {
        for (const slot of slots) slot.live?.fireConnected();
      }
    };

    if (!delay) {
      mount();
      return;
    }

    const timeout  = new Promise<void>(resolve => setTimeout(resolve, MOUNT_SETTLE_MS));
    const allReady = Promise.all(initialRns.map(rn => rn.whenReady));
    Promise.race([allReady, timeout]).then(mount);
  }

  hasLiveChildren(): boolean {
    return this._slots.some(s => s.live !== null);
  }

  private _drainSlots(slots: ChildSlot[]): void {
    for (const slot of slots) {
      slot.teardown?.();
      if (slot.live) {
        slot.live._onVacate = null; // skip reactive callbacks during bulk teardown
        slot.live.destroy();
        slot.live = null;
      }
    }
  }

  private _destroyExistingChildren(): void {
    this._drainSlots(this._slots);
    if (this._pendingSlots) { this._drainSlots(this._pendingSlots); this._pendingSlots = null; }
    this._slots = [];
    this.children.innerHTML = '';
  }

  // ── Tree traversal ─────────────────────────────────────────────────────────

  firstChild(): RenderNode | null {
    const li = this.children.querySelector<HTMLElement>(':scope > ul > li.node');
    return li ? (li as any)._renderNode ?? null : null;
  }

  parent(): RenderNode | null {
    const li = this.li.parentElement?.closest<HTMLElement>('li.node');
    return li ? (li as any)._renderNode ?? null : null;
  }

  nextSibling(): RenderNode | null {
    const parentUl = this.li.parentElement;
    if (!parentUl) return null;
    const siblings = [...parentUl.children].filter(el => el.classList.contains('node'));
    const idx = siblings.indexOf(this.li);
    const next = siblings[idx + 1] as HTMLElement | undefined;
    return next ? (next as any)._renderNode ?? null : null;
  }

  prevSibling(): RenderNode | null {
    const parentUl = this.li.parentElement;
    if (!parentUl) return null;
    const siblings = [...parentUl.children].filter(el => el.classList.contains('node'));
    const idx = siblings.indexOf(this.li);
    const prev = siblings[idx - 1] as HTMLElement | undefined;
    return prev ? (prev as any)._renderNode ?? null : null;
  }
}
