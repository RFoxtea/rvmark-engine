/**
 * attr-parser.ts
 *
 * Attribute blocks and the state expressions inside them. Kept apart from
 * parser.ts so a framed page can load this grammar without the document parser.
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

// Returns true if the node should be HIDDEN (condition means "hide when").
export function evalShowWhen(raw: string, state: { get(key: string): string | undefined }): boolean {
  return parseShowWhen(raw).some(cond => {
    const lhs = state.get(cond.key);
    if (cond.op === 'truthy')  return !lhs;
    if (cond.op === '!truthy') return !!lhs;
    if (lhs === undefined) return cond.op !== '!=';
    const lhsNum = Number(lhs);
    const rhsRaw = cond.val ?? '';
    const rhs: string | number = Number.isNaN(Number(rhsRaw)) ? rhsRaw : Number(rhsRaw);
    const lhsComp: string | number = (typeof rhs === 'number' && !Number.isNaN(lhsNum)) ? lhsNum : lhs;
    switch (cond.op) {
      case '==': return lhsComp != rhs;
      case '!=': return lhsComp == rhs;
      case '>':  return (lhsComp as number) <= (rhs as number);
      case '<':  return (lhsComp as number) >= (rhs as number);
      case '>=': return (lhsComp as number) <  (rhs as number);
      case '<=': return (lhsComp as number) >  (rhs as number);
    }
    return false;
  });
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
