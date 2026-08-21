/**
 * portable-node.ts
 *
 * PortableNode — the postMessage-safe projection of a SourceNode, and the only
 * shape a node has while it is crossing between an origin and a client.
 *
 * A SourceNode cannot cross a postMessage boundary as-is: its `attrs` and its
 * tags' defs are `Multimap` instances, and methods do not survive structured
 * clone (multimap.ts).
 *
 * PortableNode is the flattened form that CAN leave the origin's realm: plain
 * strings + arrays, multimaps as `[[k, v], …]` entry lists. Inherited values
 * flatten the same way, but by their own declaration rather than here: a bag
 * value may be any type the registry admits, so inherited.ts carries the
 * toWire/fromWire pair and this module just calls it.
 *
 * What a node no longer has to be stripped OF is capabilities. It carries none:
 * a served node is data throughout, and the two closures that used to ride on
 * it became queries (`Origin.resolveResources`, `Origin.reserve`). So this is a
 * shape conversion and nothing else.
 *
 * `children` is not here. Structure is a query — `childrenOf` — and a node that
 * carried its subtree would answer it eagerly at every serve, materialising a
 * whole file to render one row. What crosses instead is `hasChildren`: enough to
 * draw a collapsed node's toggle without a round trip per node, and nothing more.
 *
 * `key` is what makes the node re-askable. It is the origin's own name for the
 * node, opaque to the client, and every later query about this node — its
 * children, a ref written on it, a resource it names — is that key handed back.
 */

import { Multimap } from './multimap.js';
import type { SourceNode } from './parser.js';
import { bagToWire, bagFromWire, type WireBag } from './inherited.js';

type Entries = Array<[string, string]>;

export interface PortableTag {
  name:  string;
  props: Entries;
}

export interface PortableNode {
  /** The origin's name for this node. Opaque: handed back, never parsed. */
  key:         string;
  slug:        string;
  permalinkId: string;
  numbering:   string;
  attrs:       Entries;
  tags:        PortableTag[];
  label:       string;
  bodyLines:   string[];
  inherited:   WireBag;
  /** Whether `childrenOf(key)` would answer with anything. */
  hasChildren: boolean;
  /**
   * Opaque token; equal means "same authoring scope". The client compares it
   * against the host's when splicing children in, and raises a state barrier
   * when they differ. The origin says where its boundaries are; it cannot say
   * what the client does about them, because it does not know where its nodes
   * will land.
   */
  stateScope:  string;
  /** The document this node came from, for the permalink and static-view link. */
  pageAddress: string;
}

// ── serialize (origin → wire) ─────────────────────────────────────────────────
// Flatten one SourceNode. Its subtree is NOT included: what a caller can ask for
// separately, it asks for separately.
export function serializeNode(node: SourceNode): PortableNode {
  return {
    key:         node.address.key,
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    attrs:       node.attrs.allEntries(),
    // The RESOLVED def, not the authored props: what leaves an origin is what it
    // worked out, and a transform that wants to know what a tag means reads the
    // same answer the renderer would. Its output goes back through `reserve`,
    // which resolves afresh — so a rewritten tag is re-read, never patched.
    tags:        node.tags.map(t => ({ name: t.name, props: t.def.allEntries() })),
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    inherited:   bagToWire(node),
    hasChildren: node.children.length > 0,
    stateScope:  node.pageAddress,
    pageAddress: node.pageAddress,
  };
}

// ── deserialize (wire → client) ───────────────────────────────────────────────
// Rebuild a live SourceNode from what arrived. `address` is stamped from the
// baseUrl the reply came through and the key the node carries — the client's own
// record of who answered, never anything read out of the payload.
//
// `children` starts empty and stays empty until `childrenOf` is asked. A node's
// subtree is not part of it.
export function deserializeNode(node: PortableNode, baseUrl: string): SourceNode {
  return {
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    attrs:       new Multimap(node.attrs),
    tags:        node.tags.map(t => ({ name: t.name, def: new Multimap(t.props) })),
    children:    [],
    address:     { baseUrl, key: node.key },
    pageAddress: node.pageAddress,
    stateScope:  node.stateScope,
    hasChildren: node.hasChildren,
    ...bagFromWire(node.inherited),
  } as SourceNode;
}

// ── Fetched resources ─────────────────────────────────────────────────────────

/**
 * A resource an origin fetched on a caller's behalf, as it crosses the wire.
 *
 * Bytes, and the type the origin declared for them. An `ArrayBuffer` is what
 * structured clone carries without an opinion: it interprets nothing, so a PNG
 * and a stylesheet cross identically and neither is damaged by a decode the
 * wire chose. `res.text()` here would have decided every resource was UTF-8
 * text, which is lossy for everything that is not.
 *
 * The mime is REPORTED, never trusted — an origin can label its bytes anything.
 * It is carried because it is the only thing that says how the bytes are meant
 * to be read, and a caller that needs one (a `data:` URI's mime, a decode's
 * charset) has nowhere else to get it.
 */
export interface FetchedResource {
  mime:  string;
  bytes: ArrayBuffer;
}
