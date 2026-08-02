/**
 * stringify.ts
 *
 * Inverse of parse() (parser.ts): renders a RawFile / RawNode tree back to
 * `.rvmark` source text, for scripts that want to parse → mutate the tree →
 * write, instead of regexing source text directly.
 *
 * Not a lossless round-trip. Formatting is normalized on every stringify:
 *   - fixed indent (INDENT spaces per depth level)
 *   - attr blocks re-emitted via canonical sigil shorthand where applicable
 *     (id → #, type → =, transclude → =>, class → .), the bare keyword form for
 *     on-spawn `let` / on-action `set`, plain `key: val` otherwise — entry order
 *     is preserved from the Multimap, but exact source spacing/quoting is not
 *   - ordinal marker is '-' for nodes with node.auto === true, otherwise the
 *     explicit `numbering` value followed by '.'
 * Scripts that need byte-for-byte fidelity for untouched nodes should not
 * rely on this module.
 *
 * Exports:
 *   stringifyFile(file)        → full `.rvmark` text (head + node tree)
 *   stringifyNode(node, depth) → a single node's lines (used recursively)
 */

import type { RawFile, RawNode, Head, TagDef } from './parser.js';
import type { Multimap } from './multimap.js';

const INDENT = 2;

// ── attrs ──────────────────────────────────────────────────────────────────
// Reverse of parseAttrBlock: re-derive sigil shorthand for the canonical keys
// that have one, plain `key: val` (or bare `key`) for everything else.
function stringifyAttrEntry(key: string, val: string): string {
  switch (key) {
    case 'id':          return `#${val}`;
    case 'class':       return val ? `.${val}` : '.';
    case 'type':        return `= ${val}`;
    case 'transclude':  return `=> ${val}`;
    // State attrs keep their keyword-led text verbatim. `on-spawn`/`on-action`
    // drop back to the bare form only when the value's keyword matches the
    // default event for that attr — `{let …}` means on-spawn and `{set …}`
    // means on-action, so emitting the bare form in any other pairing would
    // silently change which event it fires on.
    case 'on-spawn':    return /^let\b/.test(val)             ? val : `${key}: ${val}`;
    case 'on-action':   return /^(set|unset)\b/.test(val)     ? val : `${key}: ${val}`;
    default:            return val === '' ? key : `${key}: ${val}`;
  }
}

function stringifyAttrs(attrs: Multimap): string {
  const parts = attrs.allEntries().map(([k, v]) => stringifyAttrEntry(k, v));
  return parts.length ? `{${parts.join('; ')}}` : '';
}

// Pick a fence (char + length) that can't be closed early by the body itself.
// Mirrors the parser's fence-matching rule (same char, length >= opening length):
// a body line of N backticks/tildes at the start of a line would prematurely
// close a fence of length <= N, so the chosen fence must be longer than the
// longest such run of either fence char found in the body.
function pickFence(bodyLines: string[]): string {
  let maxBacktick = 2;
  let maxTilde = 2;
  for (const line of bodyLines) {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (!m) continue;
    const run = m[1];
    if (run[0] === '`') maxBacktick = Math.max(maxBacktick, run.length);
    else maxTilde = Math.max(maxTilde, run.length);
  }
  // Prefer backtick fences unless the body itself contains a long backtick run
  // that would force an even longer one — tilde is usually shorter in that case.
  const backtickFence = '`'.repeat(maxBacktick + 1);
  const tildeFence = '~'.repeat(maxTilde + 1);
  return backtickFence.length <= tildeFence.length ? backtickFence : tildeFence;
}

function stringifyTags(tags: RawNode['tags']): string {
  return tags.map(t => {
    const props = t.props.allEntries();
    return props.length
      ? `[${t.name} {${props.map(([k, v]) => stringifyAttrEntry(k, v)).join('; ')}}]`
      : `[${t.name}]`;
  }).join(' ');
}

// ── head ───────────────────────────────────────────────────────────────────
function stringifyHead(head: Head): string {
  const metaStr = stringifyAttrs(head.meta);

  // Tag-def and origin lines form one block, kept together.
  const defLines: string[] = [];
  for (const [name, def] of Object.entries(head.tagDefs)) {
    defLines.push(stringifyTagDef(name, def));
  }
  for (const [name, origin] of Object.entries(head.origins)) {
    const parts = [`url: ${origin.url}`];
    if (origin.fallback) parts.push(`fallback: ${origin.fallback}`);
    defLines.push(`${name} {${parts.join('; ')}}`);
  }

  // The `{meta}` line and the def block are separated by a blank line when both
  // are present (matching hand-authored layout); either alone stands on its own.
  const blocks: string[] = [];
  if (metaStr) blocks.push(metaStr);
  if (defLines.length) blocks.push(defLines.join('\n'));
  return blocks.length ? blocks.join('\n\n') + '\n\n' : '';
}

function stringifyTagDef(name: string, def: TagDef): string {
  const parts = def.allEntries().map(([k, v]) => stringifyAttrEntry(k, v));
  return `[${name} {${parts.join('; ')}}]`;
}

// ── nodes ──────────────────────────────────────────────────────────────────
export function stringifyNode(node: RawNode, depth: number): string {
  const indent = ' '.repeat(depth * INDENT);
  const marker = node.auto ? '-' : `${node.numbering}.`;

  const attrsStr = stringifyAttrs(node.attrs);
  const tagsStr = stringifyTags(node.tags);
  const labelLines = node.label.split('\n');

  const head = [attrsStr, tagsStr, labelLines[0]].filter(s => s !== '').join(' ');
  const lines = [`${indent}${marker} ${head}`.replace(/\s+$/, '')];

  // Multi-line label continuation: re-indented to the content-start column.
  const contentCol = indent.length + marker.length + 1;
  for (let i = 1; i < labelLines.length; i++) {
    lines.push(labelLines[i] === '' ? '' : ' '.repeat(contentCol) + labelLines[i]);
  }

  if (node.bodyLines.length) {
    const pad = ' '.repeat(contentCol);
    const fence = pickFence(node.bodyLines);
    lines.push(`${pad}${fence}`);
    for (const bl of node.bodyLines) lines.push(bl === '' ? '' : pad + bl);
    lines.push(`${pad}${fence}`);
  }

  for (const child of node.children) {
    lines.push(stringifyNode(child, depth + 1));
  }

  return lines.join('\n');
}

// ── file ───────────────────────────────────────────────────────────────────
export function stringifyFile(file: RawFile): string {
  const headStr = stringifyHead(file.head);
  const bodyStr = file.roots.map(r => stringifyNode(r, 0)).join('\n');
  return headStr + bodyStr + '\n';
}
