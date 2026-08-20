/**
 * portable-node.ts
 *
 * PortableNode — the postMessage-safe projection of a SourceNode.
 *
 * A SourceNode cannot cross a postMessage boundary as-is: its `attrs` and its
 * tags' defs are `Multimap` instances, and methods do not survive structured
 * clone (multimap.ts).
 *
 * PortableNode is the flattened form that CAN leave the host realm: plain
 * strings + arrays, multimaps as `[[k, v], …]` entry lists. Inherited values
 * flatten the same way, but by their own declaration rather than here: a bag
 * value may be any type the registry admits, so inherited.ts carries the
 * toWire/fromWire pair and this module just calls it.
 *
 * What a node no longer has to be stripped OF is capabilities. It carries none:
 * a served node is data throughout, and the two closures that used to ride on
 * it became queries (`Origin.resolveResource`, `Origin.reserve`). So this is a
 * shape conversion and nothing else.
 *
 * The asymmetry that remains is about authority rather than access. What goes
 * out is resolved — the answers the origin worked out. What comes back has been
 * rewritten by author code, so its attrs and tags are claims, and `reserve`
 * re-resolves them against the document rather than trusting them. Deserialize
 * is async for that reason: asking is a round trip.
 */

import { Multimap } from './multimap.js';
import type { SourceNode } from './parser.js';
import type { Reserve } from './parser.js';
import { bagToWire, bagFromWire, type WireBag } from './inherited.js';

type Entries = Array<[string, string]>;

export interface PortableTag {
  name:  string;
  props: Entries;
}

export interface PortableNode {
  slug:        string;
  permalinkId: string;
  numbering:   string;
  attrs:       Entries;
  tags:        PortableTag[];
  label:       string;
  bodyLines:   string[];
  children:    PortableNode[];
  inherited:   WireBag;
}

// ── serialize (host → wire) ───────────────────────────────────────────────────
// Flatten a SourceNode (subtree included) to a PortableNode. A pure shape
// change: nothing is withheld, because nothing on a node is a capability.
export function serializeNode(node: SourceNode): PortableNode {
  return {
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
    children:    node.children.map(serializeNode),
    inherited:   bagToWire(node),
  };
}

// ── deserialize (wire → host) ─────────────────────────────────────────────────
// Rebuild a SourceNode from a PortableNode, re-resolving every node in the
// subtree against the document it belongs to.
//
// Inherited properties (inherited.ts) cross the wire like any other node data.
// An envoy always serves the origin of the document it transforms, so the code
// on the far side is that document's own author deciding how their own nodes
// should be interpreted — which is exactly whose call it is. The sandbox exists
// to keep author code off the host's origin, not to second-guess the values it
// reports about its own content.
export async function deserializeNode(node: PortableNode, reserve: Reserve): Promise<SourceNode> {
  const attrs = new Multimap(node.attrs);
  const tags  = node.tags.map(t => ({ name: t.name, props: new Multimap(t.props) }));
  return {
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    children:    await Promise.all(node.children.map(c => deserializeNode(c, reserve))),
    // Re-resolved, not copied: a transform may have rewritten attrs and tags,
    // and what those mean is the origin's to say. This overwrites the authored
    // attrs and tags built above with their resolved forms.
    ...await reserve({ attrs, tags, slug: node.slug }),
    // bagFromWire fills anything the wire omitted — a transform may mint a node
    // from scratch — so every rebuilt node is well-formed.
    ...bagFromWire(node.inherited),
  } as SourceNode;
}
