/**
 * tags.ts
 *
 * Tag resolution — a tag's name and inline props to the definition it renders
 * with, plus the node.* overrides its tags contribute.
 *
 * Parse-time machinery, and shared for the same reason parser.ts is: inherited.ts
 * derives a bag against a document's tagDefs, and rv-file.ts serves a node
 * against them, so both sides of the wire resolve tags by the same rules.
 *
 * Resolution only. A tag def is read off the document's head — merged down the
 * inherited chain — which makes *doing* the reading the origin's job; what
 * crosses to the client is a ResolvedTag, and drawing it is
 * client/tag-chips.ts.
 *
 * Exports:
 *   resolveTagDef   — merge tag definition from file tagDefs + inline props
 *   tagsNodeAttrs   — collect merged node.* attr overrides from all tags on a node
 *   mergeNodeAttrs  — tag-derived attrs + a node's own, in precedence order
 */

import type { Tag, TagDef, TagProps, NodeAttrs } from './parser.js';
import { Multimap } from './multimap.js';
import { isAddressAttr } from './node-types.js';
import { absolutiseRef } from './shared.js';

/**
 * A tag's name and inline props → the props it renders with.
 *
 * Returns TagProps, not a TagDef: the result is a reading of a definition
 * against one document, not a definition itself, and the file that declared it
 * is spent by the time this returns.
 */
export function resolveTagDef(name: string, inlineProps: TagProps, sourceTagDefs?: Record<string, TagDef>): TagProps {
  const def = new Multimap();
  const base = sourceTagDefs?.[name];
  // A def's own props are made absolute against the file that declared them —
  // the same rule the node.* namespace follows in resolveShape, applied here
  // because these props stay on the chip rather than moving to the node.
  //
  // Inline props are not: those are written at the use site, so `[Tag {href:
  // ./x}]` means './x' relative to the file doing the using, and the reader
  // resolves it against its own document as it always has.
  if (base) for (const [k, v] of base.allEntries())
    def.append(k, base.declaredIn && isAddressAttr(k) ? absolutiseRef(v, base.declaredIn) : v);
  for (const [k, v] of inlineProps.allEntries()) def.append(k, v);
  if (name.startsWith('.') && !def.has('internal') && !def.has('label')) def.append('internal', '');
  return def;
}

export function tagsNodeAttrs(tags: Tag[], sourceTagDefs?: Record<string, TagDef>): NodeAttrs {
  const attrs: NodeAttrs = new Multimap();
  for (const { name, props } of tags) {
    const def = resolveTagDef(name, props, sourceTagDefs);
    for (const [dk, dv] of def.allEntries()) {
      if (dk.startsWith('node.')) attrs.append(dk.slice(5), dv);
    }
  }
  return attrs;
}

// Merge tag-derived attrs with node's own attrs. Tag entries come first,
// node entries appended in order; consumers use .get() (last wins) or
// .getAll() (full sequence) as needed.
export function mergeNodeAttrs(tagAttrs: NodeAttrs, nodeAttrs: NodeAttrs): NodeAttrs {
  const out = new Multimap();
  for (const [k, v] of tagAttrs.allEntries()) out.append(k, v);
  for (const [k, v] of nodeAttrs.allEntries()) out.append(k, v);
  return out;
}
