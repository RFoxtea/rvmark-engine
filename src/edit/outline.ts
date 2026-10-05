/**
 * outline.ts — the node outline of rvmark source, for editors.
 *
 * Works on an array of lines and knows nothing of any editor API, so the VS
 * Code extension and the playground share it. Line indices are 0-based.
 */

import { splitFrontmatter } from '../shared/frontmatter.js';

export interface OutlineNode {
  lineIndex: number;
  indent: string;
  ordinal: string;
  /** Length of the indent + ordinal/bullet + following whitespace. */
  matchLen: number;
  depth: number;
  /** Fenced body, opening fence to closing fence. */
  body: LineRange | null;
}

export type LineRange = [start: number, end: number];

// Node lines and bodies as parser.ts reads them.
export const NODE_LINE = /^([ \t]*)(?:([a-zA-Z0-9]+)\.|([*-]))\s+/;
const INT_ORDINAL = /^[1-9][0-9]*$/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})/;
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})\s*$/;

// The document head as parser.ts reads it: a meta block, then tag and origin
// definitions, each possibly spanning lines.
const HEAD_OPEN = /^\s*[{\[@]/;
const META = /^\{.*\}$/s;
const TAG_DEF = /^\[[^\]{]*\{.*\}\s*\]$/s;
const ORIGIN_DEF = /^@[^\s{]+\s*\{.*\}\s*$/s;

/**
 * The line after the braced construct opening on line `i`: null if none opens
 * there, Infinity if its brace never closes.
 */
function bracedEnd(lines: readonly string[], i: number): number | null {
  if (!HEAD_OPEN.test(lines[i])) return null;
  let depth = 0;
  let seen = false;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) return j + 1;
  }
  return seen ? Infinity : null;
}

/**
 * The first line past the document head. An unclosed brace or frontmatter takes the rest of
 * the file: the parser rejects such a document, so nothing after it is a node.
 */
export function headEnd(lines: readonly string[]): number {
  let i = 0;
  let fm = false;
  try {
    const split = splitFrontmatter(lines);
    if (split) { i = split.next; fm = true; }
  } catch {
    return lines.length;
  }
  for (let first = !fm; ; first = false) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return i;
    const end = bracedEnd(lines, i);
    if (end === null) return i;
    if (end === Infinity) return lines.length;
    const text = lines.slice(i, end).map(l => l.trim()).join(' ');
    if (!(first && META.test(text)) && !TAG_DEF.test(text) && !ORIGIN_DEF.test(text)) return i;
    i = end;
  }
}

function scan(lines: readonly string[]): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let i = headEnd(lines);
  while (i < lines.length) {
    const m = NODE_LINE.exec(lines[i]);
    if (!m) { i++; continue; }
    const node: OutlineNode = { lineIndex: i, indent: m[1], ordinal: m[2] || m[3], matchLen: m[0].length, depth: 0, body: null };
    nodes.push(node);
    i++;
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const open = j < lines.length ? FENCE_OPEN.exec(lines[j]) : null;
    if (!open) continue;
    let k = j + 1;
    for (; k < lines.length; k++) {
      const close = FENCE_CLOSE.exec(lines[k]);
      if (close && close[2][0] === open[2][0] && close[2].length >= open[2].length && close[1] === open[1]) break;
    }
    node.body = [j, Math.min(k, lines.length - 1)];
    i = k + 1;
  }
  assignDepths(nodes);
  return nodes;
}

function assignDepths(nodes: OutlineNode[]): void {
  const indentStack = [''];
  for (const node of nodes) {
    const existing = indentStack.indexOf(node.indent);
    if (existing !== -1) {
      node.depth = existing + 1;
      indentStack.length = existing + 1;
    } else {
      indentStack.push(node.indent);
      node.depth = indentStack.length;
    }
  }
}

export function collectNodes(lines: readonly string[]): OutlineNode[] {
  return scan(lines);
}

/** The node's line through its last non-blank descendant line. */
export function subtreeRange(nodes: readonly OutlineNode[], idx: number, lines: readonly string[]): LineRange {
  const start = nodes[idx].lineIndex;
  const d = nodes[idx].depth;
  let end = lines.length - 1;
  for (let i = idx + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= d) { end = nodes[i].lineIndex - 1; break; }
  }
  while (end > start && !lines[end].trim()) end--;
  return [start, end];
}

/** Every node subtree spanning more than one line, plus every body. */
export function foldRanges(lines: readonly string[]): LineRange[] {
  const nodes = scan(lines);
  const ranges = nodes.flatMap(n => n.body ? [n.body] : []);
  for (let i = 0; i < nodes.length; i++) {
    const [start, end] = subtreeRange(nodes, i, lines);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

function parentIndices(nodes: readonly OutlineNode[]): number[] {
  const parentOf: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    stack.length = nodes[i].depth - 1;
    parentOf.push(nodes[i].depth > 1 ? (stack[nodes[i].depth - 2] ?? -1) : -1);
    stack[nodes[i].depth - 1] = i;
  }
  return parentOf;
}

/** The next integer ordinal among the siblings of the node on `line`. */
export function nextSiblingOrdinal(lines: readonly string[], line: number): number | null {
  const nodes = collectNodes(lines);
  const idx = nodes.findIndex(n => n.lineIndex === line);
  if (idx === -1) return null;
  const parentOf = parentIndices(nodes);
  let max = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (parentOf[i] === parentOf[idx] && nodes[i].indent === nodes[idx].indent && INT_ORDINAL.test(nodes[i].ordinal)) {
      max = Math.max(max, parseInt(nodes[i].ordinal, 10));
    }
  }
  return max + 1;
}

/**
 * The marker (no trailing space) for a new sibling after the node on `line`:
 * '-' or '*' repeats, an integer ordinal continues numbering, any other
 * ordinal falls back to '-'. Null if `line` is not a node line.
 */
export function nextSiblingMarker(lines: readonly string[], line: number): string | null {
  const m = NODE_LINE.exec(lines[line]);
  if (!m || !collectNodes(lines).some(n => n.lineIndex === line)) return null;
  if (m[3]) return m[3];
  if (INT_ORDINAL.test(m[2])) return String(nextSiblingOrdinal(lines, line) ?? 1) + '.';
  return '-';
}

export interface Position { line: number; col: number }
export interface Insertion { at: Position; text: string; cursor: Position }

/**
 * Enter on a node line starts a sibling: after the cursor, or above the node
 * when the cursor is at column 0. Null means an ordinary newline.
 */
export function continueOutline(lines: readonly string[], cursor: Position): Insertion | null {
  const marker = nextSiblingMarker(lines, cursor.line);
  if (marker === null) return null;
  const prefix = NODE_LINE.exec(lines[cursor.line])![1] + marker + ' ';
  if (cursor.col === 0) {
    return { at: { line: cursor.line, col: 0 }, text: prefix + '\n', cursor: { line: cursor.line, col: prefix.length } };
  }
  return { at: cursor, text: '\n' + prefix, cursor: { line: cursor.line + 1, col: prefix.length } };
}
