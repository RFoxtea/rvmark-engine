/**
 * envoy-guest.ts
 *
 * The origin's side of the wire — runs INSIDE the sandboxed envoy.html iframe,
 * an opaque cross-origin realm. Sibling of iframe-guest.ts; pairs with
 * client/origin-host.ts.
 *
 * This is where an origin lives. It answers the five queries against
 * origin.ts's in-process implementation, serializing each node on the way out.
 * The client never reaches that implementation: what it holds is a message
 * channel and whatever came back through it.
 *
 * ── Nodetypes ────────────────────────────────────────────────────────────────
 *
 * A custom nodetype is not a transform the client asks for. It is a bundle of
 * behaviour this envoy provides for nodes it owns, and transform is the first
 * part of it to exist. So it is applied HERE, as a step inside answering
 * `node(key)`, with the file in hand — which is why there is no re-serving on
 * the far side and no second frame: a transform's output is resolved by the
 * same origin that resolved its input, in the same step.
 *
 * The core stays unaware of what a nodetype IS. It does not read
 * `attrs.get('type')` and dispatch; it offers each served node to every
 * registration and takes the first that claims it. That costs a loop per node
 * and buys the property that this file names no nodetype vocabulary at all.
 * The client, correspondingly, cannot tell whether an envoy is implementing a
 * declared nodetype or is simply weird about its own nodes.
 *
 * Authoring contract (idiomatic plugin shape — like a Rollup/Vite plugin or an
 * ESLint flat-config entry): a site's custom-type file is a side-effect-free
 * module that DEFAULT-EXPORTS a `CustomType` descriptor and imports nothing from
 * us except types (erased at compile). The build generates envoy.html's entry
 * glue, which imports each descriptor and calls `registerTransform` itself —
 * registration is our concern, not the author's.
 *
 *   // custom-types/mytype.ts  (author writes only this)
 *   import type { PortableNode } from 'rvmark/envoy';
 *   export default {
 *     type: 'mytype',
 *     transform: (node: PortableNode): PortableNode => node,
 *   } satisfies CustomType;
 *
 * Protocol (matches client/origin-host.ts):
 *   host → guest: { type: 'rvmark-origin-query', id, query, args }
 *   guest → host: { type: 'rvmark-origin-reply', id, result }   (success)
 *                 { type: 'rvmark-origin-reply', id, error }    (failure)
 *
 * Nodes cross as PortableNodes (plain data — see portable-node.ts). Author
 * transforms receive and return that plain shape; they never see a live
 * SourceNode or this origin's store.
 */

import type { PortableNode } from '../shared/portable-node.js';
import { serializeNode } from '../shared/portable-node.js';
import type { SourceNode } from '../shared/parser.js';
import { originFor, type Address } from './origin.js';

export type Transform = (node: PortableNode) => PortableNode | Promise<PortableNode>;

/** The default-exported descriptor a site custom-type module declares. */
export interface CustomType {
  readonly type:      string;
  readonly transform: Transform;
}

/**
 * A registration as this file sees it: something that says whether it claims a
 * node, and what to do with one it claims. `type` does not appear.
 *
 * That is the whole of the core's knowledge about nodetypes, and it is
 * deliberately less than the author contract holds. `registerTransform` reads
 * the descriptor's `type` ONCE, at registration, and closes over it in a
 * predicate; from then on the serving path only ever calls the predicate. So the
 * `{type: …}` convention lives in one line of adapter, alongside the rest of the
 * `.rvmark` storage conventions, rather than in the loop that runs on every
 * node.
 *
 * The cost is a linear scan per served node instead of a map lookup. That is
 * paid knowingly: a map keyed on type name would put nodetype vocabulary in the
 * serving path, and the point of the boundary is that a client cannot tell
 * whether an envoy implements declared nodetypes or is simply weird about its
 * own nodes.
 */
interface Registration {
  claims:    (node: SourceNode) => boolean;
  transform: Transform;
}

