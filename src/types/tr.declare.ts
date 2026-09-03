import { declareType } from '../shared/node-types.js';
import { LISTBOX, TABULAR } from './_shared.declare.js';

declareType({
  name: 'tr',
  attrs: [...TABULAR, ...LISTBOX],
});
