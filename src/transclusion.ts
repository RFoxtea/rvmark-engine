/**
 * transclusion.ts
 *
 * Pure computation helpers for resolving transclusion and node metadata.
 * No DOM, no side effects.
 *
 * Exports:
 *   resolveTransclusionConfig  — derive all transclusion/exhibit refs from node attrs
 *   resolveRef                 — resolve a raw ref string to a { node, sourceFile } pair
 *   resolveEffectiveChildren   — follow a node's transclude chain recursively
 *   isOrContainsPermalink      — walk parsed tree to check if targetSlug is node or descendant
 */

import { resolveSlugInFile, resolveAddress, addressToSlug, addressOrigin, parseTranscludeEntry, RVMARK_SEGMENT } from './shared.js';
import { loadRvmarkFile } from './loader.js';
import type { SourceNode, NodeAttrs, OriginDef } from './parser.js';

const FALLBACK_DEPTH_CAP = 8;

// Split '@sigil/path#slug', '@sigil#slug', or '@sigil' into parts.
// Returns null if ref does not start with '@'.
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

// Resolve a `fallback:` value to an origin root URL.
// Accepts another sigil ('@name', '@name/subpath/'), or a local path
// ('/abs/path/', './rel/path/') which is resolved against sourceFileAddress.
// Sigil-based fallbacks look up in `origins`; cycles caught by `visited`.
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
  // Local path fallback — resolve to a directory URL within sourceFile's origin.
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
// Origin root must already end in '/'. Strips any trailing '/' from path.
function buildSigilAddress(originRoot: string, path: string, slug: string | null): string {
  const root = originRoot.endsWith('/') ? originRoot : originRoot + '/';
  let file = path.replace(/^\/+/, '');
  if (!file) file = 'index.rvmark';
  if (!file.endsWith('.rvmark') && !file.endsWith('/')) file += '.rvmark';
  if (file.endsWith('/')) file += 'index.rvmark';
  // RVMARK_SEGMENT is '/_rvmark/'; root already ends in '/', so drop its leading slash.
  return root + RVMARK_SEGMENT.slice(1) + file + (slug ? '#' + slug : '');
}

