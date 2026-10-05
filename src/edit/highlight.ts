/**
 * highlight.ts — syntax highlighting of rvmark source, for editors.
 *
 * Follows the rules of the parser (shared/parser.ts) and the span extension
 * (client/markdown.ts); where this and those disagree, this is wrong.
 *
 *   --- … ---                     file head: YAML frontmatter, first line only
 *   {title: …}                    file head: edition-1 meta block, first construct only
 *   [Name {…}]  @origin {…}       file head: tag and origin definitions
 *   - Node.   1. Node.            node line: '-', '*' or 'ord.' then whitespace
 *   {#slug; = type; key: value}   node attrs, only directly after the bullet
 *   [Tag]  [Tag {…}]              tags, only after the attrs, before the label
 *   ~~~ … ~~~   ``` … ```         body fence: first non-blank line after a node
 *                                 line; closed by the same char, as long or
 *                                 longer, at the same indent
 *   [text]{…}  [text](url)        spans and links, in labels and bodies
 *   **bold**  *em*  `code`  $math$  \x    inline markdown
 *
 * Any other line is label continuation. Line by line: feed each line to
 * highlightLine with one state threaded through, blank lines included.
 *
 * Tokens are grouped by role, not by spelling: a sigil and the key it
 * abbreviates colour alike (`#x` and `id: x`, `= t` and `type: t`), and a name
 * is the same group where it is defined and where it is used, the definition
 * flagged. Prose, link text included, is left unmarked.
 */

export type TokenType =
  | 'bullet' | 'punctuation' | 'keyword' | 'operator' | 'type' | 'variable'
  | 'property' | 'string' | 'decorator' | 'namespace'
  | 'escape' | 'link' | 'code' | 'strong' | 'emphasis';

export const TOKEN_TYPES: readonly TokenType[] = [
  'bullet', 'punctuation', 'keyword', 'operator', 'type', 'variable',
  'property', 'string', 'decorator', 'namespace',
  'escape', 'link', 'code', 'strong', 'emphasis',
];

export interface Token { from: number; to: number; type: TokenType; definition: boolean }

type Kind = 'fence' | 'body' | 'head' | 'node' | 'label';
type Part = 'bullet' | 'attrs' | 'tags' | 'tagBrace' | 'tagEnd' | 'label';
type AttrAfter = 'head' | 'tags' | 'tagEnd' | 'label';
type Seg = 'ref' | 'type' | 'id' | 'class' | 'expr' | null;

/** Flat, so a shallow copy is a full copy. */
export interface HighlightState {
  front: 'start' | 'in' | 'done';  // frontmatter: not yet at line 1, inside it, past it
  head: boolean;          // before the first node: meta, tag and origin defs
  headBrace: boolean;     // a head construct's name was read; its '{' is next
  awaitFence: boolean;    // the last non-blank line was a node line
  fenceCh: string | null; fenceLen: number; fenceIndent: string;  // open body fence
  innerCh: string | null; innerLen: number;                       // markdown code fence in a body
  part: Part;             // where on a node line
  attr: AttrAfter | null; // inside {…}: what follows it
  depth: number; lead: boolean; colon: boolean; seg: Seg;
  close: number;          // column of the ']' closing a link or span label, or -1
  after: '(' | '{' | null;  // what that ']' is followed by, once passed
  def: boolean;           // the token just read is a definition
  declare: boolean;       // 'let' was just read; the variable after it is defined there
  kind: Kind;             // what the current line is
}

export function startState(): HighlightState {
  return {
    front: 'start', head: true, headBrace: false, awaitFence: false,
    fenceCh: null, fenceLen: 0, fenceIndent: '',
    innerCh: null, innerLen: 0,
    part: 'label', attr: null,
    depth: 0, lead: true, colon: false, seg: null,
    close: -1, after: null, def: false, declare: false, kind: 'label',
  };
}

export function copyState(s: HighlightState): HighlightState {
  return { ...s };
}

