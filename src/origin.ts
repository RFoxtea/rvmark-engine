/**
 * origin.ts
 *
 * The client's view of one origin: five queries, and nothing else.
 *
 * An origin is an attachment point that answers lookups by key. `key` is opaque
 * to the caller — never parsed, never split, never appended to. There is one key
 * space per origin, and an address (`{ baseUrl, key }`) is carried, never
 * derived: nothing in a key says where its origin lives, so keys can look like
 * anything the origin wants and no path is reserved on anyone's server.
 *
 * This is the protocol from the origin-model design note, implemented in-process
 * against today's loader, parser and SourceFile. No postMessage yet: the point of
 * landing it here first is that every caller can migrate onto the protocol while
 * the tree keeps running, and the wire is cut underneath them later. The Node
 * builder reaches the same implementation by import that the browser will reach
 * through an iframe.
 *
 * What lives here is everything about where content comes from — the `.rvmark`
 * storage layout (`/_rvmark/`, index.rvmark chains, `.rvmark` suffixing), sigil
 * declarations, fallback chains, and matching over content the caller does not
 * hold. What does NOT live here is anything about rendering.
 */

import type { SourceNode, NodeAttrs, OriginDef } from './parser.js';
import {
  resolveSlugInFile, resolveAddress, addressToSlug, addressOrigin,
  parseTranscludeEntry, RVMARK_SEGMENT,
} from './shared.js';
import { loadRvmarkFile } from './loader.js';
import { resolveAttrs } from './source-file.js';
import { resolveTagDef } from './tags.js';

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

/** The address of a node the caller already holds. */
export function addressOfNode(node: SourceNode): Address {
  const page = node.sourceFile?.pageAddress ?? '';
  const base = addressOrigin(page) || currentBaseUrl();
  const file = page.slice(addressOrigin(page).length).split('#')[0];
  return { baseUrl: base, key: node.slug ? `${file}#${node.slug}` : file };
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
// Lives here because the deep walk does: an origin answers questions about
// content the caller has never fetched, and it can only do that by matching on
// its own side. search.ts uses the same two functions over what it does hold, so
// the two halves of a search agree by construction.

export function tagDisplayText(tag: SourceNode['tags'][number], node: SourceNode): string | null {
  const def = resolveTagDef(tag.name, tag.props, node.sourceFile?.tagDefs);
  if (def.has('internal')) return null;
  return def.get('label') ?? tag.name;
}

export function nodeTextMatches(node: SourceNode, needle: string): boolean {
  if (node.label && node.label.toLowerCase().includes(needle)) return true;
  if (node.tags.some(tag => tagDisplayText(tag, node)?.toLowerCase().includes(needle))) return true;
  return node.bodyLines.some(line => line.toLowerCase().includes(needle));
}

// A same-file `{=> #id}` target, or null. The local hop only: this origin can no
// more follow a ref into a foreign one here than anywhere else.
function localTranscludeTarget(node: SourceNode): SourceNode | null {
  const raw = resolveAttrs(node).get('transclude');
  if (!raw || !raw.startsWith('#') || raw.includes(',')) return null;
  const sf = node.sourceFile;
  if (!sf) return null;
  return resolveSlugInFile({ nodeMap: sf.nodeMap, roots: sf.roots }, raw.slice(1))?.node ?? null;
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

    const below = (node: SourceNode, active: Set<SourceNode>): boolean => {
      for (const child of node.children ?? []) {
        if (nodeTextMatches(child, needle)) return true;
        if (below(child, active)) return true;
      }
      const target = localTranscludeTarget(node);
      if (target && !active.has(target)) {
        const next = new Set(active);
        next.add(target);
        if (nodeTextMatches(target, needle) || below(target, next)) return true;
      }
      return false;
    };

    return Promise.all(keys.map(async (key) => {
      const node = await this.node(key);
      if (!node || !(node as any).searchable) return false;
      return below(node, new Set([node]));
    }));
  }
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
