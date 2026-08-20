/**
 * tags.ts
 *
 * Tag resolution — a tag's name and inline props to the definition it renders
 * with, plus the node.* overrides its tags contribute.
 *
 * Parse-time machinery, and shared for the same reason parser.ts is: inherited.ts
 * derives a bag against a document's tagDefs, and source-file.ts serves a node
 * against them, so both sides of the wire resolve tags by the same rules.
 *
 * Resolution only. A tag def is read off the document's head — merged down the
 * inherited chain — which makes *doing* the reading the origin's job; what
 * crosses to the client is the resolved ServedTag, and drawing it is
 * client/tag-chips.ts.
 *
 * Exports:
 *   resolveTagDef   — merge tag definition from file tagDefs + inline props
 *   tagsNodeAttrs   — collect merged node.* attr overrides from all tags on a node
 *   mergeNodeAttrs  — tag-derived attrs + a node's own, in precedence order
 */

import type { Tag, TagDef, NodeAttrs } from './parser.js';
import { Multimap } from './multimap.js';

export function resolveTagDef(name: string, inlineProps: TagDef, sourceTagDefs?: Record<string, TagDef>): TagDef {
  const def = new Multimap();
  const base = sourceTagDefs?.[name];
  if (base) for (const [k, v] of base.allEntries()) def.append(k, v);
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
