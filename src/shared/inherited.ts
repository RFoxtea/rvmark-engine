/**
 * inherited.ts
 *
 * The registry of *inherited node properties* — values an author sets once on a
 * node (or a file head) that apply to that node and everything beneath it in the
 * source tree.
 *
 * The governing rule is: the owner of a document sets these. Inheritance runs
 * down the source tree at parse time and nowhere else. Where a node is *rendered*
 * — transcluded into another page, federated across an origin — never changes
 * them. A node carries its home document's answer wherever it goes.
 *
 * That rule is why resolution lives here rather than in a walk-up over rendered
 * ancestors: it must answer correctly for nodes that are authored but never
 * mounted (search descends into unrendered children), and it must not vary with
 * where a subtree happens to land.
 *
 * Inheritance bottoms out at the *file*, not at a root node — every property
 * seeds from the resolved Head (which has already merged the inherited-head
 * chain) and may consult tag defs on the way down. That is what a lazy
 * parent-pointer walk cannot supply without teaching every consumer about file
 * heads and tag resolution, and is why the parser owns the threading.
 *
 * The parser itself knows nothing about meta, searchable, or sidepanel. It carries
 * an opaque bag of values down the recursion, asking each registered property to
 * seed and derive itself. Adding an inherited property is one registration here.
 */

import type { Head, NodeAttrs, RawNode, TagDef } from './parser.js';
import { tagsNodeAttrs, mergeNodeAttrs } from './tags.js';
import { Multimap } from './multimap.js';

/**
 * One inherited property.
 *
 *   empty  — the value for a node with no ancestry and nothing declared.
 *   seed   — the file-level starting value, from the resolved Head.
 *   derive — this node's value, given its parent's value and its own raw form.
 *            Called top-down, once per node, at parse time.
 *   toWire  — the value's postMessage-safe form. Omit for plain data.
 *   fromWire — the inverse. Omit for plain data.
 *
 * A bag value crosses an envoy boundary by structured clone, which keeps plain
 * data and drops prototypes: a class instance arrives as a lifeless object with
 * its methods gone. A property whose value is not plain data must therefore say
 * how it travels, which is what the toWire/fromWire pair is for. Adding a
 * property stays one registration; it now includes that declaration when the
 * value needs it.
 */
export interface InheritedProp<T = unknown> {
  name:      string;
  empty:     T;
  seed:      (head: Head) => T;
  derive:    (parentValue: T, raw: RawNode, tagDefs: Record<string, TagDef>) => T;
  toWire?:   (value: T) => unknown;
  fromWire?: (wire: unknown) => T;
}

/** A bag in transit: every property in its declared wire form. */
export type WireBag = Record<string, unknown>;

/** The in-force `{sidepanel}` for a node — see the `sidepanel` registration below. */
export interface SidepanelScope {
  rawRef: string;
  attrs:  NodeAttrs;
}

/**
 * The resolved values for one node, keyed by property name.
 *
 * Typed as the statically-known set so a bag can be spread into a SourceNode
 * without a cast. The registry itself is dynamic — this interface is the one
 * place a newly registered property must also be declared, and the compiler
 * will point at every construction site if it is missing.
 */
export interface InheritedBag {
  meta:       Record<string, unknown>;
  searchable: boolean;
  sidepanel:    SidepanelScope | null;
}

const _props = new Map<string, InheritedProp<any>>();

export function registerInherited<T>(prop: InheritedProp<T>): void {
  _props.set(prop.name, prop);
}

export function inheritedProps(): InheritedProp<any>[] {
  return [..._props.values()];
}

/** The file-level bag: every registered property seeded from `head`. */
export function seedBag(head: Head): InheritedBag {
  const bag: Record<string, unknown> = {};
  for (const p of _props.values()) bag[p.name] = p.seed(head);
  return bag as unknown as InheritedBag;
}

/** Derive a child's bag from its parent's. */
export function deriveBag(
  parent:  InheritedBag,
  raw:     RawNode,
  tagDefs: Record<string, TagDef>,
): InheritedBag {
  const src = parent as unknown as Record<string, unknown>;
  const bag: Record<string, unknown> = {};
  for (const p of _props.values()) bag[p.name] = p.derive(src[p.name], raw, tagDefs);
  return bag as unknown as InheritedBag;
}

/**
 * A bag with every property at its "inherits nothing" value — what a node with
 * no ancestry and no declarations would have. Used as a floor for nodes that
 * arrive without one (an envoy transform may mint a node from scratch), so no
 * consumer has to defend against a missing property.
 */
export function emptyBag(): InheritedBag {
  const bag: Record<string, unknown> = {};
  for (const p of _props.values()) bag[p.name] = p.empty;
  return bag as unknown as InheritedBag;
}

/**
 * Copy the inherited bag off an existing node. Used wherever a node is minted
 * programmatically against a host (synthetic transclusion markers, error nodes)
 * — such a node stands in for its host and inherits exactly what the host has,
 * with no per-property decision to get wrong.
 */
