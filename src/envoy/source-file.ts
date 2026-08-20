/**
 * source-file.ts
 *
 * SourceFile — the parsed representation of a single .rvmark source file.
 *
 * This is origin-side storage, not a client-side handle. It is the `.rvmark`
 * origin's answer to "what did I parse", and it exists only inside origin.ts's
 * implementation: nothing outside reads it. What leaves here is a node whose
 * fields are already resolved — the answers, not the means to compute them.
 *
 * Exports:
 *   SourceFile
 */

import type { SourceNode, Tag, TagDef, Head, FileMeta, NodeAttrs, Reserved } from '../shared/parser.js';
import { resolveMediaAddress } from '../shared/shared.js';
import { tagsNodeAttrs, mergeNodeAttrs, resolveTagDef } from '../shared/tags.js';
import { addressOrigin } from '../shared/shared.js';

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
      this.serve(node);
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
   * Resolve one node IN PLACE, against this file's head.
   *
   * The authored `attrs` and `tags` are overwritten rather than kept alongside
   * the resolved ones. Nothing downstream of here has a use for the authored
   * form: rendering wants the resolved values, and the one caller that needs
   * what the author typed — stringify, in the build tier — works from a RawFile
   * that never came through here.
   *
   * Eager rather than lazy: every field is wanted by the first handler that
   * touches the node, and computing them together is what makes the wire form
   * a serialization of the node rather than a second, differently-shaped answer.
   */
  private serve(node: SourceNode): void {
    // Authored on the way in, resolved on the way out — the same field, narrowed
    // in place. `resolveFile` hands over a tree that is structurally a RawNode
    // one; this is the step that makes the SourceNode type true of it.
    const authoredTags = node.tags as unknown as Tag[];
    Object.assign(node, this.resolveShape(node.attrs, authoredTags, node.slug));
  }

  /**
   * Resolve whatever attrs, tags and slug are handed in, against this file's
   * head. `serve` calls it for a parsed node; `Origin.reserve` calls it again
   * for a node an envoy transform rewrote — which is why it takes the pieces
   * rather than a node, since a transform's output has no resolved half yet.
   */
  resolveShape(attrs: NodeAttrs, tags: Tag[], slug: string): Reserved {
    const baseUrl = addressOrigin(this.pageAddress);
    const local   = this.pageAddress.slice(baseUrl.length).split('#')[0];
    return {
      address:     { baseUrl, key: slug ? `${local}#${slug}` : local },
      attrs:       mergeNodeAttrs(tagsNodeAttrs(tags, this.head.tagDefs), attrs),
      tags:        tags.map(({ name, props }) => ({
                     name,
                     def: resolveTagDef(name, props, this.head.tagDefs),
                   })),
      pageAddress: this.pageAddress,
    };
  }
}
