/**
 * portable-node.ts
 *
 * PortableNode — the postMessage-safe projection of a SourceNode.
 *
 * A SourceNode cannot cross a postMessage boundary as-is: its `attrs` and
 * `tags[].props` are `Multimap` instances (methods don't survive structured
 * clone — see multimap.ts), and it carries a live `sourceFile` back-reference
 * (parser.ts) — the trusted host capability bundle (resolveMediaUrl, the loader,
 * tag defs) that untrusted author code must never receive.
 *
 * PortableNode is the flattened form that CAN leave the host realm: plain
 * strings + arrays, multimaps as `[[k, v], …]` entry lists, no `sourceFile`.
 * Node data — including inherited properties (inherited.ts) — crosses intact;
 * only the host capability bundle is withheld.
 * `serializeNode`/`deserializeNode` are the only conversions; both are pure.
 *
 * Strategic note: the data/host-context line drawn here — node data on one side,
 * `sourceFile` on the other — is exactly where the OriginEnvoy boundary will
 * eventually sit. The `sourceFile` paradigm is intended to retire, with per-origin
 * loader logic migrating into the envoy; PortableNode is already the shape that
 * survives that move. For now the host keeps `sourceFile`: serialize drops it,
 * deserialize re-stamps it.
 */

import { Multimap } from './multimap.js';
import type { SourceNode } from './parser.js';
import type { SourceFile } from './source-file.js';
import { bagOf, emptyBag, type InheritedBag } from './inherited.js';

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
  inherited:   InheritedBag;
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
    inherited:   bagOf(node),
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
export function deserializeNode(node: PortableNode, sourceFile: SourceFile): SourceNode {
  return {
    slug:        node.slug,
    permalinkId: node.permalinkId,
    numbering:   node.numbering,
    attrs:       new Multimap(node.attrs),
    tags:        node.tags.map(t => ({ name: t.name, props: new Multimap(t.props) })),
    label:       node.label,
    bodyLines:   node.bodyLines.slice(),
    children:    node.children.map(c => deserializeNode(c, sourceFile)),
    sourceFile,
    // A transform may mint a node from scratch and omit these; fall back to the
    // empty bag so every rebuilt node is well-formed.
    ...emptyBag(),
    ...node.inherited,
  } as SourceNode;
}
