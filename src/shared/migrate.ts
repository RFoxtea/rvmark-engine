/**
 * migrate.ts
 *
 * Brings a source file up to the current edition. Rewrites the head's metadata
 * only; every line after it is returned byte for byte.
 *
 * Exports:
 *   migrate(src, { stamp })  → migrated source (the same string if nothing changed)
 */

import { Multimap } from './multimap.js';
import { joinBraced, parseAttrBlock } from './parser.js';
import { EDITION, EDITION_KEY, splitFrontmatter, readFrontmatter, writeFrontmatter } from './frontmatter.js';

function stamped(meta: Multimap): Multimap {
  const rest = meta.allEntries().filter(([k]) => k !== EDITION_KEY);
  return new Multimap([[EDITION_KEY, String(EDITION)], ...rest]);
}

/** `stamp` writes the edition into the file — for a root index, or a file that travels alone. */
export function migrate(src: string, opts: { stamp?: boolean } = {}): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const fence = (yaml: string) => ['---', ...yaml.split('\n'), '---'];

  const fm = splitFrontmatter(lines);
  if (fm) {
    const meta = readFrontmatter(fm.yaml);
    if (!opts.stamp || meta.get(EDITION_KEY) === String(EDITION)) return src;
    const yaml = writeFrontmatter(stamped(meta), fm.yaml);
    return [...fence(yaml), ...lines.slice(fm.next)].join(eol);
  }

  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const joined = i < lines.length ? joinBraced(lines, i) : null;
  const metaM = joined?.text.match(/^\{(.*)\}$/s);
  if (joined && metaM) {
    const meta = parseAttrBlock(metaM[1]);
    const yaml = writeFrontmatter(opts.stamp ? stamped(meta) : meta);
    return [...(yaml ? fence(yaml) : []), ...lines.slice(joined.next)].join(eol);
  }

  if (!opts.stamp) return src;
  return [...fence(writeFrontmatter(stamped(new Multimap()))), '', ...lines.slice(i)].join(eol);
}
