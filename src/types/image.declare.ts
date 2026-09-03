import { declareType } from '../shared/node-types.js';
import { BOX } from './_shared.declare.js';

declareType({
  name: 'image',
  attrs: [
    { name: 'src',       type: 'address' },
    { name: 'alt',       type: 'text'    },
    { name: 'align',     type: 'text'    },
    { name: 'dark-mode', type: 'enum'    },
    ...BOX,
  ],
});
