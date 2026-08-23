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
 *   let …    → on-spawn
 *   set …    → on-action
 *
 * State mutation and visibility are keyword-driven, not sigil-driven:
 *   {let &x = "1"}            declare, at spawn
 *   {set &x = "2"}            assign, on action
 *   {on-expand: let &x = "1"} any event attr takes the same grammar
 *   {show-when: &x == "1"}    visibility is always the explicit attribute
 *
 * Exports:
 *   parse(src)            → { meta, roots, nodeMap }
 */

import { Multimap } from './multimap.js';
import { seedBag, deriveBag, type InheritedBag } from './inherited.js';

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

// ── String literals ───────────────────────────────────────────────────────────
// Values on the right-hand side of `let`/`set` and in comparisons are written as
// double-quoted string literals: `let &x = "some variable"`. Quoting is what
// makes a value a value — an unquoted token is either a `&`-reference or a bare
// word, and a bare word that isn't a plain number/identifier is an error rather
// than a silently-accepted string.
//
// Inside quotes, `\"` and `\\` are the two recognised escapes; everything else
// (including `;`) is literal, which is what lets a value contain the separator.
const BARE_VALUE_RE = /^[\w.+-]+$/;

// Read a value token starting at `s[i]`. Returns the decoded value and the index
// just past it. A quoted token consumes through its closing quote; an unquoted
// token runs to the end of the segment it was given.
function readValue(s: string, i: number, ctx: string): { val: string; end: number } {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] === '"') {
    let out = '';
    j++;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        const n = s[j + 1];
        if (n === '"' || n === '\\') { out += n; j += 2; continue; }
        out += c; j++; continue;
      }
      if (c === '"') return { val: out, end: j + 1 };
      out += c;
      j++;
    }
    throw new Error(`rvmark: unterminated string literal in: ${ctx}`);
  }
  const rest = s.slice(j).trim();
  if (rest === '') return { val: '', end: s.length };
  // A `&ref` passes through unquoted — it is resolved against state at apply time.
  if (rest.startsWith('&') || BARE_VALUE_RE.test(rest)) return { val: rest, end: s.length };
  throw new Error(
    `rvmark: value must be quoted, got: ${rest} — write ${JSON.stringify(rest)} in: ${ctx}`,
  );
}

// Split on ';', but never inside a double-quoted string, so that a value may
// contain the separator: `let &msg = "a; b"` is one entry, not two.
export function splitSegments(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\')) { cur += c + raw[i + 1]; i++; continue; }
      if (c === '"') inStr = false;
      cur += c;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Parse a raw show-when value string (the value of `show-when` in node attrs or
// a tag def) into StateCondition[]. Each condition is separated by ';'.
//
//   show-when: &x            → truthy
//   show-when: !&x           → not truthy
//   show-when: &x == "value" → comparison
export function parseShowWhen(raw: string): StateCondition[] {
  const result: StateCondition[] = [];
  for (const part of splitSegments(raw)) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('!')) {
      const rest = s.slice(1).trim();
      if (!rest.startsWith('&')) throw new Error(`rvmark: show-when key must be &-prefixed, got: ${s}`);
      const key = rest.slice(1);
      if (key) result.push({ key, op: '!truthy' });
      continue;
    }
    const m = s.match(/^&([\w-]+)\s*(==|!=|>=|<=|>|<)\s*/);
    if (m) {
      const { val } = readValue(s, m[0].length, s);
      result.push({ key: m[1], op: m[2] as StateCondition['op'], val });
      continue;
    }
    if (/^&[\w-]+$/.test(s)) { result.push({ key: s.slice(1), op: 'truthy' }); continue; }
    throw new Error(`rvmark: show-when key must be &-prefixed, got: ${s}`);
  }
  return result;
}

