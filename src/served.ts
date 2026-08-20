/**
 * served.ts
 *
 * `Served` — what an origin hands over with every node it serves, and the only
 * thing about a node's provenance the client is allowed to read.
 *
 * A node arrives resolved. Its attrs already have tag `node.*` overrides merged
 * in, its tag chips already carry the text and props they render with, and its
 * media refs are already URLs. Nothing here can be recomputed by the client and
 * nothing here needs to be: the questions those computations answered — what
 * does this file's head declare, where does a relative path resolve against —
 * are the origin's, and they are answered before the node leaves it.
 *
 * This is the type that replaces `node.sourceFile` at every read site. The
 * difference is not cosmetic: `sourceFile` is a live handle to a parsed
 * document, complete with its nodeMap and loader, and holding one means holding
 * the document. `Served` is a value. It survives a postMessage, which
 * `sourceFile` deliberately does not (portable-node.ts), so Stage 3 moves the
 * boundary without moving any read site again.
 *
 * `address` is the node's own — carried, never derived. `media` resolves a raw
 * ref the way the origin that wrote it would; it is a function rather than a
 * pre-resolved map because refs also live inside prose (`mdInlineWithSpans`
 * calls back per URL while rendering), and enumerating them would mean parsing
 * markdown twice.
 */

import type { Tag, TagDef, NodeAttrs } from './parser.js';

/** A node's attrs with its tags' `node.*` overrides already merged in. */
export type ResolvedAttrs = NodeAttrs;

/** One tag as it renders: the props already merged, the dot-rule already applied. */
export interface ServedTag {
  name: string;
  def:  TagDef;
}

export interface Served {
  /** This node's own address. `key` is opaque — hand it back, never read it. */
  address: { baseUrl: string; key: string };

  /** `node.attrs` with tag `node.*` overrides merged in. */
  attrs: NodeAttrs;

  /** This node's tags, each with its definition resolved. Chips render from this. */
  tags: ServedTag[];

  /** A raw media ref → a URL the client can dereference, or the ref unchanged. */
  media(ref: string): string;

  /**
   * The address of the document this node came from, for the permalink and the
   * static-view link. Distinct from `address` only in that it names the whole
   * document rather than the node; an origin with no document-shaped storage
   * answers with the node's own.
   */
  pageAddress: string;

  /**
   * Re-serve a node whose attrs and tags have CHANGED — the output of an envoy
   * transform. It rides on the node rather than being looked up because the
   * lookup it replaces (page address → parsed document) is the origin-side
   * index the client must not have. See `Reserve` below.
   */
  reserve: Reserve;
}

/**
 * A `Served` for a node the CLIENT minted — a loading marker, an error row, a
 * failed custom type. These stand in for a host node and render in its place,
 * so they resolve media the way it does and sit in the same document. What they
 * do not have is an identity: nothing served them, so their key is empty and
 * asking an origin for it would be asking about a node that does not exist.
 *
 * The only legitimate construction of a `Served` outside an origin, and it is
 * legitimate precisely because it claims nothing an origin would have to answer
 * for.
 */
export function standIn(host: { served: Served }, attrs: ResolvedAttrs): Served {
  return {
    address:     { baseUrl: host.served.address.baseUrl, key: '' },
    attrs,
    tags:        [],
    media:       (ref) => host.served.media(ref),
    pageAddress: host.served.pageAddress,
    // A stand-in re-serves the way its host does: it renders in the host's
    // place, in the host's document, so its transform output belongs there too.
    reserve:     host.served.reserve,
  };
}

/**
 * How a node that came back CHANGED gets re-served — the output of an envoy
 * transform, whose attrs and tags are not the ones that went in.
 *
 * The origin re-serves it rather than the client patching it, because resolving
 * a tag means reading the document's declarations and that reading is the
 * origin's. `reserve` is the origin's hook: the SourceFile-backed one resolves
 * against its own head, and it is handed to `deserializeNode` by the caller
 * that holds the origin, never reached for from the wire side.
 */
export type Reserve = (node: { attrs: ResolvedAttrs; tags: Tag[]; slug: string }) => Served;

/** The tags that actually render a chip. `internal` ones render nothing. */
export function visibleTags(tags: ServedTag[]): ServedTag[] {
  return tags.filter(t => !t.def.has('internal'));
}

/** The text a tag puts on screen, or null when it renders no chip. */
export function tagText(tag: ServedTag): string | null {
  if (tag.def.has('internal')) return null;
  return tag.def.get('label') ?? tag.name;
}

export type { Tag };
