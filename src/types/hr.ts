/**
 * types/hr.new.ts
 *
 * Hr type handler — new RenderNode/TypeHandler model.
 * Renders a horizontal rule. Non-selectable.
 *
 * Syntax:
 *   1. {= hr}
 */

import type { TypeHandler, NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { resolveAttrs, applyExhibit } from '../handler-utils.js';
import { resolveTagDef } from '../tags.js';

class HrTypeHandler implements TypeHandler {
  readonly content:    HTMLElement;
  readonly selectable: boolean = false;

  constructor(renderNode: RenderNode) {
    const sourceNode = renderNode.sourceNode;
    const attrs = resolveAttrs(sourceNode);

    const content = document.createElement('div');
    this.content = content;

    // ── Classes ──────────────────────────────────────────────────────────────
    content.classList.add('node-content--hr');

    for (const { name, props } of sourceNode.tags) {
      const def = resolveTagDef(name, props, sourceNode.sourceFile.tagDefs);
      for (const cls of def.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));
    }
    for (const cls of attrs.getAll('class')) content.classList.add(...cls.split(/\s+/).filter(Boolean));

    const bullet = attrs.get('bullet');
    if (bullet !== undefined)
      content.style.setProperty('--node-bullet', `'${bullet.replace(/'/g, "\\'")}'`);
    const bf = attrs.get('bullet-font');
    if (bf !== undefined) content.style.setProperty('--node-bullet-font', bf);

    if (attrs.has('bullet-spins')) content.classList.add('node-content--bullet-spins');

    renderNode.selectable = false;
    renderNode.meta = sourceNode.meta;

    // ── Exhibit scope ────────────────────────────────────────────────────────
    applyExhibit(renderNode, attrs);

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
