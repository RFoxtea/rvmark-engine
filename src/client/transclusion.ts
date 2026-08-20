/**
 * transclusion.ts
 *
 * Pure computation helpers for resolving transclusion and node metadata.
 * No DOM, no side effects.
 *
 * Exports:
 *   resolveTransclusionConfig  — derive all transclusion/exhibit refs from node attrs
 *   resolveEffectiveChildren   — follow a node's transclude chain recursively
 *   isOrContainsPermalink      — walk parsed tree to check if targetSlug is node or descendant
 */

import { parseTranscludeEntry } from '../shared/shared.js';
import { resolveRefOn, childrenOf } from './origin-host.js';
import type { SourceNode, NodeAttrs } from '../shared/parser.js';

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
    return childrenOf(targetNode);
  }
  const result: SourceNode[] = [];
  for (const entry of tTranscludeRaw.split(',').map((s: string) => s.trim()).filter(Boolean)) {
    if (entry === '*') {
      result.push(...await childrenOf(targetNode));
    } else {
      if (visited.has(entry)) continue;
      const node = await resolveRefOn(targetNode, entry);
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
//
// Async because it is a question about content the client has not fetched: "is
// the focus target somewhere under this row". A prefix test on permalinkId would
// answer it without asking, and would be wrong — an `id` attr restarts the
// chain, so a target under one has no prefix relationship to its ancestors.
//
// It descends by `childrenOf`, so the subtree it walks is fetched as it goes.
// That is the cost of the question, and it is paid only on a `?focus=` load.
export async function isOrContainsPermalink(
  node: SourceNode, permalinkBase: string | null, targetSlug: string,
): Promise<boolean> {
  if (permalinkBase === targetSlug) return true;
  if (node.slug === targetSlug || node.attrs.get('id') === targetSlug) return true;
  const baseForChildren = permalinkBase ?? node.slug;
  for (const child of await childrenOf(node)) {
    const childBase = baseForChildren != null ? `${baseForChildren}.${child.numbering}` : null;
    if (await isOrContainsPermalink(child, childBase, targetSlug)) return true;
  }
  return false;
}
