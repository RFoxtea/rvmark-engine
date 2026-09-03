import { declareType } from '../shared/node-types.js';
import { BOX } from './_shared.declare.js';

declareType({
  name: 'video',
  attrs: [
    { name: 'src',   type: 'address' },
    { name: 'start', type: 'number'  },
    { name: 'end',   type: 'number'  },
    ...BOX,
  ],
});