const NODE_RE  = /^[ \t]*(?:[a-zA-Z0-9]+\.|[-*])\s/;
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})/;
const CLOSE_RE = /^([ \t]*)(`{3,}|~{3,})\s*$/;
// Keys whose values are state expressions: `show-when` and the `on-*` events,
// bare or namespaced (`node.show-when` in a tag def).
const EXPR_KEY = /(?:^|\.)(?:show-when|on-[\w-]+)$/;

class Cursor {
  pos = 0;
  constructor(readonly s: string) {}
  eol()  { return this.pos >= this.s.length; }
  peek() { return this.s[this.pos] ?? ''; }
  prev() { return this.s[this.pos - 1] ?? ''; }
  rest() { return this.s.slice(this.pos); }
  next() { return this.s[this.pos++] ?? ''; }
  eat(c: string) { if (this.s[this.pos] === c) { this.pos++; return true; } return false; }
  match(re: RegExp, consume = true): RegExpMatchArray | null {
    const m = this.rest().match(re);
    if (m && m.index === 0 && consume) this.pos += m[0].length;
    return m && m.index === 0 ? m : null;
  }
  eatWhile(re: RegExp) { const start = this.pos; while (!this.eol() && re.test(this.s[this.pos])) this.pos++; return this.pos > start; }
  eatSpace() { return this.eatWhile(/\s/); }
  skipToEnd() { this.pos = this.s.length; }
}

type Result = TokenType | null;

// ── Attribute blocks ────────────────────────────────────────────────────────
// Segments split on ';' outside double quotes. A segment opens with a sigil
// ('#', '.', '=>', '=') or a keyword (let/set/remove), else it is key: value.
// Node and span blocks end at the first '}'; head blocks count braces.

function enterAttrs(state: HighlightState, after: AttrAfter) {
  state.attr = after;
  state.depth = 1;
  state.lead = true;
  state.colon = false;
  state.seg = null;
}

function segFor(key: string): Seg {
  if (key === 'type') return 'type';
  if (key === 'id') return 'id';
  if (key === 'transclude') return 'ref';
  if (key === 'class') return 'class';
  if (EXPR_KEY.test(key)) return 'expr';
  return null;
}

function attrs(c: Cursor, state: HighlightState): Result {
  if (c.eatSpace()) return null;
  const head = state.attr === 'head';

  if (c.eat('}')) {
    if (head && --state.depth > 0) return 'string';
    if (state.attr === 'tags' || state.attr === 'tagEnd') state.part = state.attr;
    state.attr = null;
    return 'punctuation';
  }
  if (head && c.eat('{')) { state.depth++; return 'string'; }
  if (c.eat(';')) { state.lead = true; state.colon = false; state.seg = null; return 'punctuation'; }

  if (c.eat('"')) {
    while (!c.eol()) {
      const ch = c.next();
      if (ch === '\\') c.next();
      else if (ch === '"') break;
      else if (ch === '}' && !head) { c.pos--; break; }
    }
    return 'string';
  }

  if (state.lead) {
    state.lead = false;
    if (c.match(/^=>/)) { state.seg = 'ref'; state.colon = true; return 'keyword'; }
    if (c.eat('='))     { state.seg = 'type'; state.colon = true; return 'type'; }
    if (c.eat('#'))     { c.eatWhile(/[^;}]/); state.def = true; return 'variable'; }
    if (c.eat('.'))     { c.eatWhile(/[^;}]/); return 'decorator'; }
    const kw = c.match(/^(let|set|remove)\b/);
    if (kw) { state.colon = true; state.seg = 'expr'; state.declare = kw[1] === 'let'; return 'keyword'; }
    const start = c.pos;
    c.eatWhile(/[^;:}"]/);
    state.seg = segFor(c.s.slice(start, c.pos).trim());
    return 'property';
  }

  if (!state.colon) {
    if (c.eat(':')) { state.colon = true; return 'punctuation'; }
    c.eatWhile(/[^;:}"]/) || c.next();
    return 'property';
  }

  switch (state.seg) {
    case 'type':
      c.eatWhile(/[^;}\s]/) || c.next();
      return 'type';
    case 'id':
      c.eatWhile(/[^;}]/);
      state.def = true;
      return 'variable';
    case 'class':
      c.eatWhile(/[^;}]/);
      return 'decorator';
    case 'ref':
      if (c.match(/^[\^*,]/)) return 'operator';
      if (c.eat('#')) { c.eatWhile(/[^,;}\s]/); return 'variable'; }
      if (c.eat('@')) { c.eatWhile(/[^\/#,;}\s]/); return 'namespace'; }
      c.eatWhile(/[^,;}\s#"]/) || c.next();
      return 'string';
    case 'expr':
      if (c.match(/^!?&[\w-]+/)) { state.def = state.declare; state.declare = false; return 'variable'; }
      if (c.match(/^(?:==|!=|=|!)/)) return 'operator';
      const kw = c.match(/^(let|set|remove)\b/);
      if (kw) { state.declare = kw[1] === 'let'; return 'keyword'; }
      c.eatWhile(/[^;}"&=!\s]/) || c.next();
      return 'string';
    default:
      c.eatWhile(/[^;}"]/) || c.next();
      return 'string';
  }
}

// ── Inline markdown ─────────────────────────────────────────────────────────

// Length of '[label]' at the start of `s`, brackets nested and '\' escaping,
// as matchSpan counts it; 0 if unbalanced.
function bracketLen(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i + 1;
  }
  return 0;
}

function inline(c: Cursor, state: HighlightState): Result {
  if (c.pos === state.close) {
    c.next(); state.close = -1;
    return 'punctuation';
  }
  if (state.after && state.close === -1) {
    const after = state.after;
    state.after = null;
    if (after === '{' && c.eat('{')) { enterAttrs(state, 'label'); return 'punctuation'; }
    if (after === '(' && c.eat('(')) { c.eatWhile(/[^)]/); c.eat(')'); return 'link'; }
  }

  const rest = c.rest();
  const prev = c.prev();

  if (c.match(/^\\[!-\/:-@\[-`{-~]/) || c.match(/^\\$/)) return 'escape';
  if (c.match(/^\$\$[^$]+\$\$/) || c.match(/^\$[^$]+\$/)) return 'code';

  if (c.peek() === '`') {
    const run = c.match(/^`+/)![0];
    const after = c.rest();
    const re = /`+/g;
    let m;
    while ((m = re.exec(after))) {
      if (m[0].length === run.length) { c.pos += m.index + run.length; return 'code'; }
    }
    return null;
  }

  if (c.match(/^\*\*(?!\s).*?\S\*\*/)) return 'strong';
  if (prev !== '*' && c.match(/^\*(?![\s*])(?:[^*]*[^\s*])?\*/)) return 'emphasis';
  if (!/\w/.test(prev) && c.match(/^_(?![\s_])[^_]*_(?!\w)/)) return 'emphasis';

  if (rest[0] === '[') {
    const len = bracketLen(rest);
    const next = len ? rest[len] : '';
    const isSpan = next === '{' && rest.indexOf('}', len + 1) !== -1;
    if (state.close === -1 && (isSpan || next === '(')) {
      state.close = c.pos + len - 1;
      state.after = next;
      c.next();
      return 'punctuation';
    }
    c.next();
    return null;
  }
  if (c.match(/^<[a-zA-Z][a-zA-Z0-9+.-]*:[^\s>]*>/)) return 'link';

  // Plain text up to the next character that could start something, stopping
  // short of a pending label's ']'.
  const stop = state.close === -1 ? c.s.length : state.close;
  const start = c.pos;
  while (c.pos < stop && !/[\\`*_\[<$]/.test(c.peek())) c.pos++;
  if (c.pos === start) c.next();
  return null;
}

// ── Lines ───────────────────────────────────────────────────────────────────

function classify(line: string, state: HighlightState): Kind {
  state.close = -1;
  state.after = null;
  state.headBrace = false;
  if (state.attr && state.attr !== 'head') state.attr = null;

  if (state.fenceCh) {
    const m = line.match(CLOSE_RE);
    if (m && m[2][0] === state.fenceCh && m[2].length >= state.fenceLen && m[1] === state.fenceIndent) {
      state.fenceCh = null;
      return 'fence';
    }
    return 'body';
  }

  if (state.head) {
    if (state.attr === 'head' || /^\s*[{\[@]/.test(line)) return 'head';
    state.head = false;
  }

  if (state.awaitFence) {
    state.awaitFence = false;
    const m = line.match(FENCE_RE);
    if (m) {
      state.fenceCh = m[2][0]; state.fenceLen = m[2].length; state.fenceIndent = m[1];
      state.innerCh = null;
      return 'fence';
    }
  }

  if (NODE_RE.test(line)) { state.awaitFence = true; state.part = 'bullet'; return 'node'; }
  return 'label';
}

function body(c: Cursor, state: HighlightState): Result {
  if (c.pos === 0) {
    if (state.innerCh) {
      const m = c.s.match(CLOSE_RE);
      if (m && m[2][0] === state.innerCh && m[2].length >= state.innerLen) state.innerCh = null;
      c.skipToEnd();
      return state.innerCh ? 'code' : 'punctuation';
    }
    const m = c.s.match(FENCE_RE);
    if (m) { state.innerCh = m[2][0]; state.innerLen = m[2].length; c.skipToEnd(); return 'punctuation'; }
  }
  if (state.attr) return attrs(c, state);
  return inline(c, state);
}

function headLine(c: Cursor, state: HighlightState): Result {
  if (state.attr) return attrs(c, state);
  if (c.eatSpace()) return null;
  if (c.eat('{')) { enterAttrs(state, 'head'); return 'punctuation'; }
  if (c.eat('[')) { c.eatWhile(/[^\]{\s]/); state.def = true; return 'decorator'; }
  if (c.eat(']')) { state.def = true; return 'decorator'; }
  if (c.eat('@')) { c.eatWhile(/[^\s{]/); state.def = true; return 'namespace'; }
  c.skipToEnd();
  return null;
}

function nodeLine(c: Cursor, state: HighlightState): Result {
  if (state.attr) return attrs(c, state);
  switch (state.part) {
    case 'bullet':
      if (c.eatSpace()) return null;
      c.match(/^(?:[a-zA-Z0-9]+\.|[-*])/);
      state.part = 'attrs';
      return 'bullet';
    case 'attrs':
      if (c.eatSpace()) return null;
      state.part = 'tags';
      if (c.match(/^\{[^}]*\}/, false)) { c.next(); enterAttrs(state, 'tags'); return 'punctuation'; }
      return nodeLine(c, state);
    case 'tags':
      if (c.eatSpace()) return null;
      if (c.match(/^\[[^\]\[{]*\{[^}]*\}\s*\]/, false)) {
        c.next(); c.eatWhile(/[^{\s]/);
        state.part = 'tagBrace';
        return 'decorator';
      }
      if (c.match(/^\[[^\]\[]*\](?![({])/)) return 'decorator';
      state.part = 'label';
      return inline(c, state);
    case 'tagBrace':
      if (c.eatSpace()) return null;
      c.next();
      enterAttrs(state, 'tagEnd');
      return 'punctuation';
    case 'tagEnd':
      state.part = 'tags';
      if (c.match(/^\s*\]/)) return 'decorator';
      return nodeLine(c, state);
    default:
      return inline(c, state);
  }
}

function step(c: Cursor, state: HighlightState): Result {
  switch (state.kind) {
    case 'fence': c.skipToEnd(); return 'punctuation';
    case 'body':  return body(c, state);
    case 'head':  return headLine(c, state);
    case 'node':  return nodeLine(c, state);
    default:      return state.attr ? attrs(c, state) : inline(c, state);
  }
}

// Frontmatter is YAML, not rvmark: a key is marked, everything else is a value.
function frontLine(line: string, state: HighlightState): Token[] | null {
  if (state.front === 'done') return null;
  const tok = (from: number, to: number, type: TokenType): Token => ({ from, to, type, definition: false });
  if (state.front === 'start') {
    if (!/^\uFEFF?---[ \t]*$/.test(line)) { state.front = 'done'; return null; }
    state.front = 'in';
    return [tok(0, line.length, 'punctuation')];
  }
  if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) { state.front = 'done'; return [tok(0, line.length, 'punctuation')]; }
  if (!line.trim()) return [];
  const m = line.match(/^([^\s:#][^:]*)(:)(?=\s|$)/);
  if (!m) return [tok(0, line.length, 'string')];
  const tokens = [tok(0, m[1].length, 'property'), tok(m[1].length, m[0].length, 'punctuation')];
  if (line.length > m[0].length) tokens.push(tok(m[0].length, line.length, 'string'));
  return tokens;
}

/** Tokens of one line, advancing `state` past it. Blank lines must be fed too. */
export function highlightLine(line: string, state: HighlightState): Token[] {
  const front = frontLine(line, state);
  if (front) return front;
  const tokens: Token[] = [];
  if (!line.trim()) return tokens;
  state.kind = classify(line, state);
  const c = new Cursor(line);
  while (!c.eol()) {
    const from = c.pos;
    state.def = false;
    const type = step(c, state);
    if (c.pos === from) c.pos++;
    if (!type) continue;
    const definition = state.def;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type && last.definition === definition && last.to === from) last.to = c.pos;
    else tokens.push({ from, to: c.pos, type, definition });
  }
  return tokens;
}

/** Tokens of every line. */
export function highlight(lines: readonly string[]): Token[][] {
  const state = startState();
  return lines.map(line => highlightLine(line, state));
}