export function bagOf(node: { [k: string]: any }): InheritedBag {
  const bag: Record<string, unknown> = {};
  for (const p of _props.values()) bag[p.name] = node[p.name];
  return bag as unknown as InheritedBag;
}

/** Copy the bag off a node in its wire form — the serialize half. */
export function bagToWire(node: { [k: string]: any }): WireBag {
  const bag: WireBag = {};
  for (const p of _props.values()) {
    const v = node[p.name];
    bag[p.name] = p.toWire && v != null ? p.toWire(v) : v;
  }
  return bag;
}

/**
 * Rebuild a live bag from its wire form — the deserialize half. A property the
 * wire omits falls back to `empty`, so a node minted from scratch by an author
 * transform is still well-formed.
 *
 * A malformed value also falls back rather than throwing: this runs on data
 * that has crossed the sandbox boundary, and author code that returns nonsense
 * for its own node should not take the host's render path down with it.
 */
export function bagFromWire(wire: WireBag | undefined): InheritedBag {
  const bag: Record<string, unknown> = {};
  for (const p of _props.values()) {
    const present = !!wire && p.name in wire;
    const v = present ? wire![p.name] : p.empty;
    if (!present || !p.fromWire || v == null) { bag[p.name] = v; continue; }
    try { bag[p.name] = p.fromWire(v); }
    catch { bag[p.name] = p.empty; }
  }
  return bag as unknown as InheritedBag;
}

// ── Registrations ─────────────────────────────────────────────────────────────

/**
 * meta — arbitrary author key/values, surfaced in the footer on select.
 *
 * Precedence, weakest to strongest: file head → inherited from parent → tag
 * `meta.*` (tag def, then tag props) → the node's own `meta.*` attrs. Nearer
 * and more specific wins.
 */
registerInherited<Record<string, unknown>>({
  name:  'meta',
  empty: {},
  seed: (head) => {
    const o: Record<string, unknown> = {};
    for (const k of head.meta.keys()) o[k] = head.meta.get(k);
    return o;
  },
  derive: (parentMeta, raw, tagDefs) => {
    const tagMeta: Record<string, unknown> = {};
    for (const tag of raw.tags) {
      const def = tagDefs[tag.name];
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
    // Share the parent's object when this node contributes nothing — a derived
    // bag value is never mutated after construction, and an unconditional spread
    // gives every node in a subtree its own identical copy. Same as `sidepanel`
    // below, which returns `parentScope` by reference.
    const hasOwn = Object.keys(tagMeta).length > 0 || Object.keys(attrMeta).length > 0;
    if (!hasOwn) return parentMeta;
    return { ...parentMeta, ...tagMeta, ...attrMeta };
  },
});

/**
 * sidepanel — the sidepanel target a node presents for joint attention. Declared
 * once with `{sidepanel: ./path#slug}` and in force for that whole subtree, so
 * selecting anything beneath the declaring node keeps the same panel up.
 *
 * A nested declaration overrides for its own subtree — nearest wins, like meta.
 *
 * Carried as the raw ref plus the declaring node's attrs (the panel reads
 * `sidepanel-pass` off them). The ref stays raw: inheritance never
 * crosses a file, so every node holding a scope is in the file that declared it,
 * and the reader resolves the ref against its own `sourceFile`.
 */
registerInherited<SidepanelScope | null>({
  name:  'sidepanel',
  empty: null,
  // A file-level {sidepanel} would be a page-wide panel; not a feature today.
  seed:  () => null,
  derive: (parentScope, raw, tagDefs) => {
    const attrs = mergeNodeAttrs(tagsNodeAttrs(raw.tags, tagDefs), raw.attrs);
    const own   = attrs.get('sidepanel');
    return own ? { rawRef: own, attrs } : parentScope;
  },
  // `attrs` is a Multimap and would arrive method-less; entries are the same
  // convention node.attrs already crosses by.
  toWire:   (scope) => ({ rawRef: scope!.rawRef, attrs: scope!.attrs.allEntries() }),
  fromWire: (wire) => {
    const w = wire as { rawRef?: unknown; attrs?: unknown };
    // Checked rather than coerced: Multimap's constructor takes any iterable,
    // and a bare string is one — it would quietly yield an entry per character
    // instead of failing. bagFromWire turns a throw here into `empty`.
    if (typeof w?.rawRef !== 'string' || !Array.isArray(w.attrs)) {
      throw new Error('malformed sidepanel scope on the wire');
    }
    return { rawRef: w.rawRef, attrs: new Multimap(w.attrs as Array<[string, string]>) };
  },
});

/**
 * searchable — licenses search to descend past what is rendered, into authored
 * children of a collapsed or unmounted subtree. Latching: once on, on for the
 * whole subtree; there is no way to turn it back off further down.
 */
registerInherited<boolean>({
  name:  'searchable',
  empty: false,
  seed: (head) => head.meta.has('searchable'),
  derive: (parentSearchable, raw, tagDefs) => {
    if (parentSearchable || raw.attrs.has('searchable')) return true;
    for (const tag of raw.tags) {
      const def = tagDefs[tag.name];
      if (def?.has('node.searchable') || tag.props.has('node.searchable')) return true;
    }
    return false;
  },
});
