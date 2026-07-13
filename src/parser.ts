/**
 * parser.ts
 *
 * Parses rvmark source text into a document tree.
 * Completely type-agnostic: the parser does not know or care what node types
 * exist. It only extracts structure (numbering, attrs, label, bodyLines).
 *
 * The one parser-level convention for body lines is the fenced code block
 * (``` or ~~~) placed immediately below the node line. It is captured into
 * bodyLines unconditionally — for any node, regardless of label or type. The
 * parser makes no judgment about whether the body is wanted; it just records
 * what is in the source. The matching closing fence ends the body. Whether
 * anything consumes bodyLines is left entirely to the type handler; a handler
 * that ignores it simply drops the body.
 *
 * Sigil syntax is normalized to canonical alphanumeric keys on parse:
 *   #value   → id
 *   = value  → type
 *   => value → transclude
 *   .value   → class
 *   &…       → on-spawn
 *   ?…       → show-when
 *
 * Exports:
 *   parse(src)            → { meta, roots, nodeMap }
 */

import { Multimap } from './multimap.js';

export interface StateEntry {
  key: string;
  op:  'declare' | 'set' | 'delete';
  val?: string;
}

export interface StateCondition {
  key: string;
  op: 'truthy' | '!truthy' | '==' | '!=' | '>=' | '<=' | '>' | '<';
  val?: string;
}

// Parse a raw show-when value string (the part after '?' in node attrs,
// or the value of 'show-when' in a tag def) into StateCondition[].
// Each condition is separated by ';'.
export function parseShowWhen(raw: string): StateCondition[] {
  const result: StateCondition[] = [];
  for (const part of raw.split(';')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('!')) {
      const rest = s.slice(1);
      if (!rest.startsWith('&')) throw new Error(`rvmark: show-when key must be &-prefixed, got: ${s}`);
      const key = rest.slice(1);
      if (key) result.push({ key, op: '!truthy' });
    } else {
      const m = s.match(/^&([\w-]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
      if (m) {
        result.push({ key: m[1], op: m[2] as StateCondition['op'], val: m[3].trim() });
      } else if (s.match(/^&([\w-]+)$/)) {
        result.push({ key: s.slice(1), op: 'truthy' });
      } else {
        throw new Error(`rvmark: show-when key must be &-prefixed, got: ${s}`);
      }
    }
  }
  return result;
}

// Parse a raw on-spawn value string (the part after '&' in node attrs,
// or the value of 'on-spawn' in a tag def) into StateEntry[].
// Each entry is separated by ';'.
//   !&key        → delete
//   &key=val     → declare (own frame)
//   &key<<val    → set (walk up frame chain)
//   &key         → declare key=1
// All keys must be &-prefixed (no space). Bare unprefixed names throw.
export function parseOnSpawn(raw: string): StateEntry[] {
  const result: StateEntry[] = [];
  for (const part of raw.split(';')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('!')) {
      const rest = s.slice(1);
      if (!rest.startsWith('&')) throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
      const key = rest.slice(1);
      if (key) result.push({ key, op: 'delete' });
    } else {
      const setIdx = s.indexOf('<<');
      if (setIdx !== -1) {
        const rawKey = s.slice(0, setIdx);
        if (!rawKey.startsWith('&')) throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
        result.push({ key: rawKey.slice(1), op: 'set', val: s.slice(setIdx + 2).trim() });
      } else {
        const eqIdx = s.indexOf('=');
        if (eqIdx !== -1) {
          const rawKey = s.slice(0, eqIdx);
          if (!rawKey.startsWith('&')) throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
          result.push({ key: rawKey.slice(1), op: 'declare', val: s.slice(eqIdx + 1).trim() });
        } else {
          if (!s.startsWith('&')) throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
          result.push({ key: s.slice(1), op: 'declare', val: '1' });
        }
      }
    }
  }
  return result;
}

export type TagProps = Multimap;
export type NodeAttrs = Multimap;
export type TagDef = Multimap;
export type FileMeta = Multimap;

export interface Tag {
  name: string;
  props: TagProps;
}

export interface OriginDef {
  url:       string;
  fallback?: string;
}

export interface Head {
  meta:    FileMeta;
  tagDefs: Record<string, TagDef>;
  origins: Record<string, OriginDef>;
}

const SIGIL_NAME_RE = /^@[a-z][a-z0-9-]*$/;

// Raw node as produced by parse() — no inherited meta resolved.
export interface RawNode {
  slug:       string;
  permalinkId: string;
  numbering:  string;
  attrs:      NodeAttrs;
  tags:       Tag[];
  label:      string;
  bodyLines:  string[];
  children:   RawNode[];
}