// Parse a raw state-mutation string (the value of `on-spawn`, `on-action`, or
// any other event attr) into StateEntry[]. Each entry is separated by ';'.
//
//   let &key = "val"   → declare in this node's own frame
//   set &key = "val"   → assign, walking up the frame chain to the owner
//   let &key           → declare with value "1"
//   remove &key        → remove the binding from this node's own frame
//
// `let` and `remove` both act on the node's *own* frame; only `set` walks up the
// chain. That is why the removal keyword is `remove` rather than `unset`: it is
// the counterpart of `let`, not of `set`. And it is `remove` rather than
// `delete` because nothing is wiped globally — it writes a tombstone that
// shadows the ancestor for this subtree, leaving the ancestor's own value intact
// (see StateFrame.delete).
//
// The keyword is what distinguishes declaration from assignment; there is no
// sigil form. Keys are always '&'-prefixed. Anything else throws, so a typo
// surfaces as a parse error rather than as a silently-ignored attribute.
export function parseStateEntries(raw: string): StateEntry[] {
  const result: StateEntry[] = [];
  for (const part of splitSegments(raw)) {
    const s = part.trim();
    if (!s) continue;

    const kw = s.match(/^(let|set|remove)\b\s*/);
    if (!kw) {
      throw new Error(
        `rvmark: state entry must start with 'let', 'set', or 'remove', got: ${s}`,
      );
    }
    const keyword = kw[1];
    const rest = s.slice(kw[0].length).trim();

    if (keyword === 'remove') {
      if (!/^&[\w-]+$/.test(rest)) {
        throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
      }
      result.push({ key: rest.slice(1), op: 'delete' });
      continue;
    }

    const op = keyword === 'let' ? 'declare' : 'set';
    const m = rest.match(/^&([\w-]+)\s*(=\s*)?/);
    if (!m) throw new Error(`rvmark: state key must be &-prefixed, got: ${s}`);
    // `let &key` with no '=' declares the flag value "1"; `set &key` needs a value,
    // since there is no meaningful "assign nothing" — but an explicit empty string
    // (`set &key = ""`) is a legitimate way to blank a variable.
    if (!m[2]) {
      if (rest.slice(m[0].length).trim() !== '') {
        throw new Error(`rvmark: expected '=' after &${m[1]} in: ${s}`);
      }
      result.push({ key: m[1], op, val: '1' });
      continue;
    }
    const { val } = readValue(rest, m[0].length, s);
    result.push({ key: m[1], op, val });
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
  auto?:      boolean;  // true if sourced from a '-'/'*' bullet rather than an explicit ordinal
  attrs:      NodeAttrs;
  tags:       Tag[];
  label:      string;
  bodyLines:  string[];
  children:   RawNode[];
}

// Resolved node — RawNode with its inherited properties fully computed.
//
// `meta` and `searchable` are inherited properties: resolved once, down the
// source tree, at parse time. They are registered in inherited.ts and threaded
// by resolveFile; see that file for why inheritance lives there and not in a
// walk over rendered ancestors.
// Deliberately NOT `extends RawNode`. A served node's `attrs` and `tags` are
// RESOLVED, not authored — `attrs` has its tags' `node.*` overrides merged in,
// and `tags` carry their looked-up definitions rather than their inline props.
// They occupy the authored fields' names rather than sitting beside them: a
// reader has no use for the authored form and no way to resolve it, so there is
// nothing for a second view to be a view OF. `tags` is the field that cannot be
// narrowed under an extends, and the incompatibility is the type system stating
// the same thing.
export interface SourceNode {
  slug:        string;
  permalinkId: string;
  numbering:   string;
  auto?:       boolean;
  label:       string;
  bodyLines:   string[];

  meta:       Record<string, unknown>;
  children:   SourceNode[];
  searchable: boolean;
  sidepanel:    import('./inherited.js').SidepanelScope | null;

  attrs:      NodeAttrs;
  tags:       ResolvedTag[];

  /** This node's own address. `key` is opaque — hand it back, never read it. */
  address:    { baseUrl: string; key: string };

  /**
   * The address of the document this node came from, for the permalink and the
   * static-view link. An origin with no document-shaped storage answers with
   * the node's own.
   */
  pageAddress: string;

  /**
   * Opaque scope token, minted by the origin. Equal means "same authoring
   * scope"; the client raises a state barrier when a child's differs from its
   * host's. Origin-side nodes carry their document's address, which reproduces
   * what comparing `pageAddress` did before the client stopped modelling files.
   */
  stateScope: string;

  /**
   * Whether this node has children to fetch. Known without fetching them, so a
   * collapsed row can draw its toggle without a round trip. `children` is what
   * arrived; this is what exists.
   */
  hasChildren: boolean;
}

/** One tag as it renders: props merged, dot-rule applied, definition resolved. */
export interface ResolvedTag {
  name: string;
  def:  TagDef;
}

/**
 * The resolved half of a node — what an origin works out that a reader cannot.
 * Stamped on at serve time, origin-side and nowhere else. There is no client
 * counterpart: a node is transformed and served in one step, with the document
 * in hand, so nothing on the far side of the wire ever has to be re-resolved.
 */
export interface Reserved {
  attrs:       NodeAttrs;
  tags:        ResolvedTag[];
  address:     { baseUrl: string; key: string };
  pageAddress: string;
  stateScope:  string;
}

export interface RawFile {
  head:    Head;
  roots:   RawNode[];
  nodeMap: Record<string, RawNode>;
}

// Every event attribute that carries state mutations. A bare `let`/`set`/`remove`
// in an attr block is sugar for one of these; writing the attribute explicitly
// (`on-expand: let &x = "1"`) is always available and means the same thing.
export const STATE_EVENT_ATTRS = new Set([
  'on-spawn', 'on-select', 'on-deselect', 'on-focus', 'on-blur',
  'on-action', 'on-expand', 'on-collapse', 'on-no-option-select',
]);

// Parse a `;`-separated attribute block body (the part inside `{…}`).
// Sigils normalize to canonical keys:
//   #value     → id
//   .value     → class
//   = value    → type
//   => value   → transclude
//   let …      → on-spawn  (declaration defaults to spawn time)
//   set …      → on-action (assignment defaults to the node's action)
//   remove …   → on-spawn  (the counterpart of `let`: same frame, same event)
//   key: val   → key
//   key        → key with empty value
//
// The bare forms only pick a *default event*; the keyword keeps its own meaning
// in every position, so `on-expand: set &x = "1"` still assigns, and a bare
// `{set &x = "1"}` is exactly `{on-action: set &x = "1"}`.
export function parseAttrBlock(raw: string): Multimap {
  const out = new Multimap();
  for (const part of splitSegments(raw)) {
    const p = part.trim();
    if (!p) continue;
    if (p.startsWith('#'))  {
      const id = p.slice(1).trim();
      // `{#}` is not a name. Left through, it reaches nodeMap under the empty
      // key, where it captures the leading-dot root-ordinal form (`.1` splits
      // to ['', '1']) and makes its own child unaddressable — its permalink
      // chains to `.1`, colliding with the parent's. Reject it at the source.
      if (!id) throw new Error(`rvmark: empty id in: {${raw}}`);
      out.append('id', id);
      continue;
    }
    if (p.startsWith('.'))  { const c = p.slice(1).trim(); if (c) out.append('class', c); continue; }
    if (p.startsWith('=>')) { out.append('transclude', p.slice(2).trim()); continue; }
    if (p.startsWith('='))  { out.append('type', p.slice(1).trim()); continue; }
    const kw = p.match(/^(let|set|remove)\b/);
    if (kw) { out.append(kw[1] === 'set' ? 'on-action' : 'on-spawn', p); continue; }
    // Retired sigil syntax. Without this guard a leftover `{&x=1}` or `{?&x==1}`
    // would parse as an attribute literally named "&x=1" and then be silently
    // ignored at render time — the failure mode the keyword grammar exists to
    // remove. Fail loudly at parse instead, and name the replacement.
    if (p.startsWith('&') || p.startsWith('!&')) {
      throw new Error(
        `rvmark: '&' state syntax was replaced by let/set — write 'let ${p}' or 'set …' instead of: ${p}`,
      );
    }
    if (p.startsWith('?')) {
      throw new Error(
        `rvmark: '?' visibility syntax was replaced by show-when — write 'show-when: ${p.slice(1)}' instead of: ${p}`,
      );
    }
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
  // (auto-ness is carried on node.auto, which assignOrdinals reads directly.)
  for (const praw of rawNodes) {
    const depth = praw.depth;

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();

    const node: RawNode = {
      slug: '',
      permalinkId: '',
      numbering: praw.ordinal,   // raw literal for now; finalised in assignOrdinals
      auto: praw.auto,
      attrs: praw.attrs,
      tags: praw.tags,
      label: praw.label,
      bodyLines: praw.bodyLines,
      children: [],
    };
    if (stack.length) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ depth, node });
  }

  // Finalise ordinals + slug/permalinkId across the whole tree, populating
  // nodeMap. Shared with hand-built trees via the exported assignOrdinals below;
  // here the raw literals set above (and node.auto) are the input.
  assignOrdinals(roots, nodeMap);

  const head: Head = { meta, tagDefs, origins };
  return { head, roots, nodeMap };
}

