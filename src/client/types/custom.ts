/**
 * types/custom.ts
 *
 * Host-side handling for site-defined custom node types (`{type: mytype}` where
 * `mytype` is not a built-in). The node's SourceNode is round-tripped through the
 * owning origin's OriginEnvoy (a sandboxed iframe running untrusted author code),
 * which returns a SourceNode the engine already knows how to render.
 *
 * This is a near-identical sibling of the transclusion-`link` branch in
 * blastocyte.ts: attach a loading handler → do async work → `replaceHandler` with
 * the result, which re-runs blastocyteFactory.create and re-differentiates into a
 * real (built-in) handler.
 *
 * Reached from blastocyteFactory.create via `createCustomTypeHandler`, which is
 * passed the custom type name. Not registered in the factory registry (the type
 * name is the author's, not ours).
 *
 * Validation gate on the returned node (the node is author-controlled, untrusted):
 *   - output `type` must be a known BUILT-IN (no custom-type recursion in v1);
 *   - depth / node-count caps;
 *   - well-formed shape (guaranteed by deserializeNode, but re-checked cheaply).
 * Any failure / timeout / unreachable origin → render an error node. A custom type
 * that failed to expand is an error, never a silent fall-through to the raw node.
 */

import type { TypeHandler, RenderNode, SourceNode } from '../render-node.js';
import { factoryGet } from '../render-node.js';
import { Multimap } from '../../shared/multimap.js';
import { bagOf } from '../../shared/inherited.js';
import { addressOrigin } from '../../shared/shared.js';
import { envoyFor } from '../envoy-host.js';
import { loadingHandler } from './blastocyte.js';

const MAX_DEPTH = 32;
const MAX_NODES = 5_000;

// Built-in type names that an author transform is allowed to emit. A custom type
// must expand to one of these — never to another custom type (no recursion v1).
function isBuiltinType(typeName: string): boolean {
  // `text` is the implicit default; anything resolvable via the factory registry
  // is a real built-in. Custom types are never registered there.
  return typeName === 'text' || factoryGet(typeName) !== undefined;
}

function nodeType(node: SourceNode): string {
  return node.attrs.get('type') ?? 'text';
}

// Throws if the returned subtree is malformed or violates the safety caps.
function validate(node: SourceNode): void {
  let count = 0;
  const walk = (n: SourceNode, depth: number): void => {
    if (++count > MAX_NODES) throw new Error(`custom type output exceeds ${MAX_NODES} nodes`);
    if (depth > MAX_DEPTH)    throw new Error(`custom type output exceeds depth ${MAX_DEPTH}`);
    if (typeof n.label !== 'string' || !Array.isArray(n.children)) {
      throw new Error('custom type output is malformed');
    }
    const t = nodeType(n);
    if (!isBuiltinType(t)) {
      throw new Error(`custom type output uses non-builtin type '${t}' (no custom-type recursion)`);
    }
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(node, 0);
}

// Build a minimal error node: a `text` node whose label surfaces the failure,
// classed so the site can style it. Re-uses the source node's identity fields so
// permalinks/positioning stay coherent.
function errorNode(original: SourceNode, message: string): SourceNode {
  const attrs = new Multimap();
  attrs.set('type', 'text');
  attrs.append('class', 'node--custom-error');
  return {
    slug:        original.slug,
    permalinkId: original.permalinkId,
    numbering:   original.numbering,
    attrs,
    tags:        [],
    label:       `⚠ custom type failed: ${message}`,
    bodyLines:   [],
    children:    [],
    // Stands in for the failed node, in its place and its document — so it takes
    // the same address and page, and inherits exactly what it had.
    address:     original.address,
    pageAddress: original.pageAddress,
    ...bagOf(original),
  } as SourceNode;
}

/** Entry point called by blastocyteFactory.create for a custom-typed node. */
export function createCustomTypeHandler(rn: RenderNode, typeName: string): TypeHandler {
  const node    = rn.sourceNode;
  const handler = loadingHandler(rn);
  rn.attachHandler(handler);

  const originRoot = addressOrigin(node.pageAddress);

  envoyFor(originRoot)
    .transform(typeName, node)
    .then((result) => {
      (handler.content as any)._stopLoading?.();
      validate(result);
      rn.replaceHandler(result);
    })
    .catch((err: Error) => {
      (handler.content as any)._stopLoading?.();
      rn.replaceHandler(errorNode(node, err.message));
    });

  return handler;
}
