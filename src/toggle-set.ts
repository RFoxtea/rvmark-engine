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
    await expandNode(this.rn);
    for (const v of this.rn.sourceNode.attrs.getAll('on-expand')) applyEventAttr(v, this.rn);
    this.onExpand?.({ scroll });
  }

  /** Mount transcluded content once, for the types that transclude at build
   *  time and never collapse (block, image, video, iframe). Still fires
   *  on-expand: the attribute is general (parser.ts) and documented as firing
   *  when the node expands, so these types silently dropping it was a bug. */
  mountOnce(): void {
    void this.open(false);
  }

  close(): void {
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
