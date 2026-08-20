/**
 * portable-node.ts
 *
 * PortableNode — the postMessage-safe projection of a SourceNode.
 *
 * A SourceNode cannot cross a postMessage boundary as-is: its `attrs` and
 * `tags[].props` are `Multimap` instances (methods don't survive structured
 * clone — see multimap.ts), and it carries a `served` (served.ts) holding live
 * closures over the origin's own store, which untrusted author code must never
 * receive.
 *
 * PortableNode is the flattened form that CAN leave the host realm: plain
 * strings + arrays, multimaps as `[[k, v], …]` entry lists, no `served`.
 * Inherited values flatten the same way, but by their own declaration rather
 * than here: a bag value may be any type the registry admits, so inherited.ts
 * carries the toWire/fromWire pair and this module just calls it.
 * Node data — including inherited properties (inherited.ts) — crosses intact;
 * only the origin's own capabilities are withheld.
 * `serializeNode`/`deserializeNode` are the only conversions; both are pure.
 *
 * Strategic note: the line drawn here — node data on one side, the origin's
 * resolution capabilities on the other — is exactly where the OriginEnvoy
 * boundary will sit. Serialize drops `served`; deserialize asks the origin to
 * re-serve, which is the same handoff a real wire will make.
 */

import { Multimap } from './multimap.js';
import type { SourceNode } from './parser.js';
import type { Reserve } from './served.js';
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
// Flatten a SourceNode (subtree included) to a PortableNode. Drops `sourceFile`
// — the trusted host capability bundle — and nothing else.
export function serializeNode(node: SourceNode): PortableNode {
  return {
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    attrs:       node.attrs.allEntries(),
    tags:        node.tags.map(t => ({ name: t.name, props: t.props.allEntries() })),
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    children:    node.children.map(serializeNode),
    inherited:   bagToWire(node),
  };
}

// ── deserialize (wire → host) ─────────────────────────────────────────────────
// Rebuild a SourceNode from a PortableNode, re-stamping the host's trusted
// `sourceFile` on every node in the subtree.
//
// Inherited properties (inherited.ts) cross the wire like any other node data.
// An envoy always serves the origin of the document it transforms, so the code
// on the far side is that document's own author deciding how their own nodes
// should be interpreted — which is exactly whose call it is. The sandbox exists
// to keep author code off the host's origin, not to second-guess the values it
// reports about its own content.
export function deserializeNode(node: PortableNode, reserve: Reserve): SourceNode {
  const attrs = new Multimap(node.attrs);
  const tags  = node.tags.map(t => ({ name: t.name, props: new Multimap(t.props) }));
  return {
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    attrs,
    tags,
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    children:    node.children.map(c => deserializeNode(c, reserve)),
    // Re-served, not copied: a transform may have rewritten attrs and tags, and
    // what those mean is the origin's to say.
    served:      reserve({ attrs, tags, slug: node.slug }),
    // bagFromWire fills anything the wire omitted — a transform may mint a node
    // from scratch — so every rebuilt node is well-formed.
    ...bagFromWire(node.inherited),
  } as SourceNode;
}
