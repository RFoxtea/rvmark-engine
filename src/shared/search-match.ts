/**
 * search-match.ts
 *
 * Does this node's own text match? Both halves of a search ask it: the origin,
 * walking content the client has never fetched (Origin.hasMatchBelow), and the
 * client, walking what it holds (searchTree). Two implementations of one
 * question would let the two halves of a result disagree — a breadcrumb dot
 * with nothing under it, or a match with no dot leading to it. One keeps them
 * agreeing by construction.
 *
 * Scope is not shared: which nodes get asked, and whether a node's own match
 * counts, stays on each side.
 *
 * Exports:
 *   nodeTextMatches
 */

import type { ResolvedTag, SourceNode } from './parser.js';

/** The text a tag puts on screen, or null when it renders no chip. */
function tagText(tag: ResolvedTag): string | null {
  if (tag.def.has('internal')) return null;
  return tag.def.get('label') ?? tag.name;
}

export function nodeTextMatches(node: SourceNode, needle: string): boolean {
  if (node.label && node.label.toLowerCase().includes(needle)) return true;
  if (node.tags.some(tag => tagText(tag)?.toLowerCase().includes(needle))) return true;
  return node.bodyLines.some(line => line.toLowerCase().includes(needle));
}
