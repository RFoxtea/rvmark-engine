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

import { resolveSlugInFile, addressToSlug, parseTranscludeEntry } from './shared.js';
import { loadRvmarkFile } from './loader.js';
import { originFor, addressOf } from './origin.js';
import type { SourceNode, NodeAttrs } from './parser.js';

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
// Resolve a raw ref string to a SourceNode, by asking the origin that served the
// node carrying it what the ref means, and then asking for what it names.
//
// The ref crosses as the author wrote it. Sigils, fallback chains, `.rvmark`
// suffixing and path arithmetic are all origin-side (origin.ts), and nothing
// here learns that any of them exist. What comes back is candidate ADDRESSES, in
// order: a fallback chain falls through only when a load *fails*, so the walk
// has to happen on this side.
//
// sourceFileAddress is the .rvmark file that owns the node containing the ref.
// Accepts an entry with or without its '^' prefix — the prefix selects what the
// CALLER does with the result, and never changes which node is resolved.
export async function resolveRef(
  rawRefIn:          string | null | undefined,
  sourceFileAddress: string,
): Promise<SourceNode | null> {
  if (!rawRefIn) return null;
  try {
    const from = addressOf(sourceFileAddress);
    const candidates = (await originFor(from.baseUrl).resolve(from.key, [rawRefIn]))[0] ?? [];
    for (const { baseUrl, key } of candidates) {
      const node = await originFor(baseUrl).node(key);
      if (node) return node;
    }
    return null;
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
