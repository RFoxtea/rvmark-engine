/**
 * toggle-set.ts
 *
 * The set of toggles a node owns, and the rule that at most one of them is
 * open. Today the node's own bullet is the only member; span toggles join as a
 * second member kind (see rvmark-site/tools/toggle-spans-design-note.md).
 *
 * This exists because expansion was previously reimplemented per type handler:
 * text.ts and tr-base.ts each carried their own expandable/alwaysOpen fields,
 * doExpand/doToggle/setExpandable/watchChildren, and repeated the
 * `expandable && !alwaysOpen && toggleable` guard at a dozen call sites
 * between them. Both now delegate here, so "can this node toggle, and what
 * happens when it does" has one answer in one place.
 */

import type { RenderNode, SourceNode } from './render-node.js';
import type { ResolvedAttrs } from './source-file.js';
import { expandNode, applyEventAttr } from './handler-utils.js';
import { resolveTransclusionConfig } from './transclusion.js';

export interface ToggleSetOpts {
  /** `{open: always}`, plus whatever else forces a node permanently open. */
  alwaysOpen: boolean;
  /** Ran after an expand settles; text.ts scrolls the row into view. */
  onExpand?: (opts: { scroll: boolean }) => void;
}

/**
 * Owns one node's expansion. The bullet is a member; `open`/`close`/`toggle`
 * are the operations on it.
 */
export class ToggleSet {
  private readonly rn: RenderNode;
  private readonly onExpand?: (opts: { scroll: boolean }) => void;
  readonly alwaysOpen: boolean;
  readonly expandable: boolean;
  private _unwatchChildren?: () => void;

  // Which span toggle currently owns the children area, or null when the
  // bullet does (or nothing is open). Exclusivity is IMPOSED here: unlike
  // selection, action does not give it for free — two toggles could both be
  // actioned, and there is only one children area. Design note §1b.
  private _openSpan: HTMLElement | null = null;
  private readonly _spanMembers = new Set<HTMLElement>();

  constructor(rn: RenderNode, attrs: ResolvedAttrs, opts: ToggleSetOpts) {
    this.rn         = rn;
    this.onExpand   = opts.onExpand;
    this.alwaysOpen = opts.alwaysOpen;

    const sourceNode = rn.sourceNode;
    const neverOpen  = attrs.get('open') === 'never';
    const { embedVal, childrenList } = resolveTransclusionConfig(sourceNode, attrs);
    this.expandable = !neverOpen
      && (sourceNode.children.length > 0 || !!embedVal || !!childrenList);
  }

  /** True when the bullet may be operated: expandable, not pinned open, and
   *  currently holding something to show. Replaces the guard triple that was
   *  spelled out at every call site. */
  get operable(): boolean {
    return this.expandable && !this.alwaysOpen && this.rn.toggleable;
  }

  async open(scroll = true): Promise<void> {
    // The bullet is one member among the node's toggles, so opening it closes
    // whatever span toggle held the area.
    this._markSpanClosed();
    await expandNode(this.rn);
    for (const v of this.rn.sourceNode.attrs.getAll('on-expand')) applyEventAttr(v, this.rn);
    this.onExpand?.({ scroll });
  }

  // ── Span toggles ─────────────────────────────────────────────────────────
  // The second member kind. A span toggle targets a transclusion ref instead of
  // the node's own children, but contends for the same children area, so the
  // whole set stays "at most one open".

  register(el: HTMLElement): void { this._spanMembers.add(el); }

  isSpanOpen(el: HTMLElement): boolean { return this._openSpan === el; }

  /** Open a span toggle's target, closing whatever else in the set was open. */
  async openSpan(el: HTMLElement, ref: string): Promise<void> {
    this._markSpanClosed();
    this._openSpan = el;
    el.setAttribute('aria-expanded', 'true');
    await expandNode(this.rn, ref);
  }

  /** Close a span toggle, emptying the children area it owned. */
  closeSpan(el: HTMLElement): void {
    if (this._openSpan !== el) return;
    this._markSpanClosed();
    this.rn.setChildren([]);
  }

  toggleSpan(el: HTMLElement, ref: string): void {
    if (this.isSpanOpen(el)) this.closeSpan(el);
    else void this.openSpan(el, ref);
  }

  private _markSpanClosed(): void {
    if (!this._openSpan) return;
    this._openSpan.setAttribute('aria-expanded', 'false');
    this._openSpan = null;
  }

  /** Mount transcluded content once, for the types that transclude at build
   *  time and never collapse (block, image, video, iframe). Still fires
   *  on-expand: the attribute is general (parser.ts) and documented as firing
   *  when the node expands, so these types silently dropping it was a bug. */
  mountOnce(): void {
    void this.open(false);
  }

  close(): void {
    this._markSpanClosed();
    for (const v of this.rn.sourceNode.attrs.getAll('on-collapse')) applyEventAttr(v, this.rn);
    this.rn.setChildren([]);
  }

  /** Open when closed and vice versa; `force` pins the outcome. */
  toggle(force?: boolean, opts: { scroll?: boolean } = {}): void {
    const open = force !== undefined ? force : !this.rn.expanded;
    if (open) void this.open(opts.scroll ?? true);
    else this.close();
  }

  /** Open on build when `{open}` or `{open: always}` asked for it. */
  openIfRequested(paramOpen: boolean, scroll = true): void {
    if (this.expandable && (paramOpen || this.alwaysOpen)) void this.open(scroll);
  }

  /** Track whether the node still has children to show, flipping the `leaf`
   *  class and aria-expanded as that changes. */
  installWatch(setExpandable: (nowExpandable: boolean) => void): void {
    if (this.alwaysOpen) return;
    if (!this.rn.sourceNode.children.length) {
      if (this.expandable) setExpandable(true);
      return;
    }
    this._unwatchChildren = this.rn.watchChildren(
      this.rn.sourceNode.children as SourceNode[],
      (nowExpandable) => setExpandable(nowExpandable),
    );
  }

  destroy(): void {
    this._unwatchChildren?.();
    this._unwatchChildren = undefined;
  }
}
