/**
 * node-types.ts
 *
 * What the engine knows about a node type declaratively: its name, and the
 * attributes it understands.
 *
 * The engine reads attributes as strings and has, until now, known nothing about
 * what any of them mean. That is fine everywhere a value is read by the code that
 * understands it, and wrong in one place: a value written in one file and applied
 * in another. A relative address then has to be made absolute against the file
 * that WROTE it, and nothing in a flat string says whether it is an address.
 *
 * Two scopes, because attributes come from two places:
 *
 *   core — engine-owned, meaningful on any node whatever its type. One owner, so
 *          no two declarations can disagree.
 *   type — declared by a node type, meaningful only on nodes of that type. Keyed
 *          by (type, name), so two types may both use `src` for their own
 *          purposes without colliding.
 *
 * A tag definition may only carry core attributes. A tag cannot know what type
 * the nodes it lands on will be, so `node.<some type's attribute>` is a value the
 * engine cannot interpret — see resolveShape, which resolves type attributes only
 * once the merged `type` is known.
 *
 * This is the declarative half of a node type. The other two registries are keyed
 * by the same names and hold code, which is why they are split by environment and
 * this file is not: client/type-registry.ts holds render factories, and
 * envoy/envoy-guest.ts holds author-declared transforms. Both may consult this;
 * neither can be consulted from the other side of the wire.
 *
 * Exports:
 *   declareType      — declare a node type and its attributes
 *   registerCoreAttr — declare an attribute meaningful on any node
 *   attrType         — the declared kind, or undefined
 *   isAddressAttr    — the one kind that currently does work
 *   isTypeDeclared   — whether anything declared this type name
 *   defaultTypeName  — the type a node with no `type` attribute gets
 */

/**
 * The kinds an attribute value can have.
 *
 * Only 'address' currently drives behaviour: it marks a value that names a
 * location and must therefore be resolved against the file it was written in.
 * The rest are declarations — they document what a value is, and exist so the
 * table is a complete statement rather than a list of special cases.
 */
export type AttrType = 'address' | 'text' | 'flag' | 'expr' | 'number' | 'enum';

export interface AttrDecl {
  name: string;
  type: AttrType;
  /** Present only where the attribute is already documented for authors. */
  doc?: string;
}

export interface TypeDecl {
  name:  string;
  attrs: AttrDecl[];
  /** The type a node with no `type` attribute gets. Exactly one type sets it. */
  default?: true;
}

const _core   = new Map<string, AttrType>();
const _byType = new Map<string, Map<string, AttrType>>();
let   _default: string | undefined;

/** Declare an engine attribute, meaningful on any node. */
export function registerCoreAttr(decl: AttrDecl): void {
  _core.set(decl.name, decl.type);
}

/**
 * Declare a node type. Registers the type itself even when it declares no
 * attributes — an absent entry then means "nothing declared this type", which is
 * what lets an unknown type name be told apart from a type with nothing to say.
 */
export function declareType(decl: TypeDecl): void {
  const m = new Map<string, AttrType>();
  for (const a of decl.attrs) m.set(a.name, a.type);
  _byType.set(decl.name, m);
  if (decl.default) _default = decl.name;
}

/** Whether anything declared this type name. */
export function isTypeDeclared(typeName: string): boolean {
  return _byType.has(typeName);
}

/** The type a node with no `type` attribute gets. */
export function defaultTypeName(): string {
  if (!_default) throw new Error('no default node type declared');
  return _default;
}

/**
 * The declared kind of `name` on a node of `typeName`, or undefined if nothing
 * declared it. A type attribute shadows a core one of the same name: the type is
 * the nearer authority on its own nodes.
 *
 * An undeclared `typeName` returns the core kind rather than throwing. Rejecting
 * an unknown type is the caller's job, done once where `type` is read, not once
 * per attribute from a table lookup.
 */
export function attrType(name: string, typeName?: string): AttrType | undefined {
  if (typeName) {
    const t = _byType.get(typeName)?.get(name);
    if (t) return t;
  }
  return _core.get(name);
}

/** Whether `name` holds a location that needs resolving. */
export function isAddressAttr(name: string, typeName?: string): boolean {
  return attrType(name, typeName) === 'address';
}

