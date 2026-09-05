/**
 * origin-host.ts
 *
 * The client's view of one origin — the only route to content there is.
 *
 * An origin is an attachment point that answers lookups by key. `key` is opaque
 * to the caller — never parsed, never split, never appended to. There is one key
 * space per origin, and an address (`{ baseUrl, key }`) is carried, never
 * derived: nothing in a key says where its origin lives, so keys can look like
 * anything the origin wants and no path is reserved on anyone's server.
 *
 * Every origin lives behind a postMessage. This file owns one invisible
 * sandboxed iframe per baseUrl, loaded from `<baseUrl>/envoy.html`, and turns
 * the five queries into messages across it. What comes back is data: nodes
 * rebuilt from PortableNodes, addresses, booleans, URLs. Nothing that arrives
 * can reach the origin's store, because nothing on this side of the wire is
 * anything but a value.
 *
 * The `.rvmark` storage layout, sigils, fallback chains, media path arithmetic,
 * tag definitions, matching over unfetched content, and now nodetype behaviour
 * all live on the far side. This file knows none of it. It does not know whether
 * an origin implements declared nodetypes or is simply weird about its own
 * nodes; it sees an envoy that has authority over some keys, and asks.
 *
 * Security boundary (load-bearing):
 *   - `src` is ALWAYS the real author-origin URL — never a Blob/srcdoc on our
 *     origin. This is what keeps author code off OUR origin, and it is the whole
 *     of what does: the sandbox flags below do not defend it.
 *   - a reply is matched by `e.source`, never by `e.origin`. The envoy a reply
 *     came through is what stamps a node's `baseUrl` — never a value read out of
 *     the payload.
 *   - what arrives is data, and every node is checked (see `check`) whatever
 *     origin it came from. That check, not the sandbox, is why a hostile envoy
 *     cannot hand us something we will mis-render.
 */

import type { RvNode, FileMeta } from '../shared/parser.js';
import type { PortableNode, FetchedResource } from '../shared/portable-node.js';
import { deserializeNode } from '../shared/portable-node.js';
import { Multimap } from '../shared/multimap.js';
import { addressOrigin } from '../shared/shared.js';
import { factoryGet } from './type-registry.js';

const ENVOY_PATH = '/envoy.html';

/** How long to wait for any one reply before failing it. */
const QUERY_TIMEOUT_MS = 10_000;

// Cap on sends queued while the iframe has not yet fired `load`. An origin that
// is up but ships no envoy is the ordinary failure, not an exotic one — a 404
// body is still a document, so `load` fires and the queue drains. The queue only
// grows without bound when `load` never fires at all, and then every queued send
// is already doomed: each request's own timer fires and rejects it, leaving the
// closure behind with nothing to do. Dropping past the cap costs those requests
// nothing they were not already going to lose.
const MAX_PRELOAD = 64;

/** Where an origin's content is served from, plus one of its keys. */
export interface Address {
  baseUrl: string;
  key:     string;
}

// ── The not-found register ────────────────────────────────────────────────────
//
// One question, asked once per origin: is there an envoy here AT ALL. A baseUrl
// that never answered gets registered, and every later query against it fails
// immediately instead of burning another deadline. The payoff lands on fallback
// chains, which would otherwise pay a full deadline on a dead first candidate
// every time a subtree is expanded — and it makes "origin up, envoy missing"
// legible: one deadline, then an immediate answer, rather than a page that just
// looks slow forever.
//
// What it does NOT register is an origin that answers badly — slowly, partially,
// wrongly. That is origin *health*: a different mechanism with different inputs,
// and there is nothing here to design it against, since one in-process origin
// cannot be sick. A timeout against an envoy that has demonstrably answered
// before is not evidence about whether an envoy exists, and does not count.
//
// It is a named object rather than a Set inlined into `originFor` so that health
// tracking, when Stage 5's foreign envoy shows what unhealthy looks like, is
// this object growing rather than a refactor.
const notFound = {
  _dead: new Set<string>(),

  /** Has this baseUrl been shown to have no envoy? */
  has(baseUrl: string): boolean { return this._dead.has(baseUrl); },

  /** Register that no envoy answered here. Only ever called for an origin that
   *  has never answered — one that has is a health question, not this one. */
  mark(baseUrl: string): void { this._dead.add(baseUrl); },

  /** An origin that answers stops being a candidate for this register, whatever
   *  it does later. */
  clear(baseUrl: string): void { this._dead.delete(baseUrl); },
};

