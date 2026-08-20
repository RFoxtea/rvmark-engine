/**
 * tag-chips.ts
 *
 * The DOM half of tags: turning already-resolved tags into chip elements.
 *
 * The resolution half lives in envoy/tags.ts, on the other side of the
 * boundary — a tag's definition is read off its document's head, which is the
 * origin's to know. By the time a tag reaches here it is a `ResolvedTag`: the def
 * merged, the dot-rule applied, nothing left to look up. This side only draws.
 *
 * Exports:
 *   buildTagChips — build a DocumentFragment of .node-tag chip elements
 */

import { mdInline } from './markdown.js';
import type { ResolvedTag } from '../shared/served.js';

export function buildTagChips(tags: ResolvedTag[]): DocumentFragment {
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
