/**
 * origin.ts
 *
 * The `.rvmark` origin — what a client is asking when it asks an envoy anything.
 *
 * An origin is an attachment point that answers lookups by key. `key` is opaque
 * to the caller — never parsed, never split, never appended to. There is one key
 * space per origin, and an address (`{ baseUrl, key }`) is carried, never
 * derived: nothing in a key says where its origin lives, so keys can look like
 * anything the origin wants and no path is reserved on anyone's server.
 *
 * This runs inside the envoy: envoy-guest.ts serves these queries over
 * postMessage, and nothing on the client's side of that wire can reach in here.
 * The one exception is not an exception at all — the builder imports this tier
 * directly in Node, because the builder IS origin-side code with the whole store
 * in hand, on the same side of the boundary as the loader and the parser.
 * Nothing in this tier may name `window` or mount an iframe, or that property is
 * lost.
 *
 * What lives here is everything about where content comes from — the `.rvmark`
 * storage layout (`/_rvmark/`, index.rvmark chains, `.rvmark` suffixing), sigil
 * declarations, fallback chains, media path arithmetic, tag definitions, and
 * matching over content the caller does not hold. What does NOT live here is
 * anything about rendering, and anything about nodetypes: a nodetype is
 * behaviour an envoy provides for its own nodes, applied by envoy-guest.ts on
 * the way out, and this file does not know that the concept exists.
 *
 * A node leaves here already resolved, and flat: its `attrs` have their tags'
 * `node.*` overrides merged in, its `tags` carry their looked-up definitions,
 * and it knows its own address. Those are ordinary fields rather than a
 * compartment, because a reader has no use for the authored form and no way to
 * resolve it — there is nothing for a second view to be a view of. Every field
 * is data: what a reader cannot compute it asks for, so nothing that crosses
 * the wire can hold this module's store open.
 */

import type { SourceNode, NodeAttrs, FileMeta, OriginDef, Tag } from '../shared/parser.js';
import {
  resolveSlugInFile, resolveAddress, resolveMediaAddress, addressToSlug, addressOrigin,
  parseTranscludeEntry, RVMARK_SEGMENT,
} from '../shared/shared.js';
import { loadRvmarkFile, invalidateLoaderCaches } from './loader.js';
import type { SourceFile } from './source-file.js';
import { nodeTextMatches } from '../shared/search-match.js';
import { Multimap } from '../shared/multimap.js';
import type { FetchedResource } from '../shared/portable-node.js';

/** The resolved half of a transformed node, in the form the wire carries. */
export interface WireReserved {
  attrs:      Array<[string, string]>;
  tags:       Array<{ name: string; props: Array<[string, string]> }>;
  stateScope: string;
}

/** Where an origin's content is served from, plus one of its keys. */
export interface Address {
  baseUrl: string;
  key:     string;
}


/**
 * The queries an origin answers.
 *
 * There is deliberately no parentOf. Nothing client-side reads source ancestry —
 * every parent relationship acted on is a rendered-tree one — so an origin that
 * wanted to support "show this in context" would add it as one query among
 * others it chooses to answer. It is not part of what an origin must do, and
 * adding it before something asks would fix an answer nobody needs yet.
 */
export interface Origin {
  node(key: string):                        Promise<SourceNode | null>;
  childrenOf(key: string):                  Promise<SourceNode[]>;
  resolve(key: string, refs: string[]):     Promise<Address[][]>;
  hasMatchBelow(keys: string[], q: string): Promise<boolean[]>;

  /**
   * A ref to something the client fetches itself rather than renders as nodes —
   * a markdown file, an HTML page, an image. It comes back as a URL because
   * that is what the caller does with it: hand it to fetch, or to an <img>.
   *
   * A second query rather than a flag on `resolve`, because the two answer in
   * different currencies. `resolve` yields addresses whose `key` is OPAQUE —
   * meaningful only to the origin that minted it, and useless to anyone else;
   * the only thing to do with one is hand it back. This yields a URL, which is
   * universally dereferenceable. That difference is the whole reason a resource
   * is not a node, and it runs the other way too: `resolve` must not fetch what
   * a foreign address names, because producing the node would mean parsing
   * another origin's content. A resource is fetched, not parsed, so an absolute
   * http(s) ref passes straight through — nothing about a foreign origin's
   * content model is being trusted by putting a URL in an <img>.
   *
   * Null for a ref this origin will not serve.
   *
   * Synchronous here because inside the envoy it is path arithmetic and nothing
   * more; the wire is what makes it async for a client, which is where the
   * awaits are. The builder keeps its own synchronous twin
   * (`StaticBuildContext.resolveMedia`) because the wire is not in its path.
   *
   * Plural for the reason `resolve` is: a caller that holds several refs holds
   * them at once — a label's spans, a bullet and its open variant — and over a
   * wire that is one message, not one per ref. Answers positionally, `null`
   * where this origin will not serve the ref.
   */
  resolveResources(key: string, refs: string[]): (string | null)[];

