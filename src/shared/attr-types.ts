/**
 * attr-types.ts
 *
 * What kind of value an attribute holds, by attribute name.
 *
 * The engine reads attributes as strings and has, until now, known nothing
 * about what any of them mean. That is fine everywhere a value is read by the
 * code that understands it, and wrong in one place: a value written in one file
 * and applied in another. A relative address then has to be made absolute
 * against the file that WROTE it, and nothing in a flat string says whether it
 * is an address at all.
 *
 * Two scopes, because attributes come from two places:
 *
 *   core — engine-owned, meaningful on any node whatever its type. One owner,
 *          so no two declarations can disagree.
 *   type — declared by a node type, meaningful only on nodes of that type. Keyed
 *          by (type, name), so two custom types may both use `src` for their own
 *          purposes without colliding.
 *
 * A tag definition may only carry core attributes. A tag cannot know what type
 * the nodes it lands on will be, so `node.<some type's attribute>` is a value
 * the engine cannot interpret — see resolveShape, which resolves type attributes
 * only once the merged `type` is known.
 *
 * Exports:
 *   registerCoreAttr / registerTypeAttr — declare an attribute
 *   attrType                            — the declared kind, or undefined
 *   isAddressAttr                       — the one kind that currently does work
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

interface AttrDecl {
  name: string;
  type: AttrType;
}

const _core = new Map<string, AttrType>();
const _byType = new Map<string, Map<string, AttrType>>();

/** Declare an engine attribute, meaningful on any node. */
export function registerCoreAttr(decl: AttrDecl): void {
  _core.set(decl.name, decl.type);
}

/** Declare an attribute belonging to one node type. */
export function registerTypeAttr(typeName: string, decl: AttrDecl): void {
  let m = _byType.get(typeName);
  if (!m) { m = new Map(); _byType.set(typeName, m); }
  m.set(decl.name, decl.type);
}

/**
 * The declared kind of `name` on a node of `typeName`, or undefined if nothing
 * declared it. A type attribute shadows a core one of the same name: the type
 * is the nearer authority on its own nodes.
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

registerCoreAttr({ name: 'draft',        type: 'flag'  });
registerCoreAttr({ name: 'hidden',       type: 'flag'  });
registerCoreAttr({ name: 'internal',     type: 'flag'  });
registerCoreAttr({ name: 'searchable',   type: 'flag'  });
registerCoreAttr({ name: 'bullet-spins', type: 'flag'  });
registerCoreAttr({ name: 'title',        type: 'flag'  });

registerCoreAttr({ name: 'li',   type: 'number' });
registerCoreAttr({ name: 'open', type: 'enum'   });

registerCoreAttr({ name: 'show-when', type: 'expr' });

/**
 * Every event attribute that carries state mutations. A bare `let`/`set`/`remove`
 * in an attr block is sugar for one of these; writing the attribute explicitly
 * (`on-expand: let &x = "1"`) is always available and means the same thing.
 *
 * Lives here rather than in parser.ts so this file can be the whole attribute
 * vocabulary without importing the parser — which imports this.
 */
export const STATE_EVENT_ATTRS = new Set([
  'on-spawn', 'on-select', 'on-deselect', 'on-focus', 'on-blur',
  'on-action', 'on-expand', 'on-collapse', 'on-no-option-select',
  // A checkbox span's two transitions (§6). It is neither expanded nor
  // selected, so it needs its own pair: `set` cannot express "flip" — the
  // grammar assigns literals only — and one event could not clear what it set.
  'on-on', 'on-off',
]);

for (const name of STATE_EVENT_ATTRS) registerCoreAttr({ name, type: 'expr' });