/**
 * Finalise a RawNode tree in place: assign each node its `numbering`, `slug`,
 * and `permalinkId`, and (if a map is passed) index it by slug in `nodeMap`.
 *
 * This is the sibling-aware ordinal pass that `parse()` runs as its last step,
 * exported so scripts that build a tree by hand (see `builder.ts`) finalise it
 * through the exact same logic rather than reimplementing it — the guarantee
 * being that a built tree numbers identically to a parsed one.
 *
 * Rules (unchanged from the in-parser version):
 *   - Auto-numbered nodes (`node.auto === true`) continue from the largest
 *     explicit-integer ordinal among their siblings (0 if none), taking the next
 *     integer each in array order, so they never collide with explicit ordinals.
 *   - An explicit `numbering` is kept verbatim (it may be non-integer, e.g. 'd',
 *     or a zero-padded '02', or deliberately out of order — all preserved).
 *   - `slug`/`permalinkId` derive from an `id` attr when present, else the
 *     ordinal; permalinkId chains through the parent's for stability.
 *
 * Runs top-down: a node's permalinkId feeds its children's. Idempotent for a
 * fully-explicit tree; safe to re-run after mutating the tree.
 */
/**
 * Whether a node claims its slug as a name in a file's nodeMap.
 *
 * Only a DECLARED id does. `#11` means "the node whose id is 11" — never "the
 * 11th node", which is not a name the node asked for. An ordinal is meaningful
 * only among siblings (that scope is carried by permalinkId and numbering), so
 * indexing bare ordinals in a flat per-file map lets an unlabelled node squat
 * on a declared id's name. Euclid surfaced it: {#11} (Proposition 11) lost to
 * `hr` separators falling on ordinal 11 inside later proofs, and citations to
 * it expanded to nothing.
 *
 * Ordinal-only nodes stay reachable by compound path (`43-proof.11`) and by the
 * root-ordinal form (`.11`) through resolveSlugInFile's anchor and root walks,
 * which resolve by numbering rather than by this map.
 *
 * There are two nodeMaps — assignOrdinals builds the RawNode one at parse/build
 * time, resolveFile the SourceNode one the RUNTIME resolves refs against. They
 * index different types over different tree shapes, so both must exist; this
 * predicate is what keeps their naming policy from drifting apart. It drifting
 * is exactly how `#11` stayed broken in the browser after the build-time map
 * was fixed.
 */