  /**
   * A resource ref → the resource itself, or null.
   *
   * Distinct from `resolveResources` because the two answer different
   * questions. That one says WHERE a resource is served from, and a URL is what
   * its callers need — sidepanel puts one in an iframe's src. This one carries
   * the BYTES, for a caller that cannot use a URL: because it must paint
   * something it cannot watch load, or because the URL is cross-origin and a
   * `fetch` of it would need CORS the peer has no reason to have configured.
   *
   * The fetch is the origin's own, same-origin inside its envoy, so a peer
   * needs no CORS cooperation for its resources to be read — the same property
   * that lets an envoy read its own `.rvmark` files. That is the whole point of
   * the query: it is how anything on this side reads a foreign origin's bytes.
   *
   * A CSS mask is one such caller. It is the one paint path with no load event:
   * a dead URL leaves an empty box and fires nothing, so the only way to learn
   * a mask failed used to be to fetch the same URL a second time as an Image
   * and watch THAT. Two requests per painted icon, and the second one bought
   * nothing but the news. Bytes in hand cannot fail to load, so the news
   * arrives with them — null here IS the failure, known before anything paints.
   *
   * What comes back is bytes and the origin's declared type, and no more than
   * that. It is `fetchResources`, not "fetch the one format some caller of the
   * day happens to paint": the query does not know what its answer is for, and
   * an origin's resource is not less of a resource for being a PNG. Nothing is
   * refused for its type and nothing is capped for its size — a limit belongs
   * to the caller that has a reason for one, which is the caller that knows
   * what it is about to do with the bytes.
   *
   * The type is REPORTED, never trusted. An origin can label its bytes
   * anything, so nothing on this side may let the label decide anything that
   * matters. What it is good for is the thing only the origin can say: how the
   * bytes are meant to be read — a `data:` URI's mime, a text decode's charset.
   */
  fetchResources(key: string, refs: string[]): Promise<(FetchedResource | null)[]>;

  /**
   * Re-resolve attrs and tags that came back CHANGED from a nodetype transform,
   * against the document `key` names. The answer is the resolved half of a node,
   * in wire form — exactly what `node()` would have stamped, for fields the
   * origin did not itself produce.
   *
   * Not reachable from a client, and never was a capability a node carried.
   * Both callers are origin-side: it is a step inside serving a transformed
   * node, with the store already in hand.
   */
  reserveWire(key: string, out: { attrs: Array<[string, string]>; tags: Array<{ name: string; props: Array<[string, string]> }>; permalinkId: string }): Promise<WireReserved>;

  /**
   * Drop whatever this origin has cached. Not on the wire, and nothing calls it:
   * a `serve --dev` rebuild reloads the page, which discards the envoy's realm
   * and its store with it. It exists because the store is the origin's, so the
   * *ability* to say "yours is stale" has to be the origin's too — whoever needs
   * it later reaches it from inside the envoy rather than past the protocol into
   * the loader.
   */
  invalidate(): void;

  /**
   * The page-level metadata in force at `key` — title, footer, `no-keymap`, the
   * shell's settings. Not one of the five: it is a `.rvmark` file-head notion
   * that the shell reads once at boot, and the design note has it retiring
   * along with heads. It sits here so that until then `main.ts` asks the origin
   * rather than holding the parsed file, which is the only thing that kept a
   * `SourceFile` in the client.
   */
  meta(key: string): Promise<FileMeta>;
}

// ── Addresses ─────────────────────────────────────────────────────────────────

