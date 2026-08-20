/**
 * served.ts
 *
 * What is left of `Served` after the client stopped needing one.
 *
 * `Served` was a compartment on every node holding the origin's answers —
 * resolved attrs, resolved tags, the address, and two closures over the parsed
 * document. It existed to separate what the author wrote from what the origin
 * worked out, because both crossed to the client.
 *
 * Only the resolved form crosses now, so the separation has nothing left to
 * mark: a served node's `attrs` and `tags` ARE the resolved ones, read as
 * ordinary fields (parser.ts). The compartment is gone, and the two closures
 * with it — `media` became `Origin.resolveResource`, `reserve` an origin query.
 * A grep for `SourceFile` could be satisfied by not naming it; a node whose
 * every field is data cannot hold one at all.
 *
 * What remains here are the two readers of a resolved tag, kept together because
 * they are the same question asked twice: does this tag render, and as what.
 */

import type { TagDef, NodeAttrs, ResolvedTag } from './parser.js';

/** A node's attrs with its tags' `node.*` overrides already merged in. */
export type ResolvedAttrs = NodeAttrs;

/** The tags that actually render a chip. `internal` ones render nothing. */
export function visibleTags(tags: ResolvedTag[]): ResolvedTag[] {
  return tags.filter(t => !t.def.has('internal'));
}

/** The text a tag puts on screen, or null when it renders no chip. */
export function tagText(tag: ResolvedTag): string | null {
  if (tag.def.has('internal')) return null;
  return tag.def.get('label') ?? tag.name;
}

export type { TagDef, ResolvedTag };