function claimsNodeMapName(n: { attrs: Multimap }): boolean {
  // `{#}` declares an id attribute whose value is the empty string. That is not
  // a name: indexed, it squats on '' and captures the leading-dot root-ordinal
  // form (`.1` splits to ['', '1'], so its first segment looks it up).
  return !!n.attrs.get('id');
}

export function assignOrdinals(
  siblings: RawNode[],
  nodeMap?: Record<string, RawNode>,
  parentId: string | null = null,
): void {
  let maxInt = 0;
  for (const n of siblings) {
    if (!n.auto && /^\d+$/.test(n.numbering)) {
      const v = parseInt(n.numbering, 10);
      if (v > maxInt) maxInt = v;
    }
  }
  let next = maxInt + 1;
  for (const n of siblings) {
    const ordinal = n.auto ? String(next++) : n.numbering;
    const idAttr = n.attrs.get('id');
    n.numbering   = ordinal;
    n.slug        = idAttr ?? ordinal;
    n.permalinkId = idAttr ?? (parentId ? `${parentId}.${ordinal}` : `.${ordinal}`);
    if (nodeMap && claimsNodeMapName(n)) nodeMap[n.slug] = n;
    assignOrdinals(n.children, nodeMap, n.permalinkId);
  }
}

// ── resolveFile ───────────────────────────────────────────────────────────────
// Second pass: merge inheritedHead into a RawFile, producing SourceNodes with
// every inherited property resolved (see inherited.ts).
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

  // The parser knows only that inherited properties exist, seed from the head,
  // and derive top-down. What they mean lives in inherited.ts.
  function resolveNode(raw: RawNode, parentBag: InheritedBag): SourceNode {
    const bag  = deriveBag(parentBag, raw, resolvedTagDefs);
    const node = { ...raw, ...bag, children: [] } as unknown as SourceNode;
    if (claimsNodeMapName(node)) nodeMap[node.slug] = node;
    node.children = raw.children.map(c => resolveNode(c, bag));
    // Derived, not authored: origin-side the subtree is right there, and
    // `hasChildren` is the one part of it that crosses to a client.
    node.hasChildren = node.children.length > 0;
    return node;
  }

  const roots = rawFile.roots.map(r => resolveNode(r, seedBag(head)));
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
 *   let … → on-spawn, set … → on-action
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