// In declaration order. First claim wins.
const _registrations: Registration[] = [];

/** Internal — called by the build-generated envoy.html glue for each descriptor.
 *  Not part of the author contract; authors default-export a CustomType instead. */
export function registerTransform(descriptor: CustomType): void {
  const declared = descriptor.type;
  _registrations.push({
    // The one place `{type: …}` is read. A `.rvmark` storage convention, bound
    // here at registration and never consulted by the serving path again.
    claims:    (node) => node.attrs.get('type') === declared,
    transform: descriptor.transform,
  });
}

// ── Serving ───────────────────────────────────────────────────────────────────

// The one thing the core asks about a registration: does it claim this node.
function claimant(node: SourceNode): Registration | undefined {
  return _registrations.find(r => r.claims(node));
}

// Serve one node: serialize it, and if something claims it, run that and resolve
// the result against the document the input came from. Bound before the call, so
// nothing the transform returns gets a say in which document interprets it.
async function serve(node: SourceNode): Promise<PortableNode> {
  const wire = serializeNode(node);
  const claim = claimant(node);
  if (!claim) return wire;

  const out = await claim.transform(structuredClone(wire));
  return reserveWire(node, out);
}

// Re-resolve a transform's output against its input's document. The authored
// attrs and tags it came back with are claims; what they MEAN is the origin's
// reading, so they are resolved afresh rather than trusted. Identity fields come
// from the input: a transform rewrites what a node is, never which node it is.
async function reserveWire(from: SourceNode, out: PortableNode): Promise<PortableNode> {
  const origin = originFor(from.address.baseUrl);
  const reserved = await origin.reserveWire(from.address.key, out);
  return {
    ...out,
    ...reserved,
    key:         from.address.key,
    pageAddress: from.pageAddress,
  };
}

// ── The query surface ─────────────────────────────────────────────────────────

const QUERIES: Record<string, (args: any) => Promise<unknown>> = {
  async node([key]: [string]) {
    const n = await originFor(base()).node(key);
    return n ? await serve(n) : null;
  },

  async childrenOf([key]: [string]) {
    const kids = await originFor(base()).childrenOf(key);
    return Promise.all(kids.map(serve));
  },

  async resolve([key, refs]: [string, string[]]): Promise<Address[][]> {
    return originFor(base()).resolve(key, refs);
  },

  async hasMatchBelow([keys, q]: [string[], string]) {
    return originFor(base()).hasMatchBelow(keys, q);
  },

  async resolveResources([key, refs]: [string, string[]]) {
    return originFor(base()).resolveResources(key, refs);
  },

  async fetchResources([key, refs]: [string, string[]]) {
    return originFor(base()).fetchResources(key, refs);
  },

  async meta([key]: [string]) {
    return [...(await originFor(base()).meta(key)).allEntries()];
  },
};

// This origin's own base URL. An envoy serves the origin it was loaded from and
// no other — the client addresses an origin by loading ITS envoy, so there is
// nothing here to pick between, and nothing on the wire says which origin a
// query is for.
function base(): string {
  return location.origin;
}

if (typeof window !== 'undefined' && window.parent !== window) {
  window.addEventListener('message', async (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.type !== 'rvmark-origin-query' || typeof d.id !== 'number') return;

    const reply = (msg: object) =>
      window.parent.postMessage({ ...msg, type: 'rvmark-origin-reply', id: d.id }, '*');

    const fn = QUERIES[d.query];
    if (!fn) { reply({ error: `unknown query '${d.query}'` }); return; }

    try {
      reply({ result: await fn(Array.isArray(d.args) ? d.args : []) });
    } catch (err) {
      reply({ error: String((err as Error)?.message ?? err) });
    }
  });

  // Nothing is served until the registrations are in. The glue below this
  // script's import runs synchronously after it, so by the time a message can be
  // dispatched (a task, not a microtask) every descriptor is registered.
  window.parent.postMessage({ type: 'rvmark-origin-ready' }, '*');
}