/** Split a canonical address into the pair this origin's own answers use. */
function addressOf(canonical: string): Address {
  const baseUrl = addressOrigin(canonical) || currentBaseUrl();
  return { baseUrl, key: canonical.slice(addressOrigin(canonical).length) };
}

function currentBaseUrl(): string {
  return typeof location !== 'undefined' ? location.origin : '';
}

// ── Sigils (origin-side: the client never learns these exist) ─────────────────

const FALLBACK_DEPTH_CAP = 8;

/** Split '@sigil/path#slug', '@sigil#slug', or '@sigil'. Null if not a sigil. */
function parseSigilRef(ref: string): { sigil: string; path: string; slug: string | null } | null {
  if (!ref.startsWith('@')) return null;
  const hashIdx = ref.indexOf('#');
  const slug = hashIdx === -1 ? null : ref.slice(hashIdx + 1) || null;
  const beforeHash = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const slashIdx = beforeHash.indexOf('/');
  const sigil = slashIdx === -1 ? beforeHash : beforeHash.slice(0, slashIdx);
  const path = slashIdx === -1 ? '' : beforeHash.slice(slashIdx + 1);
  return { sigil, path, slug };
}

// Resolve a `fallback:` value to an origin root URL. Accepts another sigil
// ('@name', '@name/subpath/'), or a local path ('/abs/path/', './rel/path/')
// resolved against sourceFileAddress. Cycles caught by `visited`.
function resolveFallbackRoot(
  fallback: string,
  origins: Record<string, OriginDef>,
  sourceFileAddress: string,
  visited: Set<string>,
): string | null {
  if (fallback.startsWith('@')) {
    const slashIdx = fallback.indexOf('/');
    const sigil = slashIdx === -1 ? fallback : fallback.slice(0, slashIdx);
    const subpath = slashIdx === -1 ? '' : fallback.slice(slashIdx + 1);
    if (visited.has(sigil)) return null;
    const def = origins[sigil];
    if (!def) return null;
    const base = def.url.endsWith('/') ? def.url : def.url + '/';
    return subpath ? base + subpath : base;
  }
  const origin = addressOrigin(sourceFileAddress);
  if (fallback.startsWith('/')) return origin + fallback;
  if (fallback.startsWith('./') || fallback.startsWith('../')) {
    const localPart = sourceFileAddress.slice(origin.length);
    const dir = localPart.replace(/[^/]*$/, '');
    const parts = (dir + fallback).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return origin + out.join('/');
  }
  return null;
}

// Construct a canonical address for `<origin-root>/<file>#<slug>`.
function buildSigilAddress(originRoot: string, path: string, slug: string | null): string {
  const root = originRoot.endsWith('/') ? originRoot : originRoot + '/';
  let file = path.replace(/^\/+/, '');
  if (!file) file = 'index.rvmark';
  if (!file.endsWith('.rvmark') && !file.endsWith('/')) file += '.rvmark';
  if (file.endsWith('/')) file += 'index.rvmark';
  return root + RVMARK_SEGMENT.slice(1) + file + (slug ? '#' + slug : '');
}

/**
 * The candidate addresses for a sigil ref, in the order they should be tried.
 *
 * Candidates, not nodes: a fallback chain falls through only when a load
 * *fails*, and this origin must not fetch what a foreign address points at —
 * producing the node would mean parsing another origin's content, which is the
 * thing the boundary exists to stop. So the chain leaves here as data and the
 * caller walks it.
 */
function sigilCandidates(
  sigil:             string,
  path:              string,
  slug:              string | null,
  origins:           Record<string, OriginDef>,
  sourceFileAddress: string,
  visited:           Set<string>,
): string[] {
  if (visited.has(sigil) || visited.size >= FALLBACK_DEPTH_CAP) return [];
  const def = origins[sigil];
  if (!def) {
    if (visited.size === 0) console.warn(`rvmark: undeclared origin sigil '${sigil}' in ${sourceFileAddress}`);
    return [];
  }
  const next = new Set(visited);
  next.add(sigil);

  const out = [buildSigilAddress(def.url, path, slug)];
  if (!def.fallback) return out;

  if (def.fallback.startsWith('@')) {
    const slashIdx = def.fallback.indexOf('/');
    const fbSigil   = slashIdx === -1 ? def.fallback : def.fallback.slice(0, slashIdx);
    const fbSubpath = slashIdx === -1 ? '' : def.fallback.slice(slashIdx + 1);
    if (fbSubpath) {
      const fbRoot = resolveFallbackRoot(def.fallback, origins, sourceFileAddress, next);
      if (fbRoot) out.push(buildSigilAddress(fbRoot, path, slug));
    } else {
      out.push(...sigilCandidates(fbSigil, path, slug, origins, sourceFileAddress, next));
    }
    return out;
  }

  const fbRoot = resolveFallbackRoot(def.fallback, origins, sourceFileAddress, next);
  if (fbRoot) out.push(buildSigilAddress(fbRoot, path, slug));
  return out;
}

