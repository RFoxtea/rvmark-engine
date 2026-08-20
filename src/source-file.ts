/**
 * source-file.ts
 *
 * SourceFile — the parsed representation of a single .rvmark source file.
 *
 * This is origin-side storage, not a client-side handle. It is the `.rvmark`
 * origin's answer to "what did I parse", and it exists only inside origin.ts's
 * implementation: nothing outside reads it. What the client gets instead is a
 * `Served` (served.ts), stamped on every node here, carrying the resolved
 * answers rather than the means to compute them.
 *
 * Exports:
 *   SourceFile
 */

import type { SourceNode, Tag, TagDef, Head, FileMeta, NodeAttrs } from './parser.js';
import { resolveMediaAddress } from './shared.js';
import { tagsNodeAttrs, mergeNodeAttrs, resolveTagDef } from './tags.js';
import type { Served } from './served.js';
import { addressOrigin } from './shared.js';

export type { Head, FileMeta };


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
    const stamp = (node: SourceNode) => {
      node.served = this.serve(node);
      node.children.forEach(stamp);
    };
    roots.forEach(stamp);
  }

  get meta():    FileMeta                { return this.head.meta; }
  get tagDefs(): Record<string, TagDef>  { return this.head.tagDefs; }

  resolveMediaUrl(url: string): string {
    return resolveMediaAddress(url, this.pageAddress) ?? url;
  }

  /**
   * The resolved view of one node, computed once when the file is parsed.
   *
   * Eager rather than lazy: every field is wanted by the first handler that
   * touches the node, and computing them together is what makes the wire form
   * a serialization of this object rather than a second, differently-shaped
   * answer. `media` stays a closure — see served.ts on why it is not a map.
   */
  private serve(node: SourceNode): Served {
    return this.serveShape(node.attrs, node.tags, node.slug);
  }

  /**
   * Serve whatever attrs, tags and slug are handed in, against this file's head.
   * `serve` calls it for a parsed node; `reserve` calls it again for a node an
   * envoy transform rewrote, which is why it takes the pieces rather than a node.
   */
  private serveShape(attrs: NodeAttrs, tags: Tag[], slug: string): Served {
    const baseUrl = addressOrigin(this.pageAddress);
    const local   = this.pageAddress.slice(baseUrl.length).split('#')[0];
    return {
      address:     { baseUrl, key: slug ? `${local}#${slug}` : local },
      attrs:       mergeNodeAttrs(tagsNodeAttrs(tags, this.head.tagDefs), attrs),
      tags:        tags.map(({ name, props }) => ({
                     name,
                     def: resolveTagDef(name, props, this.head.tagDefs),
                   })),
      media:       (ref: string) => this.resolveMediaUrl(ref),
      pageAddress: this.pageAddress,
      reserve:     (out) => this.serveShape(out.attrs, out.tags, out.slug),
    };
  }
}
