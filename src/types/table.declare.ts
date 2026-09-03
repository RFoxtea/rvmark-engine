import { declareType } from '../shared/node-types.js';
import { TABULAR } from './_shared.declare.js';

declareType({
  name: 'table',
  attrs: [
    { name: 'cols', type: 'number' },
    ...TABULAR,
  ],
});
