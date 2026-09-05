/**
 * rv-file.ts
 *
 * RvFile — a single .rvmark file as the origin holds it: its nodes resolved,
 * and addressed against where the file lives.
 *
 * This is origin-side storage, not a client-side handle. It is the `.rvmark`
 * origin's answer to "what did I parse", and it exists only inside origin.ts's
 * implementation: nothing outside reads it. What leaves here is a node whose
 * fields are already resolved — the answers, not the means to compute them.
 *
 * Exports:
 *   RvFile
 */

import type { RvNode, Tag, TagDef, Head, FileMeta, NodeAttrs, Reserved } from '../shared/parser.js';
import { resolveMediaAddress, absolutiseRef } from '../shared/shared.js';
import { tagsNodeAttrs, mergeNodeAttrs, resolveTagDef } from '../shared/tags.js';
import { isAddressAttr } from '../shared/node-types.js';
import '../types/declare.js';
import { Multimap } from '../shared/multimap.js';
import { addressOrigin } from '../shared/shared.js';

export type { Head, FileMeta };


export class RvFile {
  readonly nodeMap:     Record<string, RvNode>;
  readonly roots:       RvNode[];
  readonly head:        Head;
  readonly address:     string;   // e.g. 'logic/nd.rvmark' or 'https://...'
  readonly pageAddress: string;   // canonical address: '/_rvmark/logic/nd.rvmark'

  constructor(
    nodeMap:     Record<string, RvNode>,
    roots:       RvNode[],
    head:        Head,
    address:     string,
    pageAddress: string,
  ) {
    this.nodeMap     = nodeMap;
    this.roots       = roots;
    this.head        = head;
    this.address     = address;
    this.pageAddress = pageAddress;
    const stamp = (node: RvNode) => {
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
   * what the author typed — stringify, in the build tier — works from a SourceFile
   * that never came through here.
   *
   * Eager rather than lazy: every field is wanted by the first handler that
   * touches the node, and computing them together is what makes the wire form
   * a serialization of the node rather than a second, differently-shaped answer.
   */
  private serve(node: RvNode): void {
    // Authored on the way in, resolved on the way out — the same field, narrowed
    // in place. `resolveFile` hands over a tree whose nodes are still shaped as
    // SourceNodes; this is the step that makes the RvNode type true of them.
    const authoredTags = node.tags as unknown as Tag[];
    Object.assign(node, this.resolveShape(node.attrs, authoredTags, node.permalinkId));
  }

  /**
   * Resolve whatever attrs, tags and identity are handed in, against this file's
   * head. `serve` calls it for a parsed node; the origin calls it again for a
   * node a nodetype transform rewrote — which is why it takes the pieces rather
   * than a node, since a transform's output has no resolved half yet.
   *
   * The key is built from `permalinkId`, NOT from `slug`. A slug is only unique
   * among siblings — an id-less node's slug is its bare ordinal, so the first
   * child of every node in a file is `1` — and a key is asked file-globally, by
   * whoever holds it, with no context to disambiguate with. `permalinkId` is the
   * ordinal path (`.1.2`, or `anchor.1.2` from the nearest id'd ancestor), which
   * is what `resolveSlugInFile` walks and what the permalink already promises to
   * be stable.
   *
   * Keying on the slug is how a fetched child could come back as its own
   * ancestor: `childrenOf` re-resolves the key, `1` matched the first ROOT
   * rather than the intended node, and the subtree served itself forever.
   *
   * `stateScope` is the file's address: one token per file, which reproduces
   * what comparing `pageAddress` did when the client still modelled documents.
   * An origin is free to mint one token for everything and switch its own
   * barriers off; this one does not.
   */
  resolveShape(attrs: NodeAttrs, tags: Tag[], permalinkId: string): Reserved {
    const baseUrl = addressOrigin(this.pageAddress);
    const local   = this.pageAddress.slice(baseUrl.length).split('#')[0];
    const merged  = mergeNodeAttrs(tagsNodeAttrs(tags, this.head.tagDefs), attrs);
    return {
      address:     { baseUrl, key: permalinkId ? `${local}#${permalinkId}` : local },
      attrs:       this.absolutiseAddressAttrs(merged, tags),
      tags:        tags.map(({ name, props }) => ({
                     name,
                     def: resolveTagDef(name, props, this.head.tagDefs),
                   })),
      pageAddress: this.pageAddress,
      stateScope:  this.pageAddress,
    };
  }

  /**
   * Second pass over the merged attrs: every address-typed value made absolute
   * against the file that wrote it.
   *
   * Two passes rather than one because the node's `type` is itself an attribute,
   * and may arrive from a tag — so which attributes are address-typed is not
   * known until the merge has happened. The first pass merges; this one reads
   * `type` off the result and asks the registry.
   *
   * Which file wrote a value depends on where it came from. A value the node
   * authored was written in this file. A value a tag contributed was written
   * wherever that tag was defined, which is the whole reason this exists: a
   * `{node.bullet: ./icons/x.svg}` in a root header is applied to nodes in other
   * directories, and means the root's icons in every one of them.
   *
   * Runs again on a transformed node, since reserveWire re-resolves a
   * transform's output. That is harmless: an already-absolute ref is what
   * absolutiseRef returns untouched.
   */
  private absolutiseAddressAttrs(merged: NodeAttrs, tags: Tag[]): NodeAttrs {
    const typeName = merged.get('type');

    // Where a tag-contributed value was written, by attr name. A def with no
    // declaredIn was written in this file, which is already the default.
    const fromTag = new Map<string, string>();
    for (const { name } of tags) {
      const def = this.head.tagDefs[name];
      if (!def?.declaredIn) continue;
      for (const [k] of def.allEntries()) {
        if (k.startsWith('node.')) fromTag.set(k.slice(5), def.declaredIn);
      }
    }

    const out: NodeAttrs = new Multimap();
    for (const [k, v] of merged.allEntries()) {
      out.append(k, isAddressAttr(k, typeName)
        ? absolutiseRef(v, fromTag.get(k) ?? this.pageAddress)
        : v);
    }
    return out;
  }
}
