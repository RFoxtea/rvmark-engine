/**
 * types/gap.ts
 *
 * Gap type handler — new RenderNode/TypeHandler model.
 * Renders vertical whitespace between siblings. No line, no content, not
 * selectable. Use where a paragraph break should read as air rather than a
 * drawn rule (contrast with `hr`, which draws a divider-rule).
 *
 * Syntax:
 *   1. {= gap}
 */

import type { TypeHandler, NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';

class GapTypeHandler implements TypeHandler {
  readonly content:    HTMLElement;
  readonly selectable: boolean = false;

  constructor(renderNode: RenderNode) {
    const sourceNode = renderNode.sourceNode;
    const attrs = sourceNode.attrs;

    const content = document.createElement('div');
    this.content = content;

    // ── Classes ──────────────────────────────────────────────────────────────
    content.classList.add('node-content--gap');

    for (const { def } of sourceNode.tags) {
      for (const cls of def.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));
    }
    for (const cls of attrs.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));

    renderNode.selectable = false;
    renderNode.meta = sourceNode.meta;

    // ── Exhibit scope ────────────────────────────────────────────────────────
  }

  getFocusableElements(_content: HTMLElement): NodeListOf<HTMLElement> {
    return document.createDocumentFragment().querySelectorAll<HTMLElement>('*');
  }
}

const gapFactory: NodeTypeFactory = {
  create(renderNode) {
    return new GapTypeHandler(renderNode);
  },
  staticRenderBody() {
    return '';
  },
};

factoryRegister('gap', gapFactory);
