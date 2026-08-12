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

  // ── The hill ──────────────────────────────────────────────────────────────
  // The children area is a hill: one holder, last taker wins, and knocking
  // someone off puts nobody else on (no layering — releasing empties the area).
  // Design note §1c.
  //
  // Only TRANSCLUDING spans ever take it. A targetless span — an option that
  // merely sets state, or a bare {toggle} checkbox — makes no claim, so it
  // takes nothing and knocks nobody off. That is what lets Euclid's highlight
  // spans be arrowed across while a citation stays open.
  private _holder: HTMLElement | 'bullet' | null = null;
  // The holder's span ordinal — the identity that survives a re-render, since
  // innerHTML discards the element itself. See register().
  private _holderOrdinal: string | null = null;
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
    // The bullet takes the hill like any other member.
    this._takeHill('bullet');
    await expandNode(this.rn);
    for (const v of this.rn.sourceNode.attrs.getAll('on-expand')) applyEventAttr(v, this.rn);
    this.onExpand?.({ scroll });
  }

  // ── Span members of the hill ─────────────────────────────────────────────
  // A span member targets a transclusion ref instead of the node's own
  // children, but contends for the same hill.

  /**
   * Add a span to the set, and re-adopt it if it is the hill's holder.
   *
   * Wiring runs again on every re-render of a container (markdown fetch, KaTeX
   * upgrade, a `show-when` sibling flipping) — and innerHTML replaces the DOM
   * elements each time. Identity must therefore be the span's ORDINAL, which is
   * stable across re-renders, not the element, which is not: a holder tracked
   * by element goes stale the moment its container re-renders, leaving the hill
   * pointing at a detached node while the visible span reads as closed.
   */
  register(el: HTMLElement): void {
    this._spanMembers.add(el);
    const ord = el.getAttribute('data-rvmark-span');
    if (ord !== null && ord === this._holderOrdinal) {
      this._holder = el;
      el.setAttribute('aria-expanded', 'true');
    }
  }

  isSpanOpen(el: HTMLElement): boolean { return this._holder === el; }

  /** True when nobody holds the hill, so the children area is free to fill. */
  hillIsFree(): boolean { return this._holder === null; }

  /** Take the hill for a MANUAL toggle span. */
  async openSpan(el: HTMLElement, ref: string): Promise<void> {
    this._takeHill(el);
    el.setAttribute('aria-expanded', 'true');
    await expandNode(this.rn, ref);
  }

  /** Release the hill, emptying the children area. No layering: nothing is
   *  revealed underneath. */
  closeSpan(el: HTMLElement): void {
    if (this._holder !== el) return;
    this._takeHill(null);
    this.rn.setChildren([]);
  }

  toggleSpan(el: HTMLElement, ref: string): void {
    if (this.isSpanOpen(el)) this.closeSpan(el);
    else void this.openSpan(el, ref);
  }

  /** Take the hill for a selection-driven OPTION span. Distinct from openSpan
   *  only in that the caller owns the transclusion — the listbox path already
   *  calls expandNode with its own ref handling. */
  takeHillForOption(el: HTMLElement): void {
    this._takeHill(el);
  }

  /** Release the hill if `el` holds it, WITHOUT emptying the area — the caller
   *  is about to fill it. Used when an option is deselected: its content goes
   *  away because the listbox replaces or clears it, not because the hill was
   *  knocked over. */
  releaseIfHolder(el: HTMLElement): void {
    if (this._holder === el) this._holder = null;
  }

  /**
   * Hand the hill to `next`, deactivating whoever held it.
   *
   * The two temperaments (§1c). A knocked-off MANUAL toggle is insecure: it
   * curls up and deactivates, so aria-expanded goes false and it is off. A
   * knocked-off OPTION is confident: it stands upright and stays on — still
   * selected, on-deselect unfired, its state mutations still applied — because
   * losing the hill is a different event from being deselected. So options are
   * simply dropped from the hill with nothing else disturbed; only spans
   * carrying aria-expanded (manual toggles) are marked closed.
   */
  private _takeHill(next: HTMLElement | 'bullet' | null): void {
    const prev = this._holder;
    if (prev && prev !== 'bullet' && prev !== next && prev.hasAttribute('aria-expanded')) {
      prev.setAttribute('aria-expanded', 'false');
    }
    this._holder = next;
    this._holderOrdinal = (next && next !== 'bullet')
      ? next.getAttribute('data-rvmark-span')
      : null;
  }

  /** Mount transcluded content once, for the types that transclude at build
   *  time and never collapse (block, image, video, iframe). Still fires
   *  on-expand: the attribute is general (parser.ts) and documented as firing
   *  when the node expands, so these types silently dropping it was a bug. */
  mountOnce(): void {
    void this.open(false);
  }

  close(): void {
    this._takeHill(null);
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
