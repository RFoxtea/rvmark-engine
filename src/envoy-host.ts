/**
 * envoy-host.ts
 *
 * Host (main-page) side of the OriginEnvoy protocol. Pairs with envoy-guest.ts,
 * mirroring the iframe-host.ts / iframe-guest.ts split.
 *
 * An OriginEnvoy is the host's local representative of one origin. It owns a
 * single long-lived, invisible, cross-origin **sandboxed** iframe loaded from
 * `<origin-root>/envoy.html`, and round-trips custom-nodetype transform requests
 * through it. Author code runs inside that iframe — never in the host page.
 *
 * Today the envoy only runs SourceNode→SourceNode transforms; it is designed to
 * grow into the home for all origin-specific behavior (hooks, commands, state).
 *
 * Envoys are created LAZILY, per origin, on first request, then cached and reused.
 * One iframe per origin; concurrent requests are multiplexed by a numeric id.
 *
 * Security boundary (load-bearing):
 *   - sandbox="allow-scripts" WITHOUT allow-same-origin → the iframe runs at an
 *     opaque origin: author `fetch` is anonymous / CORS-bound and carries none of
 *     our cookies/storage; author code cannot touch our DOM, storage, or origin.
 *   - `src` is ALWAYS the real author-origin URL — never a Blob/srcdoc on our
 *     origin (that would hand author code OUR origin and defeat the boundary).
 */

import type { SourceNode } from './parser.js';
import type { PortableNode } from './portable-node.js';
import { serializeNode, deserializeNode } from './portable-node.js';

const ENVOY_PATH = '/envoy.html';

// How long to wait for a transform reply before failing it (error node).
const TRANSFORM_TIMEOUT_MS = 10_000;

interface PendingTransform {
  resolve: (node: PortableNode) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

class OriginEnvoy {
  private readonly iframe: HTMLIFrameElement;
  private loaded = false;
  private readonly preload: Array<() => void> = [];
  private readonly pending = new Map<number, PendingTransform>();
  private nextId = 1;

  constructor(private readonly originRoot: string) {
    const iframe = document.createElement('iframe');
    // Invisible compute container — not a display surface.
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.display = 'none';

    // Sandbox policy keyed off the RESOLVED origin (never wire data):
    //   - FOREIGN origin (federation): allow-scripts ONLY → opaque origin. The
    //     author is untrusted; the opaque sandbox is the security boundary. Its
    //     subresources (envoy.html's scripts) are then cross-origin and the
    //     foreign server must serve them with CORS (its responsibility, on its
    //     own origin).
    //   - SAME origin (this site's own custom types): the "author" IS the site
    //     owner, who can already run anything on this origin — there is no trust
    //     boundary to defend. Add allow-same-origin so the envoy can same-origin
    //     `import` its scripts without CORS. Matches the same-origin branch in
    //     types/iframe.ts. NEVER granted to a foreign origin.
    const isSameOrigin = originRoot === window.location.origin;
    iframe.setAttribute('sandbox', isSameOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts');
    iframe.src = originRoot + ENVOY_PATH;

    iframe.addEventListener('load', () => {
      this.loaded = true;
      for (const fn of this.preload) fn();
      this.preload.length = 0;
    });

    window.addEventListener('message', this.onMessage);
    document.body.appendChild(iframe);
    this.iframe = iframe;
  }

  private onMessage = (e: MessageEvent): void => {
    // Opaque-origin sandbox reports e.origin === "null", so we filter by source
    // (same pattern as iframe.ts / iframe-host.ts) rather than by origin.
    if (e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.type !== 'rvmark-envoy-reply' || typeof d.id !== 'number') return;
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.error) p.reject(new Error(String(d.error)));
    else p.resolve(d.node as PortableNode);
  };

  private post(msg: object): void {
    const send = () => this.iframe.contentWindow?.postMessage(msg, '*');
    if (this.loaded) send();
    else this.preload.push(send);
  }

  /** Round-trip one node through the author's transform for `typeName`.
   *  Rejects on author error, timeout, or a missing registration. */
  transform(typeName: string, node: SourceNode): Promise<SourceNode> {
    const sourceFile = node.sourceFile;
    const id = this.nextId++;
    const wire = serializeNode(node);

    return new Promise<SourceNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`envoy transform '${typeName}' timed out (${this.originRoot})`));
        }
      }, TRANSFORM_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (portable) => resolve(deserializeNode(portable, sourceFile)),
        reject,
        timer,
      });

      this.post({ type: 'rvmark-envoy-transform', id, transformType: typeName, node: wire });
    });
  }
}

// ── Lazy per-origin registry ───────────────────────────────────────────────────

const _envoys = new Map<string, OriginEnvoy>();

/** Get (or lazily create) the envoy for an origin root, e.g.
 *  'https://thissite.com' or 'https://alice.example'. */
export function envoyFor(originRoot: string): OriginEnvoy {
  let envoy = _envoys.get(originRoot);
  if (!envoy) {
    envoy = new OriginEnvoy(originRoot);
    _envoys.set(originRoot, envoy);
  }
  return envoy;
}

export type { OriginEnvoy };
