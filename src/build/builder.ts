/**
 * builder.ts
 *
 * Helpers for scripts that generate `.rvmark` source files, so they can manipulate
 * rvmark abstract syntax trees (SourceNode/SourceFile objects) rather than concatenate 
 * text.
 *
 * Pairs well with other modules:
 * 
 *   parse()   text → tree
 *   build*()  fields → tree
 *   stringify text ← tree
 *
 * Exports:
 *   buildNode(spec)            → a SourceNode (ordinals stubbed; call assignOrdinals)
 *   buildFile(spec)            → a SourceFile with ordinals finalised + nodeMap built
 *   escapeLabel(text)          → escape a label body's rvmark-significant chars
 *   escapeAttrValue(text)      → escape an attr value's rvmark-significant chars
 *   span(text, spec)           → an inline `[text]{…}` span string for a label
 */

import { Multimap } from '../shared/multimap.js';
import { assignOrdinals } from '../shared/parser.js';
import type { SourceNode, SourceFile, Head, Tag, OriginDef } from '../shared/parser.js';
import { TagDef } from '../shared/parser.js';

// ── attrs / tags input coercion ─────────────────────────────────────────────

// Object literals are the ergonomic case; a Multimap is accepted verbatim for
// callers that need repeated keys or full control. `Multimap.from` handles the
// object case (incl. array values → repeated keys, e.g. two on-select handlers).
export type AttrsInput = Multimap | Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;

function toMultimap(input: AttrsInput | undefined): Multimap {
  if (!input) return new Multimap();
  return input instanceof Multimap ? input.clone() : Multimap.from(input);
}

// A tag is either a bare name ('.euclid', 'hr') or { name, props }.
export type TagInput = string | { name: string; props?: AttrsInput };

function toTag(input: TagInput): Tag {
  if (typeof input === 'string') return { name: input, props: new Multimap() };
  return { name: input.name, props: toMultimap(input.props) };
}

// ── node builder ────────────────────────────────────────────────────────────

export interface NodeSpec {
  /** Explicit ordinal literal ('1', '02', 'd', …). Omit and pass `auto: true`
   *  for a '-'/'*' auto-numbered bullet whose number assignOrdinals resolves. */
  numbering?: string | number;
  /** Auto-numbered bullet: number is assigned from siblings by assignOrdinals. */
  auto?: boolean;
  /** Shorthand for the `id` attr; merged into attrs (also sets slug/permalink). */
  id?: string;
  /** Shorthand for the `type` attr (the `= foo` sigil). */
  type?: string;
  /** Shorthand for the `transclude` attr (the `=> ref` sigil). */
  transclude?: string;
  attrs?: AttrsInput;
  tags?: TagInput[];
  label?: string;
  /** Fenced-body content lines (no fence markers — stringify adds them). */
  body?: string[];
  children?: SourceNode[];
}

/**
 * Build a single SourceNode. The identity fields (slug/permalinkId/numbering) are
 * stubbed here — a node's number depends on its siblings, so it can only be
 * resolved once the whole sibling group exists. Call assignOrdinals() on the
 * finished tree (buildFile does this for you) before stringify().
 *
 * `id`/`type`/`transclude` are conveniences that prepend the corresponding attr;
 * an explicit `attrs` Multimap already containing them is respected (the
 * shorthand only appends, so pass one or the other, not both, for a given key).
 */
export function buildNode(spec: NodeSpec = {}): SourceNode {
  const attrs = toMultimap(spec.attrs);
  // Shorthands are prepended (via a fresh map) so they read first in output,
  // matching how authors write `{#id; …}`.
  if (spec.id != null || spec.type != null || spec.transclude != null) {
    const merged = new Multimap();
    if (spec.id != null)         merged.append('id', spec.id);
    if (spec.type != null)       merged.append('type', spec.type);
    if (spec.transclude != null) merged.append('transclude', spec.transclude);
    for (const [k, v] of attrs.allEntries()) merged.append(k, v);
    return makeNode(spec, merged);
  }
  return makeNode(spec, attrs);
}

function makeNode(spec: NodeSpec, attrs: Multimap): SourceNode {
  return {
    slug: '',
    permalinkId: '',
    numbering: spec.numbering != null ? String(spec.numbering) : '',
    auto: spec.auto ?? false,
    attrs,
    tags: (spec.tags ?? []).map(toTag),
    label: spec.label ?? '',
    bodyLines: spec.body ?? [],
    children: spec.children ?? [],
  };
}

