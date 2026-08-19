/**
 * source-file.ts
 *
 * SourceFile — the parsed representation of a single .rvmark source file.
 * Replaces the loose `fileCtx` plain object ({ nodeMap, meta, address, pageAddress })
 * passed around throughout the renderer and type handlers.
 *
 * Exports:
 *   SourceFile
 */

import type { SourceNode, TagDef, Head, FileMeta, NodeAttrs } from './parser.js';
import { resolveMediaAddress } from './shared.js';
import { tagsNodeAttrs, mergeNodeAttrs } from './tags.js';

export type { Head, FileMeta };

export type ResolvedAttrs = NodeAttrs;

/**
 * A node's attributes with its tags' `node.*` overrides merged in — the answer
 * to "what are this node's attrs", which is a property of the source model
 * rather than of any renderer.
 *
 * Tag entries come first, the node's own after, so `.get()` gives the node the
 * last word and `.getAll()` still sees both (see multimap.ts on which attrs
 * compose and which override).
 *
 * Resolution is not cached here: callers that need it per-node hold the result
 * (handlers store it as a field), keeping SourceNode itself pure data.
 */
export function resolveAttrs(node: SourceNode): ResolvedAttrs {
  return mergeNodeAttrs(tagsNodeAttrs(node.tags, node.sourceFile.tagDefs), node.attrs);
}

export class SourceFile {
  readonly nodeMap:     Record<string, SourceNode>;
  readonly roots:       SourceNode[];
  readonly head:        Head;
  readonly address:     string;   // e.g. 'logic/nd.rvmark' or 'https://...'
  readonly pageAddress: string;   // canonical address: '/_rvmark/logic/nd.rvmark'

  constructor(
    nodeMap:     Record<string, SourceNode>,
    roots:       SourceNode[],
    head:        Head,
    address:     string,
    pageAddress: string,
  ) {
    this.nodeMap     = nodeMap;
    this.roots       = roots;
    this.head        = head;
    this.address     = address;
    this.pageAddress = pageAddress;
    const stamp = (node: SourceNode) => { node.sourceFile = this; node.children.forEach(stamp); };
    roots.forEach(stamp);
  }

  get meta():    FileMeta                { return this.head.meta; }
  get tagDefs(): Record<string, TagDef>  { return this.head.tagDefs; }

  resolveMediaUrl(url: string): string {
    return resolveMediaAddress(url, this.pageAddress) ?? url;
  }

}
