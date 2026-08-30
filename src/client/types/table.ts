import type { NodeTypeFactory, RenderNode } from '../render-node.js';
import { factoryRegister } from '../render-node.js';
import { staticMdInlineResolved } from '../markdown.js';
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
  // Emits the same grid header row the handler builds — .node-content--table
  // with .tr-cell children — not a <table>. The fallback keeps the CSS grid so
  // cells stay aligned with the rows beneath them; see renderStaticTableNode in
  // build/site.ts, which supplies the surrounding li.table-node and toggle.
  //
  // --table-cols is set on the li by that caller, so it is not repeated here.
  staticRenderBody(node, ctx) {
    const cells = parseCells(node.label);
    const headerCells = cells
      .map(c => `<div class="tr-cell table-header-cell">${
        staticMdInlineResolved(c, refs => refs.map(r => ctx.resolveMedia(node, r)))}</div>`)
      .join('');
    return `<div class="node-content node-content--table">${headerCells}</div>`;
  },
};

factoryRegister('table', tableFactory);
