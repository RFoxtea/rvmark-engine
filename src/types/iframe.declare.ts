import { declareType } from '../shared/node-types.js';
import { BOX } from './_shared.declare.js';

declareType({
  name: 'iframe',
  attrs: [
    { name: 'src',         type: 'address' },
    { name: 'iframe-pass', type: 'text'    },
    ...BOX,
  ],
});
