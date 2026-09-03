import { declareType } from '../shared/node-types.js';
import { LISTBOX, TABULAR } from './_shared.declare.js';

// The type a node with no `type` attribute gets.
declareType({
  name: 'text',
  default: true,
  attrs: [...TABULAR, ...LISTBOX],
});