// Walk the fallback chain for a sigil ref, trying each origin in order.
// Returns the first successfully-loaded SourceNode (or null if all fail).
async function resolveSigilChain(
  sigil:             string,
  path:              string,
  slug:              string | null,
  origins:           Record<string, OriginDef>,
  sourceFileAddress: string,
  visited:           Set<string>,
): Promise<SourceNode | null> {
  if (visited.has(sigil)) return null;
  if (visited.size >= FALLBACK_DEPTH_CAP) return null;
  const def = origins[sigil];
  if (!def) {
    if (visited.size === 0) console.warn(`rvmark: undeclared origin sigil '${sigil}' in ${sourceFileAddress}`);
    return null;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(sigil);

  const address = buildSigilAddress(def.url, path, slug);
  const sourceFile = await loadRvmarkFile(address);
  if (sourceFile) {
    if (slug) {
      const resolved = resolveSlugInFile({ nodeMap: sourceFile.nodeMap, roots: sourceFile.roots }, slug);
      if (resolved) return resolved.node;
    } else {
      if (sourceFile.roots.length) return sourceFile.roots[0];
    }
  }

  if (!def.fallback) return null;

  // Fallback can be another sigil or a local path. If it's a sigil, recurse.
  // If it's a local path, treat that path as a new origin root and try once.
  if (def.fallback.startsWith('@')) {
    const slashIdx = def.fallback.indexOf('/');
    const fbSigil = slashIdx === -1 ? def.fallback : def.fallback.slice(0, slashIdx);
    const fbSubpath = slashIdx === -1 ? '' : def.fallback.slice(slashIdx + 1);
    if (fbSubpath) {
      const fbRoot = resolveFallbackRoot(def.fallback, origins, sourceFileAddress, nextVisited);
      if (!fbRoot) return null;
      const fbAddress = buildSigilAddress(fbRoot, path, slug);
      const sf = await loadRvmarkFile(fbAddress);
      if (sf) {
        if (slug) {
          const r = resolveSlugInFile({ nodeMap: sf.nodeMap, roots: sf.roots }, slug);
          if (r) return r.node;
        } else if (sf.roots.length) return sf.roots[0];
      }
      return null;
    }
    return resolveSigilChain(fbSigil, path, slug, origins, sourceFileAddress, nextVisited);
  }

  // Local-path fallback — use it as a one-shot origin root.
  const fbRoot = resolveFallbackRoot(def.fallback, origins, sourceFileAddress, nextVisited);
  if (!fbRoot) return null;
  const fbAddress = buildSigilAddress(fbRoot, path, slug);
  const sf = await loadRvmarkFile(fbAddress);
  if (!sf) return null;
  if (slug) {
    const r = resolveSlugInFile({ nodeMap: sf.nodeMap, roots: sf.roots }, slug);
    return r ? r.node : null;
  }
  return sf.roots.length ? sf.roots[0] : null;
}


interface TransclusionConfig {
  embedVal:       string | null;
  childrenList:   string[] | null;
  exhibitVal:     string | null;
  exhibitButton:  boolean;
  transcludeMode: 'link' | 'children' | null;
}

// ── resolveTransclusionConfig ──────────────────────────────────────────────
// Transclusion modes ({=> val}):
//   link-mode     — no label, single ref, no '*' → replace with target's children
//   children-mode — has label, or list, or '*'   → keep own chrome, borrow children
export function resolveTransclusionConfig(node: SourceNode, attrs: NodeAttrs): TransclusionConfig {
  const transcludeRaw = attrs.get('transclude') ?? null;
  const embedList = transcludeRaw
    ? transcludeRaw.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  const hasLabel       = node.label.trim() !== '';
  const isChildrenMode = transcludeRaw !== null && (
    hasLabel ||
    (embedList && (embedList.length > 1 || embedList.includes('*')))
  );

  const embedVal     = !isChildrenMode && embedList ? embedList[0] : null;
  const childrenList = isChildrenMode ? embedList : null;

  const exhibitVal    = attrs.get('exhibit') ?? null;
  const exhibitButton: boolean = attrs.get('action') === 'exhibit';

  const transcludeMode: 'link' | 'children' | null = embedVal ? 'link' : (childrenList ? 'children' : null);

  return { embedVal, childrenList, exhibitVal, exhibitButton, transcludeMode };
}

// ── resolveRef ────────────────────────────────────────────────────────────
// Resolve a raw ref string to a SourceNode.
// sourceFileAddress is the .rvmark file that owns the node containing the ref.
// Accepts an entry with or without its '^' prefix — the prefix selects what the
// CALLER does with the result, and never changes which node is resolved.
export async function resolveRef(
  rawRefIn:          string | null | undefined,
  sourceFileAddress: string,
): Promise<SourceNode | null> {
  if (!rawRefIn) return null;
  const rawRef = parseTranscludeEntry(rawRefIn).ref;
  if (!rawRef) return null;
  try {
    // Sigil ref: '@alice', '@alice/path', '@alice/path#slug'.
    // Look up origins via the source file's head (resolved through its
    // inherited-head chain). Walk the fallback chain on miss.
    const sigilRef = parseSigilRef(rawRef);
    if (sigilRef) {
      const sourceFile = await loadRvmarkFile(sourceFileAddress);
      if (!sourceFile) return null;
      return resolveSigilChain(
        sigilRef.sigil, sigilRef.path, sigilRef.slug,
        sourceFile.head.origins, sourceFileAddress, new Set(),
      );
    }

    const address = resolveAddress(rawRef, sourceFileAddress);
    if (!address) return null;

    // Reject raw cross-origin addresses — federation goes through sigils.
    const origin = addressOrigin(address);
    if (origin && origin !== location.origin) return null;

    const sourceFile = await loadRvmarkFile(address);
    if (!sourceFile) return null;

    const slug = addressToSlug(address);
    if (slug) {
      const resolved = resolveSlugInFile({ nodeMap: sourceFile.nodeMap, roots: sourceFile.roots }, slug);
      return resolved ? resolved.node : null;
    }
    return sourceFile.roots.length ? sourceFile.roots[0] : null;
  } catch { return null; }
}

// ── resolveEffectiveChildren ──────────────────────────────────────────────
// Follow a node's own transclude param recursively to get its effective children.
export async function resolveEffectiveChildren(
  targetNode: SourceNode,
  visited:    Set<string>,
): Promise<SourceNode[]> {
  const tEmbedRaw = targetNode.attrs.get('transclude') ?? null;
  const tTranscludeRaw = tEmbedRaw && (() => {
    const list = tEmbedRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
    const tHasLabel = (targetNode.label ?? '').trim() !== '';
    return (tHasLabel || list.length > 1 || list.includes('*')) ? tEmbedRaw : null;
  })();
  if (!tTranscludeRaw) {
    return targetNode.children;
  }
  const result: SourceNode[] = [];
  for (const entry of tTranscludeRaw.split(',').map((s: string) => s.trim()).filter(Boolean)) {
    if (entry === '*') {
      result.push(...targetNode.children);
    } else {
      if (visited.has(entry)) continue;
      const node = await resolveRef(entry, targetNode.sourceFile.pageAddress);
      if (!node) continue;
      // A '^' entry contributes the node itself, so the chain stops here: there
      // is nothing to unwrap, and recursing would discard the very row it asks
      // for. Its own children ride along with it, resolved lazily on expand.
      if (parseTranscludeEntry(entry).wholeNode) { result.push(node); continue; }
      const branchVisited = new Set(visited);
      branchVisited.add(entry);
      result.push(...await resolveEffectiveChildren(node, branchVisited));
    }
  }
  return result;
}

// ── isOrContainsPermalink ──────────────────────────────────────────────────
export function isOrContainsPermalink(node: SourceNode, permalinkBase: string | null, targetSlug: string): boolean {
  if (permalinkBase === targetSlug) return true;
  if (node.slug === targetSlug || node.attrs.get('id') === targetSlug) return true;
  const baseForChildren = permalinkBase ?? node.slug;
  for (const child of node.children) {
    const childBase = baseForChildren != null ? `${baseForChildren}.${child.numbering}` : null;
    if (isOrContainsPermalink(child, childBase, targetSlug)) return true;
  }
  return false;
}
