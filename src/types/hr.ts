/**
 * types/hr.new.ts
 *
 * Hr type handler — new RenderNode/TypeHandler model.
 * Renders a horizontal rule. Non-selectable.
 *
 * Syntax:
 *   1. {= hr}
 */

import './hr.declare.js';
import type { TypeHandler, NodeTypeFactory, RenderNode } from '../client/render-node.js';
import { factoryRegister } from '../client/render-node.js';
import { applyTagClasses } from '../client/handler-utils.js';

class HrTypeHandler implements TypeHandler {
  readonly content:    HTMLElement;
  readonly selectable: boolean = false;

  constructor(renderNode: RenderNode) {
    const rvNode = renderNode.rvNode;
    const attrs = rvNode.attrs;

    const content = document.createElement('div');
    this.content = content;

    // ── Classes ──────────────────────────────────────────────────────────────
    content.classList.add('node-content--hr');
    applyTagClasses(content, rvNode, attrs);

    renderNode.selectable = false;
    renderNode.meta = rvNode.meta;

    // ── Sidepanel scope ────────────────────────────────────────────────────────

    const hr = document.createElement('hr');
    hr.className = 'divider-rule';
    content.appendChild(hr);
  }

  getFocusableElements(_content: HTMLElement): NodeListOf<HTMLElement> {
    return document.createDocumentFragment().querySelectorAll<HTMLElement>('*');
  }
}

const hrFactory: NodeTypeFactory = {
  create(renderNode) {
    return new HrTypeHandler(renderNode);
  },
  staticRenderBody() {
    return '<hr class="divider-rule">';
  },
};

factoryRegister('hr', hrFactory);
