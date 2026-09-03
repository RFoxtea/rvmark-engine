/**
 * Table-row nodetype. Must be a child of {= table}.
 *
 * Syntax:
 *   1. {= tr} Cell one | Cell two | Cell three
 *     1. optional child nodes rendered as an expansion panel below the row
 */

import './tr.declare.js';
import type { NodeTypeFactory, RenderNode } from '../client/render-node.js';
import { factoryRegister } from '../client/render-node.js';
import { staticMdInlineResolved } from '../client/markdown.js';
import { TrTypeHandlerBase, parseCells } from './tr-base.js';

class TrTypeHandler extends TrTypeHandlerBase {
  constructor(renderNode: RenderNode) {
    super(renderNode, {
      liClass:           'tr-row',
      toggleClass:       'tr-toggle',
      cellClass:         'tr-cell',
      contentClass:      'node-content--tr',
      focusableSelector: '.tr-cell a[href]',
      withSidepanel:       true,
      withBullet:        true,
    });
  }
}

const trFactory: NodeTypeFactory = {
  defaultOpen: false,
  create(renderNode) {
    return new TrTypeHandler(renderNode);
  },
  // Grid row, matching the handler's DOM — not a <tr>. The surrounding
  // li.tr-row and the toggle come from renderStaticTableNode in
  // build/site.ts, the same split as the table type above.
  staticRenderBody(node, ctx) {
    const cells = parseCells(node.label);
    // Resolved like the hydrated path's: a cell's `img:` names an asset on the
    // origin, so the fallback must ask for it too or it ships a dead path.
    const cellHtml = cells.map(c =>
      `<div class="tr-cell">${staticMdInlineResolved(c, refs => refs.map(r => ctx.resolveMedia(node, r)))}</div>`,
    ).join('');
    return `<div class="node-content">${cellHtml}</div>`;
  },
};

factoryRegister('tr', trFactory);
