/**
 * Table-row node type. Must be a child of {= table}.
 *
 * Syntax:
 *   1. {= tr} Cell one | Cell two | Cell three
 *     1. optional child nodes rendered as an expansion panel below the row
 */

import type { NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { staticMdInline } from '../markdown.js';
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
  // build-rvmark.mjs, the same split as the table type above.
  staticRenderBody(node) {
    const cells = parseCells(node.label);
    const cellHtml = cells.map(c => `<div class="tr-cell">${staticMdInline(c)}</div>`).join('');
    return `<div class="node-content">${cellHtml}</div>`;
  },
};

factoryRegister('tr', trFactory);