// Resolved node — RawNode with meta fully computed from inherited context.
export interface SourceNode extends RawNode {
  meta:       Record<string, unknown>;
  children:   SourceNode[];
  sourceFile: import('./source-file.js').SourceFile;  // stamped by SourceFile constructor
}

export interface RawFile {
  head:    Head;
  roots:   RawNode[];
  nodeMap: Record<string, RawNode>;
}

// Parse a `;`-separated attribute block body (the part inside `{…}`).
// Sigils normalize to canonical keys:
//   #value     → id
//   .value     → class
//   = value    → type
//   => value   → transclude
//   &… / !&…   → on-spawn (raw segment preserved for parseOnSpawn)
//   ?cond      → show-when (cond without the leading '?')
//   key: val   → key
//   key        → key with empty value
export function parseAttrBlock(raw: string): Multimap {
  const out = new Multimap();
  for (const part of raw.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (p.startsWith('#'))  { out.append('id', p.slice(1)); continue; }
    if (p.startsWith('.'))  { const c = p.slice(1).trim(); if (c) out.append('class', c); continue; }
    if (p.startsWith('=>')) { out.append('transclude', p.slice(2).trim()); continue; }
    if (p.startsWith('='))  { out.append('type', p.slice(1).trim()); continue; }
    if (p.startsWith('&') || p.startsWith('!&')) { out.append('on-spawn', p); continue; }
    if (p.startsWith('?'))  { const s = p.slice(1); if (s) out.append('show-when', s); continue; }
    const eq = p.indexOf(':');
    if (eq === -1) out.append(p, "");
    else out.append(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
  }
  return out;
}

export function parse(src: string): RawFile {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let meta: FileMeta = new Multimap();
  const nodeMap: Record<string, RawNode> = {};
  let i = 0;

  // ── 1. Document metadata and tag definitions at top ───────────────────────
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length) {
    const metaM = lines[i].trim().match(/^\{([^}]*)\}$/);
    if (metaM) {
      meta = parseAttrBlock(metaM[1]);
      i++;
    }
  }

  // Tag definitions and origin definitions, alternating freely:
  //   [TagName {…}]              — tag def
  //   @sigil-name {…}            — origin def
  const tagDefs: Record<string, TagDef> = {};
  const origins: Record<string, OriginDef> = {};
  while (i < lines.length) {
    const tl = lines[i].trim();
    if (tl === '') { i++; continue; }
    const tagDefM = tl.match(/^\[([^\]{]*)\{([^}]*)\}\s*\]$/);
    if (tagDefM) {
      tagDefs[tagDefM[1].trim()] = parseAttrBlock(tagDefM[2]);
      i++;
      continue;
    }
    const originM = tl.match(/^(@[^\s{]+)\s*\{([^}]*)\}\s*$/);
    if (originM) {
      const name = originM[1];
      if (!SIGIL_NAME_RE.test(name)) {
        throw new Error(`rvmark: invalid origin sigil name '${name}' — must match ${SIGIL_NAME_RE}`);
      }
      const attrs = parseAttrBlock(originM[2]);
      const url = attrs.get('url');
      if (!url) throw new Error(`rvmark: origin '${name}' is missing required 'url' field`);
      const fallback = attrs.get('fallback') ?? undefined;
      origins[name] = { url, ...(fallback ? { fallback } : {}) };
      i++;
      continue;
    }
    break;
  }
  // ── 2. Collect raw node records ──
  // New syntax: <indent><ordinal>. <rest>
  //   indent   — any consistent whitespace; depth determined by an indent stack
  //   ordinal  — any alphanumeric string, or '-' / '*' (auto-numbered bullets)
  interface ParseRawNode {
    depth: number;
    ordinal: string;   // raw ordinal literal; '-' / '*' for auto-numbered bullets
    auto: boolean;     // true if ordinal was a '-' / '*' bullet (number assigned later)
    attrs: NodeAttrs;
    tags: Tag[];
    label: string;
    bodyLines: string[];
  }
  const rawNodes: ParseRawNode[] = [];
  // Indent stack: array of indent strings seen so far (index 0 = root = "")
  const indentStack: string[] = [''];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(/^([ \t]*)(?:([a-zA-Z0-9]+)\.|([-*]))\s+(.*)$/);
    if (m) {
      const indent = m[1];
      const ordinal = m[2] || m[3];

      // Resolve depth from indent stack
      let depth: number;
      const existing = indentStack.indexOf(indent);
      if (existing !== -1) {
        // Pop back to this level
        depth = existing + 1;
        indentStack.length = existing + 1;
      } else {
        // New deeper level
        indentStack.push(indent);
        depth = indentStack.length;
      }

      // Auto-numbered bullets ('-' / '*') are not numbered here: their number
      // depends on their explicit-integer siblings, which are only known once the
      // tree is built. Flag them now; assignOrdinals resolves the number below.
      const auto = ordinal === '-' || ordinal === '*';

      const { attrs, tags, label } = extractAttrs(m[4]);
      const node: ParseRawNode = { depth, ordinal, auto, attrs, tags, label, bodyLines: [] };
      rawNodes.push(node);
      i++;
      // Collect a multiline body delimited by a fenced code block (```+ or ~~~+),
      // if the first non-blank line after the node opens one. Body collection ends
      // at the matching closing fence. The fence lines themselves are stripped;
      // only the content between them is stored in bodyLines.
      //
      // Captured UNCONDITIONALLY — for any node, label or no label, type or no
      // type. The SourceNode just records what's in the source; it makes no
      // judgment about whether the body is "wanted". Whether anything consumes
      // bodyLines is a downstream decision for the type handler (a handler that
      // ignores it simply drops the body). A node may carry both a label and a
      // body; handlers that treat them as mutually exclusive (e.g. positional-value
      // types like image/iframe, where the label is the value) just ignore the body.
      {
        // Peek ahead for the opening fence, skipping blank lines
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        const firstLine = j < lines.length ? lines[j] : '';
        const fenceM = firstLine.match(/^([ \t]*)((`{3,}|~{3,}))/);
        if (fenceM) {
          const fenceChar  = fenceM[3][0]; // '`' or '~'
          const fenceLen   = fenceM[3].length;
          const fenceIndent = fenceM[1];
          i = j + 1; // skip opening fence line
          while (i < lines.length) {
            const tl = lines[i];
            // Closing fence: same char, at least as many, only whitespace after
            const closeM = tl.match(/^([ \t]*)(`{3,}|~{3,})\s*$/);
            if (closeM && closeM[2][0] === fenceChar && closeM[2].length >= fenceLen
                && closeM[1] === fenceIndent) {
              i++; break;
            }
            // Strip the list-item indent from body lines
            const stripped = tl.startsWith(fenceIndent) ? tl.slice(fenceIndent.length) : tl;
            node.bodyLines.push(stripped);
            i++;
          }
        }
      }
    } else {
      // Non-node line: append non-empty lines to the previous node's label
      // so continuation text isn't silently lost.
      if (lines[i].trim() !== '' && rawNodes.length > 0) {
        const prev = rawNodes[rawNodes.length - 1];
        prev.label = prev.label + '\n' + lines[i].trimStart();
      }
      i++;
    }
  }

  // ── 3. Build tree ──
  const roots: RawNode[] = [];
  const stack: Array<{ depth: number; node: RawNode }> = [];

  // Build the tree structure only. Ordinals — and the slug/permalinkId derived
  // from them — are assigned afterwards in assignOrdinals, because an auto-numbered
  // bullet's number depends on its siblings, known only once the group is complete.
  const autoNodes = new Set<RawNode>();

  for (const praw of rawNodes) {
    const depth = praw.depth;

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();

    const node: RawNode = {
      slug: '',
      permalinkId: '',
      numbering: praw.ordinal,   // raw literal for now; finalised in assignOrdinals
      attrs: praw.attrs,
      tags: praw.tags,
      label: praw.label,
      bodyLines: praw.bodyLines,
      children: [],
    };
    if (praw.auto) autoNodes.add(node);

    if (stack.length) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ depth, node });
  }

  // Assign ordinals per sibling group. Auto-numbered bullets continue from the
  // largest explicit-integer ordinal among their siblings (0 if none), taking the
  // next integer each, in source order — so they never collide with explicit
  // ordinals. Runs top-down: a node's permalinkId feeds its children's.
  function assignOrdinals(siblings: RawNode[], parentId: string | null): void {
    let maxInt = 0;
    for (const n of siblings) {
      if (!autoNodes.has(n) && /^\d+$/.test(n.numbering)) {
        const v = parseInt(n.numbering, 10);
        if (v > maxInt) maxInt = v;
      }
    }
    let next = maxInt + 1;
    for (const n of siblings) {
      const ordinal = autoNodes.has(n) ? String(next++) : n.numbering;
      const idAttr = n.attrs.get('id');
      n.numbering   = ordinal;
      n.slug        = idAttr ?? ordinal;
      n.permalinkId = idAttr ?? (parentId ? `${parentId}.${ordinal}` : `.${ordinal}`);
      nodeMap[n.slug] = n;
      assignOrdinals(n.children, n.permalinkId);
    }
  }
  assignOrdinals(roots, null);

  const head: Head = { meta, tagDefs, origins };
  return { head, roots, nodeMap };
}

// ── resolveFile ───────────────────────────────────────────────────────────────
// Second pass: merge inheritedHead into a RawFile, producing resolved SourceNodes
// with fully-computed meta (inherited → file → parent → tag meta.* → attr meta.*).
export function resolveFile(rawFile: RawFile, inheritedHead: Head): {
  head:    Head;
  roots:   SourceNode[];
  nodeMap: Record<string, SourceNode>;
} {
  const resolvedTagDefs: Record<string, TagDef> = { ...inheritedHead.tagDefs, ...rawFile.head.tagDefs };
  const resolvedOrigins: Record<string, OriginDef> = { ...inheritedHead.origins, ...rawFile.head.origins };
  const fileMeta: FileMeta = new Multimap(inheritedHead.meta.allEntries());
  for (const [k, v] of rawFile.head.meta.allEntries()) fileMeta.append(k, v);
  const head: Head = { meta: fileMeta, tagDefs: resolvedTagDefs, origins: resolvedOrigins };
  const nodeMap: Record<string, SourceNode> = {};

  function fileMetaObj(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of fileMeta.keys()) o[k] = fileMeta.get(k);
    return o;
  }

  function resolveNode(raw: RawNode, parentMeta: Record<string, unknown>): SourceNode {
    const tagMeta: Record<string, unknown> = {};
    for (const tag of raw.tags) {
      const def = resolvedTagDefs[tag.name];
      if (!def) continue;
      for (const [k, v] of def.allEntries()) {
        if (k.startsWith('meta.')) tagMeta[k.slice(5)] = v;
      }
      for (const [k, v] of tag.props.allEntries()) {
        if (k.startsWith('meta.')) tagMeta[k.slice(5)] = v;
      }
    }
    const attrMeta: Record<string, unknown> = {};
    for (const [k, v] of raw.attrs.allEntries()) {
      if (k.startsWith('meta.')) attrMeta[k.slice(5)] = v;
    }
    const meta: Record<string, unknown> = { ...fileMetaObj(), ...parentMeta, ...tagMeta, ...attrMeta };
    const node = { ...raw, meta, children: [] } as unknown as SourceNode;
    nodeMap[node.slug] = node;
    node.children = raw.children.map(c => resolveNode(c, meta));
    return node;
  }

  const roots = rawFile.roots.map(r => resolveNode(r, {}));
  return { head, roots, nodeMap };
}

/**
 * Extract {attrs} block, [Tag] tokens, and label from a raw node line tail.
 *
 * Syntax:  {attrs} [Tag1] [Tag2 {color: red}] Label text
 *
 * The {attrs} block and any [Tag] tokens are all optional.
 * [Tag] tokens must not be immediately followed by '(' to avoid
 * conflicting with inline Markdown link syntax [text](url).
 *
 * Sigil syntax is normalized to canonical keys:
 *   #value → id, = value → type, => value → transclude, .value → class,
 *   &… → declare, ?… → show-when
 *
 * A [Tag] name may be followed by an optional {key: val; …} block that sets or
 * overrides properties for that tag on this node only (inline tag props).
 * Tags are returned in a separate `tags` array as `{ name, props }` objects,
 * where `props` is always a plain object (empty for bare tags).
 * The renderer merges inline props over the registry definition.
 */
function extractAttrs(str: string): { attrs: NodeAttrs; tags: Tag[]; label: string } {
  let attrs: NodeAttrs = new Multimap();
  let rest = str.trimStart();

  const braceM = rest.match(/^\{([^}]*)\}\s*(.*)/s);
  if (braceM) {
    attrs = parseAttrBlock(braceM[1]);
    rest = braceM[2];
  }

  const tags: Tag[] = [];
  while (true) {
    const tagPropsM = rest.match(/^\[([^\]\[{]*)\{([^}]*)\}\s*\]\s*(.*)/s);
    if (tagPropsM) {
      tags.push({ name: tagPropsM[1].trim(), props: parseAttrBlock(tagPropsM[2]) });
      rest = tagPropsM[3];
      continue;
    }
    // [Tag] — bare tag (must not be followed by '(' or '{' to avoid markdown link/span syntax)
    // Also disallow '[' inside the name so markdown links with nested brackets aren't consumed.
    const tagM = rest.match(/^\[([^\]\[]*)\](?!\()(?!\{)\s*(.*)/s);
    if (!tagM) break;
    tags.push({ name: tagM[1], props: new Multimap() });
    rest = tagM[2];
  }

  return { attrs, tags, label: rest.trimStart() };
}