// ── Matching ──────────────────────────────────────────────────────────────────
// The deep walk lives here: an origin answers questions about content the caller
// has never fetched, and it can only do that by matching on its own side. The
// per-node test itself is shared (served.ts), so the two halves of a search —
// this walk, and search.ts's walk over what the client holds — agree by
// construction.

// A same-file `{=> #id}` target within `file`, or null. The local hop only:
// this origin can no more follow a ref into a foreign one here than anywhere
// else.
function localTranscludeTarget(node: SourceNode, file: SourceFile): SourceNode | null {
  const raw = node.attrs.get('transclude');
  if (!raw || !raw.startsWith('#') || raw.includes(',')) return null;
  return resolveSlugInFile({ nodeMap: file.nodeMap, roots: file.roots }, raw.slice(1))?.node ?? null;
}

// ── Fetched resources ─────────────────────────────────────────────────────────

/** url → its bytes, or null if it did not load.
 *
 *  Keyed on URL, not on the ref or the node that asked: one icon decorates many
 *  nodes, and the answer is a fact about the file. Memoized as the PROMISE, so
 *  a whole subtree's worth of rows asking at once share one fetch rather than
 *  racing to start several. Never evicted — bounded by an origin's distinct
 *  resource set, and an eviction would only buy a re-fetch. */
const _fetched = new Map<string, Promise<FetchedResource | null>>();

// What comes back is the resource, whatever it is. No type is preferred and
// none is refused: this answers `fetchResources`, and the caller that asked
// knows what it wants to do with an answer. A cap here would be this side
// inventing a limit for a use it cannot see.
function fetchResource(url: string): Promise<FetchedResource | null> {
  let p = _fetched.get(url);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url);
        // Not-ok IS the answer, not an error: the caller paints a fallback.
        if (!res.ok) return null;
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        return { mime, bytes: await res.arrayBuffer() };
      } catch { return null; }
    })();
    _fetched.set(url, p);
  }
  return p;
}

// ── The .rvmark origin ────────────────────────────────────────────────────────

class RvmarkOrigin implements Origin {
  constructor(private readonly baseUrl: string) {}

  private address(key: string): string { return this.baseUrl + key; }

  async node(key: string): Promise<SourceNode | null> {
    const address = this.address(key);
    const file = await loadRvmarkFile(address);
    if (!file) return null;
    const slug = addressToSlug(address);
    if (!slug) return file.roots.length ? file.roots[0] : null;
    return resolveSlugInFile({ nodeMap: file.nodeMap, roots: file.roots }, slug)?.node ?? null;
  }

  async childrenOf(key: string): Promise<SourceNode[]> {
    return (await this.node(key))?.children ?? [];
  }

  async resolve(key: string, refs: string[]): Promise<Address[][]> {
    const sourceFileAddress = this.address(key);
    const out: Address[][] = [];

    for (const rawIn of refs) {
      const raw = rawIn ? parseTranscludeEntry(rawIn).ref : '';
      if (!raw) { out.push([]); continue; }

      const sigil = parseSigilRef(raw);
      if (sigil) {
        const file = await loadRvmarkFile(sourceFileAddress);
        const origins = file?.head.origins ?? {};
        out.push(
          sigilCandidates(sigil.sigil, sigil.path, sigil.slug, origins, sourceFileAddress, new Set())
            .map(addressOf),
        );
        continue;
      }

      const address = resolveAddress(raw, sourceFileAddress);
      // Raw cross-origin addresses are rejected here and only here: federation
      // goes through sigils, so that a head's declaration cannot be bypassed by
      // author text. A caller holding only authored text has no way around it.
      const origin = addressOrigin(address ?? '');
      if (!address || (origin && origin !== this.baseUrl)) { out.push([]); continue; }
      out.push([addressOf(address)]);
    }
    return out;
  }

