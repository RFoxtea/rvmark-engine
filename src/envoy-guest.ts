/**
 * envoy-guest.ts
 *
 * Guest side of the OriginEnvoy protocol — runs INSIDE the sandboxed envoy.html
 * iframe (an opaque cross-origin realm). Sibling of iframe-guest.ts.
 *
 * This is OUR trusted shim that brokers between the host protocol and the
 * untrusted author transforms.
 *
 * Authoring contract (idiomatic plugin shape — like a Rollup/Vite plugin or an
 * ESLint flat-config entry): a site's custom-type file is a side-effect-free
 * module that DEFAULT-EXPORTS a `CustomType` descriptor and imports nothing from
 * us except types (erased at compile). The build generates envoy.html's entry
 * glue, which imports each descriptor and calls `registerTransform` itself —
 * registration is our concern, not the author's. Type names are self-declared
 * via the descriptor's `type` field; the build does not derive them from filenames.
 *
 *   // custom-types/mytype.ts  (author writes only this)
 *   import type { PortableNode } from 'rvmark/envoy';
 *   export default {
 *     type: 'mytype',
 *     transform: (node: PortableNode): PortableNode => node,
 *   } satisfies CustomType;
 *
 * Protocol (matches envoy-host.ts):
 *   host → guest: { type: 'rvmark-envoy-transform', id, transformType, node }
 *   guest → host: { type: 'rvmark-envoy-reply', id, node }            (success)
 *                 { type: 'rvmark-envoy-reply', id, error }           (failure)
 *
 * `node` is a PortableNode (plain data — see portable-node.ts). Author transforms
 * receive and return that plain shape; they never see a live SourceNode or the
 * host's sourceFile.
 */

import type { PortableNode } from './portable-node.js';

export type Transform = (node: PortableNode) => PortableNode | Promise<PortableNode>;

/** The default-exported descriptor a site custom-type module declares. */
export interface CustomType {
  readonly type:      string;
  readonly transform: Transform;
}

const _transforms = new Map<string, Transform>();

/** Internal — called by the build-generated envoy.html glue for each descriptor.
 *  Not part of the author contract; authors default-export a CustomType instead. */
export function registerTransform(descriptor: CustomType): void {
  _transforms.set(descriptor.type, descriptor.transform);
}

if (typeof window !== 'undefined' && window.parent !== window) {
  window.addEventListener('message', async (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.type !== 'rvmark-envoy-transform' || typeof d.id !== 'number') return;

    const reply = (msg: object) => window.parent.postMessage({ ...msg, type: 'rvmark-envoy-reply', id: d.id }, '*');

    const fn = _transforms.get(d.transformType);
    if (!fn) {
      reply({ error: `no transform registered for type '${d.transformType}'` });
      return;
    }
    try {
      const out = await fn(d.node as PortableNode);
      reply({ node: out });
    } catch (err) {
      reply({ error: String((err as Error)?.message ?? err) });
    }
  });
}
