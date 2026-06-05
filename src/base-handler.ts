/**
 * base-handler.ts
 *
 * Base class for TypeHandlers. Owns the content div, focus gating, rn field,
 * and the shared construction sequence: create div → apply classes → set ARIA
 * → wire focus gating.
 *
 * Subclasses call super(rn, focusableSelector) then re-derive attrs via
 * resolveAttrs(rn.sourceNode) for their own setup — resolveAttrs is a cheap
 * object merge so re-deriving is fine.
 */

import type { TypeHandler, RenderNode } from './render-node.js';
import { resolveAttrs, applyTagClasses, wireFocusGating } from './handler-utils.js';
import type { FocusGating } from './handler-utils.js';

export abstract class BaseTypeHandler implements TypeHandler {
  readonly content:    HTMLElement;
  readonly selectable: boolean = true;
  protected readonly rn: RenderNode;
  protected _gating!: FocusGating;

  constructor(rn: RenderNode, focusableSelector: string) {
    this.rn = rn;
    const sourceNode = rn.sourceNode;
    const attrs = resolveAttrs(sourceNode);

    const content = document.createElement('div');
    this.content = content;

    applyTagClasses(content, sourceNode, attrs);

    content.setAttribute('role', 'treeitem');
    rn.selectable = true;
    rn.meta = sourceNode.meta;

    this._gating = wireFocusGating(
      content,
      () => content.querySelectorAll<HTMLElement>(focusableSelector),
    );
  }

  get modeActive(): boolean { return this._gating.modeActive; }
  activate():   void { this._gating.activate(); }
  deactivate(): void { this._gating.deactivate(); }
  onChildrenCleared(): void {}
  onConnected():       void {}
  onDestroy():         void {}

  protected setExpandable(nowExpandable: boolean, tog: HTMLElement, collapse: () => void): void {
    if (!nowExpandable && this.rn.expanded) {
      collapse();
      // collapse() may destroy a focused child, moving focus to this node,
      // firing on-select synchronously and re-entering setExpandable(true).
      // If that happened, toggleable is already true — don't clobber it.
      if (this.rn.toggleable) return;
    }
    this.rn.toggleable = nowExpandable;
    tog.classList.toggle('leaf', !nowExpandable);
    if (nowExpandable) {
      if (!this.content.hasAttribute('aria-expanded')) this.content.setAttribute('aria-expanded', 'false');
    } else {
      this.content.removeAttribute('aria-expanded');
    }
  }
}