// ── The wire boundary ─────────────────────────────────────────────────────────
//
// Every node from every origin is checked, not just the interesting ones. An
// envoy is untrusted by construction — it runs at its own origin, under its own
// author's control, and nothing about that makes what it says well-formed — and
// that is owed to a node because of where it came from, not because of what kind
// of node it is.
//
// The type check runs the direction that is actually the client's business:
// "`type` must be something I can render". It is not a rule about custom types.
// Whatever nodetypes an origin implements are its own affair and have already
// run by the time a node is on the wire; what this side gets to insist on is
// that it can draw what it was handed.

// A fetched resource, as this side will accept one: bytes, and the type the
// origin declared for them.
//
// The mime is checked for SHAPE, not for membership of any list. It reaches a
// `data:` URI's mime position at one caller, so what it must not contain is a
// character that changes the meaning of that URI — a comma would end the mime
// and start the data, a semicolon would introduce a parameter. A token of
// type/subtype characters cannot do either, whatever it names. Which types are
// useful is the caller's question, and the browser's; it is not answered here.
const MIME_TOKEN = /^[A-Za-z0-9!#$%^&*_\-+.]+\/[A-Za-z0-9!#$%^&*_\-+.]+$/;

function acceptFetched(v: unknown): FetchedResource | null {
  if (typeof v !== 'object' || v === null) return null;
  const { mime, bytes } = v as { mime?: unknown; bytes?: unknown };
  if (!(bytes instanceof ArrayBuffer)) return null;
  if (typeof mime !== 'string' || !MIME_TOKEN.test(mime)) return null;
  return { mime, bytes };
}

const MAX_LABEL   = 64_000;
const MAX_LINES   = 4_000;
const MAX_ENTRIES = 2_000;

function renderable(typeName: string): boolean {
  return typeName === 'text' || factoryGet(typeName) !== undefined;
}

// Throws on anything this side will not accept. Per node, never per batch: one
// bad row in a subtree must not cost the reader the rest of it. The caller turns
// the throw into an error row — a node that failed the boundary is an error,
// never a silent drop.
function check(w: PortableNode): void {
  if (typeof w !== 'object' || w === null) throw new Error('node is not an object');
  if (typeof w.key !== 'string')      throw new Error('node has no key');
  if (typeof w.label !== 'string')    throw new Error('node label is not a string');
  if (!Array.isArray(w.bodyLines))    throw new Error('node bodyLines is not an array');
  if (!Array.isArray(w.attrs))        throw new Error('node attrs is not an entry list');
  if (!Array.isArray(w.tags))         throw new Error('node tags is not an array');
  if (typeof w.pageAddress !== 'string') throw new Error('node has no pageAddress');

  if (w.label.length > MAX_LABEL)      throw new Error(`node label exceeds ${MAX_LABEL} chars`);
  if (w.bodyLines.length > MAX_LINES)  throw new Error(`node exceeds ${MAX_LINES} body lines`);
  if (w.attrs.length > MAX_ENTRIES)    throw new Error(`node exceeds ${MAX_ENTRIES} attrs`);

  const declared = w.attrs.find(e => Array.isArray(e) && e[0] === 'type')?.[1] ?? 'text';
  if (!renderable(declared)) throw new Error(`node has unrenderable type '${declared}'`);
}

// A node that did not survive the boundary, in the shape of a `text` row saying
// so. Classed for styling, and keeping the original's identity fields where they
// were legible at all — it stands in the failed node's place, so it takes its
// place in the numbering too.
function rejected(w: PortableNode, baseUrl: string, message: string): RvNode {
  const attrs = new Multimap();
  attrs.set('type', 'text');
  attrs.append('class', 'node--wire-error');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    slug: str(w?.slug), permalinkId: str(w?.permalinkId), numbering: str(w?.numbering),
    attrs, tags: [], label: `⚠ ${message}`, bodyLines: [],
    children: [], hasChildren: false,
    meta: {}, searchable: false, sidepanel: null,
    address:     { baseUrl, key: str(w?.key) },
    pageAddress: str(w?.pageAddress),
    stateScope:  str(w?.stateScope),
  } as RvNode;
}

// ── One envoy per baseUrl ─────────────────────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

