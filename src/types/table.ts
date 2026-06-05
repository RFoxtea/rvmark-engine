import type { NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { staticMdInline } from '../markdown.js';
import { TrTypeHandlerBase, parseCells } from './tr-base.js';

class TableTypeHandler extends TrTypeHandlerBase {
  constructor(renderNode: RenderNode) {
    super(renderNode, {
      liClass:           'table-node',
      toggleClass:       'table-toggle',
      cellClass:         'tr-cell table-header-cell',
      contentClass:      'node-content--table',
      focusableSelector: '.tr-cell a[href]',
      onSetup({ li, attrs, sourceNode }) {
        const cells     = parseCells(sourceNode.label);
        const cols      = cells.length || 1;
        const colsParam = attrs.get('cols') ?? null;
        li.style.setProperty('--table-cols', colsParam ?? `repeat(${cols}, 1fr)`);
      },
    });
  }
}

const tableFactory: NodeTypeFactory = {
  defaultOpen: false,
  create(renderNode) {
    return new TableTypeHandler(renderNode);
  },
  staticRenderBody(node) {
    const cells = parseCells(node.label);
    const colsParam = node.attrs.get('cols') ?? null;
    const cols = cells.length || 1;
    const gridCols = colsParam ?? `repeat(${cols}, 1fr)`;
    const style = ` style="grid-template-columns:${gridCols}"`;
    const headerCells = cells.map(c => `<th>${staticMdInline(c)}</th>`).join('');
    return `<table class="static-table"${style}><thead><tr>${headerCells}</tr></thead><tbody>`;
  },
};

factoryRegister('table', tableFactory);
