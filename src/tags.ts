/**
 * tags.ts
 *
 * Tag chip resolution and DOM building.
 *
 * Exports:
 *   resolveTagDef   — merge tag definition from file tagDefs + inline props
 *   buildTagChips   — build a DocumentFragment of .node-tag chip elements
 *   tagsNodeAttrs   — collect merged node.* attr overrides from all tags on a node
 */

import type { Tag, TagDef, NodeAttrs } from './parser.js';
import { Multimap } from './multimap.js';
import { mdInline } from './markdown.js';
import type { ServedTag } from './served.js';

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

export function buildTagChips(tags: ServedTag[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const { name, def } of tags) {
    if (def.has('internal')) continue;

    const href  = def.get('href');
    const label = def.get('label');
    const color = def.get('color');
    const tip   = def.get('tip');

    const chip: HTMLElement = href
      ? Object.assign(document.createElement('a'), { href, className: 'node-tag node-tag--link' })
      : Object.assign(document.createElement('span'), { className: 'node-tag' });

    chip.innerHTML = mdInline(label ?? name);
    if (color) chip.style.setProperty('--tag-color', color);
    if (tip)   chip.title = tip;
    frag.appendChild(chip);
    // A real space, not just the chip's margin: the gap has to survive leaving
    // the page. Without it a copied label reads '[6]The general form...' —
    // margin is presentation, and the clipboard takes the text.
    frag.appendChild(document.createTextNode(' '));
  }
  return frag;
}
