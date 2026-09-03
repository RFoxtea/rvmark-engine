/**
 * Attribute groups shared by more than one node type.
 *
 * Spread into a declaration rather than inherited: the engine has no type
 * hierarchy — factoryGet is a flat map and envoy-guest's claims are a flat
 * first-match list — so an `extends` here would describe a structure that exists
 * in this file and nowhere in the dispatch.
 */

import type { AttrDecl } from '../shared/node-types.js';

/** Box sizing, resolved by handler-utils.resolveBox. */
export const BOX: AttrDecl[] = [
  { name: 'width',  type: 'text' },
  { name: 'height', type: 'text' },
  { name: 'ratio',  type: 'text' },
];

/** Listbox behaviour, for the types whose children can act as options. */
export const LISTBOX: AttrDecl[] = [
  { name: 'listbox-nonempty', type: 'flag' },
  { name: 'listbox-volatile', type: 'flag' },
];

/** Read by tr and table alike, via tr-base. */
export const TABULAR: AttrDecl[] = [
  { name: 'action', type: 'expr' },
  { name: 'open',   type: 'enum' },
];