class OriginEnvoy {
  private readonly iframe: HTMLIFrameElement;
  private loaded = false;
  private everAnswered = false;
  private readonly preload: Array<() => void> = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly baseUrl: string) {
    const iframe = document.createElement('iframe');
    // Invisible compute container — not a display surface.
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.display = 'none';

    // An envoy runs at its OWN origin, foreign or not. `src` is the real
    // author-origin URL, so allow-same-origin grants the guest that origin and
    // never ours — the boundary that matters is the one `src` draws.
    //
    // What it buys: envoy.html imports its scripts by relative specifier. At an
    // opaque origin those are cross-origin subresource loads, so a federated
    // peer could only be an origin if its host let it set CORS headers — which
    // rules out the plain static hosts (Neocities and kin) that federation is
    // most worth having. Same-origin loads need no such cooperation.
    //
    // What it costs: a foreign envoy runs with its own site's ambient
    // authority — its cookies and storage, and a credentialed `fetch`. That is
    // the peer's own authority over the peer's own data, exercised by the
    // peer's own code. It is not a capability against us: author code still
    // cannot reach our DOM, our storage, or our origin, and everything it says
    // still crosses as data through `check`.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.src = baseUrl + ENVOY_PATH;

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
    // Filter by source, not origin (same pattern as iframe.ts / iframe-host.ts):
    // identity here is "the frame we created and pointed at this baseUrl", which
    // is a thing we hold, not a string a sender supplies.
    if (e.source !== this.iframe.contentWindow) return;
    const d = e.data;
    if (!d) return;
    if (d.type === 'rvmark-origin-ready') { this.alive(); return; }
    if (d.type !== 'rvmark-origin-reply' || typeof d.id !== 'number') return;
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    clearTimeout(p.timer);
    this.alive();
    if (d.error) p.reject(new Error(String(d.error)));
    else p.resolve(d.result);
  };

  // Anything at all from this envoy settles the only question the register asks.
  private alive(): void {
    this.everAnswered = true;
    notFound.clear(this.baseUrl);
  }

  private post(msg: object): void {
    const send = () => this.iframe.contentWindow?.postMessage(msg, '*');
    if (this.loaded) send();
    else if (this.preload.length < MAX_PRELOAD) this.preload.push(send);
  }

  /** One round trip. Rejects on envoy error, timeout, or a dead origin. */
  ask<T>(query: string, args: unknown[]): Promise<T> {
    if (notFound.has(this.baseUrl)) {
      return Promise.reject(new Error(`no envoy at ${this.baseUrl}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Only an origin that has never answered is evidence of a missing
        // envoy. One that has answered before is slow, which is a different
        // question and not this register's.
        if (!this.everAnswered) notFound.mark(this.baseUrl);
        reject(new Error(`origin query '${query}' timed out (${this.baseUrl})`));
      }, QUERY_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.post({ type: 'rvmark-origin-query', id, query, args });
    });
  }
}

const _envoys = new Map<string, OriginEnvoy>();

function envoyFor(baseUrl: string): OriginEnvoy {
  let envoy = _envoys.get(baseUrl);
  if (!envoy) {
    envoy = new OriginEnvoy(baseUrl);
    _envoys.set(baseUrl, envoy);
  }
  return envoy;
}

// ── The queries an origin answers ─────────────────────────────────────────────
//
// There is deliberately no parentOf. Nothing client-side reads source ancestry —
// every parent relationship acted on is a rendered-tree one — so an origin that
// wanted to support "show this in context" would add it as one query among
// others it chooses to answer.

export interface Origin {
  node(key: string):                             Promise<RvNode | null>;
  childrenOf(key: string):                       Promise<RvNode[]>;
  resolve(key: string, refs: string[]):          Promise<Address[][]>;
  hasMatchBelow(keys: string[], q: string):      Promise<boolean[]>;
  resolveResources(key: string, refs: string[]): Promise<(string | null)[]>;
  fetchResources(key: string, refs: string[]):   Promise<(FetchedResource | null)[]>;
  meta(key: string):                             Promise<FileMeta>;
}

class RemoteOrigin implements Origin {
  constructor(private readonly baseUrl: string) {}

  private ask<T>(query: string, args: unknown[]): Promise<T> {
    return envoyFor(this.baseUrl).ask<T>(query, args);
  }

  // A node's baseUrl is the envoy that answered, never a field on the payload.
  // That is what makes an origin unable to claim another's content: it can put
  // whatever it likes on the wire and still only ever answers for itself.
  private live(wire: PortableNode | null): RvNode | null {
    if (!wire) return null;
    return this.accept(wire);
  }

  // One node past the boundary. What fails the check comes back as an error row
  // standing in its place: it keeps the node's identity, so permalinks and
  // positioning stay coherent, and says plainly what went wrong.
  private accept(wire: PortableNode): RvNode {
    try {
      check(wire);
      return deserializeNode(wire, this.baseUrl);
    } catch (err) {
      return rejected(wire, this.baseUrl, (err as Error).message);
    }
  }

  async node(key: string): Promise<RvNode | null> {
    return this.live(await this.ask<PortableNode | null>('node', [key]));
  }

  async childrenOf(key: string): Promise<RvNode[]> {
    const wire = await this.ask<PortableNode[]>('childrenOf', [key]);
    if (!Array.isArray(wire)) throw new Error('childrenOf did not answer with a list');
    return wire.map(w => this.accept(w));
  }

  resolve(key: string, refs: string[]): Promise<Address[][]> {
    return this.ask<Address[][]>('resolve', [key, refs]);
  }

  hasMatchBelow(keys: string[], q: string): Promise<boolean[]> {
    return this.ask<boolean[]>('hasMatchBelow', [keys, q]);
  }

  resolveResources(key: string, refs: string[]): Promise<(string | null)[]> {
    return this.ask<(string | null)[]>('resolveResources', [key, refs]);
  }

  // Checked at the wire, like every other thing an envoy says. Bytes are bytes:
  // an ArrayBuffer carries whatever it carries and interprets nothing, so there
  // is no reading of it for this check to get wrong. The mime is checked for
  // shape (see MIME_TOKEN) because it lands in a position where punctuation
  // would mean something. Anything else is a null — the caller already draws a
  // fallback for that.
  //
  // What the bytes ARE is not decided here, and must not be: this side cannot
  // know what a caller intends to do with a resource, and a check that guessed
  // would be a policy about which resources an author may use, written where no
  // author would think to look for one.
  //
  // Script in the payload is not the risk it looks like — but it is only not a
  // risk because of WHERE the bytes go. SVG referenced as an image resource
  // (mask, background-image, <img>) renders in a mode where script does not run
  // and external references are blocked. That safety belongs to the caller that
  // puts the bytes in an image position and holds only for as long as it does;
  // it is a rendering rule, not something checked here.
  async fetchResources(key: string, refs: string[]): Promise<(FetchedResource | null)[]> {
    const wire = await this.ask<unknown[]>('fetchResources', [key, refs]);
    if (!Array.isArray(wire)) throw new Error('fetchResources did not answer with a list');
    return refs.map((_, i) => acceptFetched(wire[i]));
  }

  async meta(key: string): Promise<FileMeta> {
    return new Multimap(await this.ask<Array<[string, string]>>('meta', [key]));
  }
}

const _origins = new Map<string, Origin>();

// Keyed on baseUrl, not on a bare origin: two sites may share a host, and an
// origin is free to live at any path.
export function originFor(baseUrl: string): Origin {
  let origin = _origins.get(baseUrl);
  if (!origin) {
    origin = new RemoteOrigin(baseUrl);
    _origins.set(baseUrl, origin);
  }
  return origin;
}

// ── Addresses ─────────────────────────────────────────────────────────────────

/** Split a canonical address into the pair. Local addresses take this origin. */
export function addressOf(canonical: string): Address {
  const baseUrl = addressOrigin(canonical) || currentBaseUrl();
  return { baseUrl, key: canonical.slice(addressOrigin(canonical).length) };
}

function currentBaseUrl(): string {
  return typeof location !== 'undefined' ? location.origin : '';
}

// ── Refs ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a raw ref, written on the node at `from`, to the node it names.
 *
 * The ref crosses as the author wrote it. Sigils, fallback chains, `.rvmark`
 * suffixing and path arithmetic are all origin-side and no caller learns that
 * any of them exist. What comes back is candidate addresses, in order, and the
 * walk over them happens HERE rather than inside the origin: a fallback chain
 * falls through only when a load *fails*, and an origin must not fetch what a
 * foreign address points at — producing the node would mean parsing another
 * origin's content, which is the thing the boundary exists to stop.
 *
 * Accepts an entry with or without its '^' prefix — the prefix selects what the
 * caller does with the result, and never changes which node is resolved.
 */
export async function resolveRefAt(from: Address, rawRef: string | null | undefined): Promise<RvNode | null> {
  if (!rawRef) return null;
  try {
    const candidates = (await originFor(from.baseUrl).resolve(from.key, [rawRef]))[0] ?? [];
    for (const { baseUrl, key } of candidates) {
      const node = await originFor(baseUrl).node(key).catch(() => null);
      if (node) return node;
    }
    return null;
  } catch { return null; }
}

/** `resolveRefAt` for a ref written on a node the caller holds. */
export function resolveRefOn(node: RvNode, rawRef: string | null | undefined): Promise<RvNode | null> {
  return resolveRefAt(node.address, rawRef);
}

/**
 * A media/asset ref written on a node the caller holds → the URL it is served
 * from, or null.
 *
 * Relative refs resolve against the document the node came FROM, so a
 * transcluded foreign node gets its own origin's assets — the same rule
 * markdown media and transclusion refs already follow.
 */
export async function resolveMediaOn(node: RvNode, ref: string | null | undefined): Promise<string | null> {
  return (await resolveMediaAllOn(node, [ref]))[0];
}

/**
 * `resolveMediaOn` for a caller holding several refs at once — a label's spans,
 * a bullet and its open variant. One query, answered positionally, so the wire
 * carries one message per caller rather than one per ref.
 */
export async function resolveMediaAllOn(
  node: RvNode,
  refs: (string | null | undefined)[],
): Promise<(string | null)[]> {
  // Keyed off pageAddress, not the node's own key: a client-minted stand-in (a
  // loading marker, an error row) has no key — nothing served it — but it does
  // sit in its host's document, and that is what a relative ref resolves against.
  const { baseUrl } = node.address;
  try {
    return await originFor(baseUrl)
      .resolveResources(node.pageAddress.slice(baseUrl.length), refs.map(r => r || ''));
  } catch { return refs.map(() => null); }
}

/**
 * `resolveMediaAllOn` for a caller that needs the bytes rather than a URL —
 * because it must paint without watching the load (the bullet mask), or because
 * the URL is a foreign origin's and only that origin can read it without CORS.
 * A null is the ref failing, known before anything is built from it.
 */
export async function fetchMediaAllOn(
  node: RvNode,
  refs: (string | null | undefined)[],
): Promise<(FetchedResource | null)[]> {
  const { baseUrl } = node.address;
  try {
    return await originFor(baseUrl)
      .fetchResources(node.pageAddress.slice(baseUrl.length), refs.map(r => r || ''));
  } catch { return refs.map(() => null); }
}

/**
 * `fetchMediaAllOn` for a caller holding an address rather than a node — an
 * sidepanel strategy, which is handed the file its ref was written in and never
 * the node that wrote it. Same query, same reason to use it: the origin can
 * read its own files without CORS and nothing here can.
 */
export async function fetchMediaAllAt(
  sourceFileAddress: string,
  refs: (string | null | undefined)[],
): Promise<(FetchedResource | null)[]> {
  const { baseUrl, key } = addressOf(sourceFileAddress);
  try {
    return await originFor(baseUrl).fetchResources(key, refs.map(r => r || ''));
  } catch { return refs.map(() => null); }
}

// ── Structure ─────────────────────────────────────────────────────────────────

/**
 * The children of a node the caller holds.
 *
 * Structure is a query. A node arrives knowing only WHETHER it has children
 * (`hasChildren`, which is what draws a collapsed row's toggle); what they ARE
 * costs a round trip, paid when something actually expands.
 *
 * Nothing is parked on the node. The answer is handed to the caller and owned
 * by whatever mounts it — `_childSlots` for a rendered row — so a teardown is
 * a real release rather than one reference dropped among several. Re-expanding
 * a subtree therefore costs a round trip again, which is the price of the
 * client's heap not growing with everything it has ever looked at.
 */
export async function childrenOf(node: RvNode): Promise<RvNode[]> {
  if (!node.hasChildren) return [];
  // A stand-in has no key, so there is no one to ask. It never has children
  // either, but a caller should not have to know that to be safe here.
  if (!node.address.key) return [];
  try {
    return await originFor(node.address.baseUrl).childrenOf(node.address.key);
  } catch {
    return [];
  }
}
