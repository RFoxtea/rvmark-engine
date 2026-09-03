import { declareType } from '../shared/node-types.js';
import { LISTBOX } from './_shared.declare.js';

declareType({
  name: 'block',
  attrs: [
    { name: 'src',    type: 'address' },
    { name: 'action', type: 'expr'    },
    ...LISTBOX,
  ],
});