  /**
   * Does a match exist strictly BELOW each key? A node's own match never counts
   * — a collapsed node still shows its own label, so that match is already
   * visible and needs no announcing.
   *
   * `{searchable}` gates the descent, applied here rather than reported to the
   * caller: it licenses the deep walk, so it travels with the walk.
   */
  async hasMatchBelow(keys: string[], query: string): Promise<boolean[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return keys.map(() => false);

    const below = (node: SourceNode, file: SourceFile, active: Set<SourceNode>): boolean => {
      for (const child of node.children ?? []) {
        if (nodeTextMatches(child, needle)) return true;
        if (below(child, file, active)) return true;
      }
      const target = localTranscludeTarget(node, file);
      if (target && !active.has(target)) {
        const next = new Set(active);
        next.add(target);
        if (nodeTextMatches(target, needle) || below(target, file, next)) return true;
      }
      return false;
    };

    return Promise.all(keys.map(async (key) => {
      const file = await loadRvmarkFile(this.address(key));
      const node = file ? await this.node(key) : null;
      if (!file || !node || !node.searchable) return false;
      return below(node, file, new Set([node]));
    }));
  }

  /**
   * A media/asset ref → the URL it is served from. Same path arithmetic
   * `served.media` performs, reached by key rather than by node: the caller
   * that wants this — sidepanel's markdown and html strategies — is holding a ref
   * off a node's attrs and a key, not a node to read `served` off.
   *
   * Absolute http(s) refs pass through: a ref that names its own location is
   * already a URL and this origin has nothing to add. That is not the federation
   * hole `resolve` closes — a resource is fetched, not parsed, so nothing about
   * a foreign origin's *content model* is being trusted.
   */
  resolveResources(key: string, refs: string[]): (string | null)[] {
    const address = this.address(key);
    return refs.map(ref => (ref ? resolveMediaAddress(ref, address) : null));
  }

  fetchResources(key: string, refs: string[]): Promise<(FetchedResource | null)[]> {
    const address = this.address(key);
    return Promise.all(refs.map(ref => {
      const url = ref ? resolveMediaAddress(ref, address) : null;
      return url ? fetchResource(url) : null;
    }));
  }

  async reserveWire(
    key: string,
    out: { attrs: Array<[string, string]>; tags: Array<{ name: string; props: Array<[string, string]> }>; permalinkId: string },
  ): Promise<WireReserved> {
    const file = await loadRvmarkFile(this.address(key));
    if (!file) throw new Error(`cannot re-serve against an unknown key: ${key}`);
    const tags: Tag[] = out.tags.map(t => ({ name: t.name, props: new Multimap(t.props) }));
    // Only attrs, tags and stateScope are read back; the address this computes
    // is discarded, because a transform rewrites what a node IS, never which
    // node it is, and the caller re-stamps the input's key.
    const r = file.resolveShape(new Multimap(out.attrs), tags, out.permalinkId);
    return {
      attrs:      r.attrs.allEntries(),
      tags:       r.tags.map(t => ({ name: t.name, props: t.def.allEntries() })),
      stateScope: r.stateScope,
    };
  }

  // Throws on a key this origin cannot serve at all. The one query that does:
  // the shell asks it before there is a tree to show a failure in, so a caller
  // that gets an empty bag back has no way to tell "no metadata" from "no page".
  async meta(key: string): Promise<FileMeta> {
    const file = await loadRvmarkFile(this.address(key));
    if (!file) throw new Error(`no such page: ${key}`);
    return file.meta;
  }

  invalidate(): void { invalidateLoaderCaches(this.baseUrl); }
}

// ── Lazy per-baseUrl registry ─────────────────────────────────────────────────
// Keyed on baseUrl, not on a bare origin: two sites may share a host, and an
// origin is free to live at any path.

const _origins = new Map<string, Origin>();

export function originFor(baseUrl: string): Origin {
  let origin = _origins.get(baseUrl);
  if (!origin) {
    origin = new RvmarkOrigin(baseUrl);
    _origins.set(baseUrl, origin);
  }
  return origin;
}

export type { NodeAttrs };