// ── Core attributes ───────────────────────────────────────────────────────────
//
// Address-valued ones first, since those are the ones that do work. The rest are
// declared so this reads as the full core vocabulary rather than a list of the
// attributes that happened to need something.

registerCoreAttr({ name: 'bullet',      type: 'address' });
registerCoreAttr({ name: 'bullet-open', type: 'address' });
registerCoreAttr({ name: 'sidepanel',   type: 'address' });
registerCoreAttr({ name: 'transclude',  type: 'address' });
registerCoreAttr({ name: 'href',        type: 'address' });

registerCoreAttr({ name: 'id',          type: 'text'   });
registerCoreAttr({ name: 'class',       type: 'text'   });
registerCoreAttr({ name: 'type',        type: 'text'   });
registerCoreAttr({ name: 'label',       type: 'text'   });
registerCoreAttr({ name: 'tip',         type: 'text'   });
registerCoreAttr({ name: 'alt',         type: 'text'   });
registerCoreAttr({ name: 'bullet-alt',  type: 'text'   });
registerCoreAttr({ name: 'ruby',        type: 'text'   });
registerCoreAttr({ name: 'style',       type: 'text'   });
registerCoreAttr({ name: 'color',       type: 'text'   });
registerCoreAttr({ name: 'role',        type: 'text'   });
registerCoreAttr({ name: 'children-pass',  type: 'text' });
registerCoreAttr({ name: 'sidepanel-pass', type: 'text' });

registerCoreAttr({ name: 'draft',        type: 'flag'  });
registerCoreAttr({ name: 'hidden',       type: 'flag'  });
registerCoreAttr({ name: 'internal',     type: 'flag'  });
registerCoreAttr({ name: 'searchable',   type: 'flag'  });
registerCoreAttr({ name: 'bullet-spins', type: 'flag'  });

registerCoreAttr({ name: 'li',   type: 'number' });
registerCoreAttr({ name: 'open', type: 'enum'   });

registerCoreAttr({ name: 'show-when', type: 'expr' });

// Event attributes. Written out rather than derived from STATE_EVENT_ATTRS: that
// set is the span renderer's list of keys it consumes itself, and these are node
// attributes. The two vocabularies coincide today; deriving one from the other
// would make a future divergence silent — which is exactly how `on-destroy` came
// to be implemented on nodes and absent from the set.
registerCoreAttr({ name: 'on-spawn',            type: 'expr' });
registerCoreAttr({ name: 'on-select',           type: 'expr' });
registerCoreAttr({ name: 'on-deselect',         type: 'expr' });
registerCoreAttr({ name: 'on-focus',            type: 'expr' });
registerCoreAttr({ name: 'on-blur',             type: 'expr' });
registerCoreAttr({ name: 'on-action',           type: 'expr' });
registerCoreAttr({ name: 'on-expand',           type: 'expr' });
registerCoreAttr({ name: 'on-collapse',         type: 'expr' });
registerCoreAttr({ name: 'on-no-option-select', type: 'expr' });
registerCoreAttr({ name: 'on-on',               type: 'expr' });
registerCoreAttr({ name: 'on-off',              type: 'expr' });
registerCoreAttr({ name: 'on-destroy',          type: 'expr' });

/**
 * Every span attribute that carries state mutations. A bare `let`/`set`/`remove`
 * in an attr block is sugar for one of these; writing the attribute explicitly
 * (`on-expand: let &x = "1"`) is always available and means the same thing.
 *
 * Read by markdown.ts, which unions it into the span keys renderInlineSpan
 * consumes rather than passing through as data-*. Node attributes are declared
 * above, individually; spans are a separate vocabulary that this set serves and
 * the registry does not yet cover.
 *
 * `on-destroy` is absent deliberately: teardown is a handler concept, and a span
 * is rendered HTML inside a text node's label rather than a handler of its own.
 */
export const STATE_EVENT_ATTRS = new Set([
  'on-spawn', 'on-select', 'on-deselect', 'on-focus', 'on-blur',
  'on-action', 'on-expand', 'on-collapse', 'on-no-option-select',
  // A checkbox span's two transitions (§6). It is neither expanded nor
  // selected, so it needs its own pair: `set` cannot express "flip" — the
  // grammar assigns literals only — and one event could not clear what it set.
  'on-on', 'on-off',
]);
