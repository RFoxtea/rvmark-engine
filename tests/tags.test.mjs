import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from '../out/parser.js';
import { resolveTagDef, tagsNodeAttrs, mergeNodeAttrs } from '../out/tags.js';
import { Multimap } from '../out/multimap.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), 'rvmark');

const raw = parse(readFileSync(join(SRC, 'index.rvmark'), 'utf8'));
const tagDefs = raw.head.tagDefs;

function* walk(nodes) {
  for (const n of nodes) { yield n; yield* walk(n.children); }
}
const byslug = Object.fromEntries([...walk(raw.roots)].map(n => [n.slug, n]));

/** The tag list on a fixture node, by slug. */
function tagsOf(slug) {
  const node = byslug[slug];
  assert.ok(node, `fixture node ${slug} missing`);
  return node.tags;
}

/** Resolve the first tag on a fixture node against the file's tag defs. */
function resolveFirstTag(slug) {
  const [tag] = tagsOf(slug);
  assert.ok(tag, `node ${slug} carries no tag`);
  return resolveTagDef(tag.name, tag.props, tagDefs);
}

// ── Registry lookup ───────────────────────────────────────────────────────────

test('tag resolves color and tip from the file registry', () => {
  const def = resolveFirstTag('child-tagged');
  assert.equal(def.get('color'), '#9e9bc4ff');
  assert.equal(def.get('tip'), 'AI tip');
});

test('tag with only a color in the registry resolves that color', () => {
  const def = resolveFirstTag('child-wip');
  assert.equal(def.get('color'), '#cc8844');
  assert.equal(def.get('tip'), undefined);
});

test('unregistered tag name resolves to just its inline props', () => {
  const def = resolveTagDef('Nope', new Multimap(), tagDefs);
  assert.equal(def.get('color'), undefined);
  assert.equal(def.get('label'), undefined);
});

// ── Inline props override the registry ────────────────────────────────────────

test('inline color overrides the registry color', () => {
  const def = resolveFirstTag('child-tag-inline-color');
  assert.equal(def.get('color'), '#ff0000');
});

test('inline tip overrides the registry tip', () => {
  const def = resolveFirstTag('child-tag-inline-color');
  assert.equal(def.get('tip'), 'inline tip');
});

test('inline-only tag carries its inline color with no registry entry', () => {
  const [tag] = tagsOf('child-tag-inline-anon');
  assert.equal(tag.name, 'Anon');
  assert.equal(resolveTagDef(tag.name, tag.props, tagDefs).get('color'), '#123456');
});

test('inline label overrides the displayed name', () => {
  const def = resolveFirstTag('child-tag-inline-label');
  assert.equal(def.get('label'), 'W.I.P.');
});

// ── internal: suppresses the chip ─────────────────────────────────────────────

test('registry tag marked internal resolves with the internal flag', () => {
  assert.ok(resolveFirstTag('child-internal').has('internal'));
});

test('a normal tag is not internal', () => {
  assert.ok(!resolveFirstTag('child-tagged').has('internal'));
});

test('dot-prefixed tag is implicitly internal unless it defines a label', () => {
  // [.hidden] in the fixture defines a label, so it stays visible.
  assert.ok(!resolveTagDef('.hidden', new Multimap(), tagDefs).has('internal'));
  // A dot-prefixed tag with no label and no registry entry is internal.
  assert.ok(resolveTagDef('.bare', new Multimap(), tagDefs).has('internal'));
});

// ── node.* attrs projected onto the node ──────────────────────────────────────

test('node.* props on a tag become node attrs with the prefix stripped', () => {
  const attrs = tagsNodeAttrs(tagsOf('child-hidden'), tagDefs);
  assert.equal(attrs.get('show-when'), '&--show-hidden');
});

test('non-node props do not leak into node attrs', () => {
  const attrs = tagsNodeAttrs(tagsOf('child-tagged'), tagDefs);
  assert.equal(attrs.get('color'), undefined);
  assert.equal(attrs.get('tip'), undefined);
});

test('node attrs win over tag-derived attrs when both set a key', () => {
  const tagAttrs = new Multimap([['show-when', 'from-tag']]);
  const nodeAttrs = new Multimap([['show-when', 'from-node']]);
  assert.equal(mergeNodeAttrs(tagAttrs, nodeAttrs).get('show-when'), 'from-node');
});

// ── meta.author cascade source ────────────────────────────────────────────────

test('tag supplies meta.author used by the footer', () => {
  assert.equal(resolveFirstTag('child-tagged').get('meta.author'), 'AI Author');
  assert.equal(resolveFirstTag('child-global-ai').get('meta.author'), 'Global AI Author');
});
