import { declareType } from '../shared/node-types.js';

// `loading` is minted by makeLoadingNode, never written by an author; declared
// so a node carrying it is not an unknown type. `pass` is read by the link-mode
// transclusion path in blastocyte.ts, before the node differentiates.
declareType({
  name: 'loading',
  attrs: [
    { name: 'pass', type: 'text' },
  ],
});