// ── file builder ────────────────────────────────────────────────────────────

export interface HeadSpec {
  meta?:    AttrsInput;
  tagDefs?: Record<string, AttrsInput>;
  origins?: Record<string, OriginDef>;
}

export interface FileSpec {
  head?:  HeadSpec;
  roots:  SourceNode[];
}

/**
 * Build a finalised SourceFile: coerces the head, then runs assignOrdinals over the
 * roots so numbering/slug/permalinkId are filled in and nodeMap is populated —
 * the result is ready for stringifyFile().
 */
export function buildFile(spec: FileSpec): SourceFile {
  const tagDefs: Record<string, TagDef> = {};
  for (const [name, def] of Object.entries(spec.head?.tagDefs ?? {})) {
    tagDefs[name] = new TagDef(toMultimap(def));
  }
  const head: Head = {
    meta:    toMultimap(spec.head?.meta),
    tagDefs,
    origins: spec.head?.origins ?? {},
  };
  const nodeMap: Record<string, SourceNode> = {};
  assignOrdinals(spec.roots, nodeMap);
  return { head, roots: spec.roots, nodeMap };
}

// ── escaping ────────────────────────────────────────────────────────────────

// A label body is markdown with rvmark extensions. The characters that would be
// interpreted rather than shown literally are the inline-span/label delimiters:
//   [ ]   open/close of a [Tag] token or an inline [text]{…} span
//   { }   an {attrs} block (only special at label start) or a span's params
//   &     state sigil (only special inside an attr/param block, but escaped for
//         safety so a bare '&' in prose never reads as a sigil)
// Mirrors the span parser's `\]`-style escaping (markdown.ts) and is the exact
// inverse of what the parser strips. Backslash itself is escaped first so we
// don't double-escape an already-escaped sequence.
export function escapeLabel(text: string): string {
  return text.replace(/[\\[\]{}&]/g, '\\$&');
}

// An attr *value* (right of `key:` inside a `{…}` block) must not contain the
// block terminators, or it would end the block / start a new entry early.
//   }   closes the attr block
//   ;   separates entries
// Values are not markdown, so brackets/braces-as-text don't apply; only the
// structural delimiters need escaping.
export function escapeAttrValue(text: string): string {
  return text.replace(/[\\};]/g, '\\$&');
}

// ── inline span constructor ─────────────────────────────────────────────────

export interface SpanSpec {
  /** State assignments, each a full sigil segment, e.g. '&e-ri<<A|typ' or '!&k'. */
  state?:      string | string[];
  /** '=> ref' transclusion target (without the '=>'). */
  transclude?: string;
  /** Marks the span an option (`option`). */
  option?:     boolean;
  /** Marks the span a manual toggle (`toggle`). Only needed to opt out of a
   *  node-level `{listbox}`/`{listbox-volatile}`, which otherwise makes every
   *  span an option. */
  toggle?:     boolean;
  class?:      string;
  /** Any other `key: val` params, in order. */
  extra?:      Record<string, string>;
}

/**
 * Construct an inline span `[text]{params}` for embedding in a node label — the
 * construct-direction counterpart to markdown.ts's parseInlineSpanParams. The
 * visible `text` is label-escaped; params are emitted in the canonical order
 * (state, transclude, option, toggle, class, extra) joined by '; '.
 *
 * Example: span('A', { state: '&e-ri<<A|point' }) → `[A]{&e-ri<<A|point}`
 */
export function span(text: string, spec: SpanSpec = {}): string {
  const params: string[] = [];
  if (spec.state != null) {
    for (const s of Array.isArray(spec.state) ? spec.state : [spec.state]) params.push(s);
  }
  if (spec.transclude != null) params.push(`=> ${spec.transclude}`);
  if (spec.option) params.push('option');
  if (spec.toggle) params.push('toggle');
  if (spec.class != null) params.push(`class: ${spec.class}`);
  for (const [k, v] of Object.entries(spec.extra ?? {})) params.push(`${k}: ${v}`);

  const body = escapeLabel(text);
  return params.length ? `[${body}]{${params.join('; ')}}` : `[${body}]`;
}
