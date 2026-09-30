/**
 * outline.ts — the node outline of rvmark source, for editors.
 *
 * Works on an array of lines and knows nothing of any editor API, so the VS
 * Code extension and the playground share it. Line indices are 0-based.
 */

export interface OutlineNode {
  lineIndex: number;
  indent: string;
  ordinal: string;
  /** Length of the indent + ordinal/bullet + following whitespace. */
  matchLen: number;
  depth: number;
}

export type LineRange = [start: number, end: number];

export const NODE_LINE = /^( *)(?:([a-zA-Z0-9]+)\.|([*-]))\s+/;
const NODE_MEDIA = /\{[^}]*(?:=\s*block|type:\s*block)\b/;
const NODE_MEDIA_INLINE = /\{[^}]*(?:=\s*block|type:\s*block)[^}]*\}\s*\S/;
const INT_ORDINAL = /^[1-9][0-9]*$/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})/;
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})\s*$/;

interface Scan {
  nodes: OutlineNode[];
  /** Fenced bodies of block-type nodes, opening fence to closing fence. */
  blockBodies: LineRange[];
}

function scan(lines: readonly string[]): Scan {
  const nodes: OutlineNode[] = [];
  const blockBodies: LineRange[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let fenceStart = -1;
  let inMediaBody = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (fenceChar !== null) {
      const closeM = FENCE_CLOSE.exec(text);
      if (closeM && closeM[2][0] === fenceChar && closeM[2].length >= fenceLen) {
        if (inMediaBody) { blockBodies.push([fenceStart, i]); inMediaBody = false; }
        fenceChar = null; fenceLen = 0;
      }
      continue;
    }
    const openM = FENCE_OPEN.exec(text);
    if (openM) { fenceChar = openM[2][0]; fenceLen = openM[2].length; fenceStart = i; continue; }
    // Between a block-type node line and its opening fence, nothing is a node.
    if (inMediaBody) continue;
    const m = NODE_LINE.exec(text);
    if (m) {
      nodes.push({ lineIndex: i, indent: m[1], ordinal: m[2] || m[3], matchLen: m[0].length, depth: 0 });
      if (NODE_MEDIA.test(text) && !NODE_MEDIA_INLINE.test(text)) inMediaBody = true;
    }
  }
  assignDepths(nodes);
  return { nodes, blockBodies };
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
  return scan(lines).nodes;
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

/** Every node subtree spanning more than one line, plus every block body. */
export function foldRanges(lines: readonly string[]): LineRange[] {
  const { nodes, blockBodies } = scan(lines);
  const ranges = [...blockBodies];
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
