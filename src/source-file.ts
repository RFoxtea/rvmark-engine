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

import type { SourceNode, TagDef, Head, FileMeta } from './parser.js';
import { resolveMediaAddress } from './shared.js';

export type { Head, FileMeta };

export class SourceFile {
  readonly nodeMap:     Record<string, SourceNode>;
  readonly roots:       SourceNode[];
  readonly head:        Head;
  readonly address:     string;   // e.g. 'logic/nd.rvmark' or 'https://...'
  readonly pageAddress: string;   // canonical address: '/rvmark/logic/nd.rvmark'

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

  withPageAddress(pageAddress: string): SourceFile {
    return new SourceFile(this.nodeMap, this.roots, this.head, this.address, pageAddress);
  }
}
