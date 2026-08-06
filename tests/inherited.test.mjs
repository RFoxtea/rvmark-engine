/**
 * Inherited node properties (src/inherited.ts).
 *
 * Every property registered there resolves once, down the SOURCE tree, at parse
 * time. These tests pin the two things that follow from that and that the old
 * per-property implementations each got wrong in their own way:
 *
 *   - a node's value comes from its own document's ancestry, never from where
 *     the node is later rendered;
 *   - it is available on nodes that are never mounted.
 *
 * They run on resolveFile output alone — no DOM, no renderer, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse, resolveFile } from '../out/parser.js';
import { Multimap } from '../out/multimap.js';
import { seedBag, deriveBag, emptyBag, bagOf, inheritedProps } from '../out/inherited.js';
import { exhibitConfigOf } from '../out/exhibit.js';
import { StateFrame, buildStatePass } from '../out/state.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), 'rvmark');
const EMPTY_HEAD = { meta: new Multimap(), tagDefs: {}, origins: {} };

function resolveFixture(name) {
  return resolveFile(parse(readFileSync(join(SRC, name), 'utf8')), EMPTY_HEAD);
}

const index = resolveFixture('index.rvmark');
const other = resolveFixture('other.rvmark');

function nodeOf(file, slug) {
  const node = file.nodeMap[slug];
  assert.ok(node, `node ${slug} missing from fixture`);
  return node;
}

// ── The registry itself ───────────────────────────────────────────────────────

test('every registered property supplies the full contract', () => {
  const props = inheritedProps();
  assert.ok(props.length >= 3, 'expected at least meta, searchable, exhibit');
  for (const p of props) {
    assert.equal(typeof p.name, 'string', `${p.name}: name`);
    assert.equal(typeof p.seed, 'function', `${p.name}: seed`);
    assert.equal(typeof p.derive, 'function', `${p.name}: derive`);
    assert.ok('empty' in p, `${p.name}: empty`);
  }
});

test('emptyBag covers exactly the registered properties', () => {
  const bag = emptyBag();
  const names = inheritedProps().map(p => p.name).sort();
  assert.deepEqual(Object.keys(bag).sort(), names);
});

test('bagOf copies every registered property off a node', () => {
  const bag = bagOf(nodeOf(index, 'exhibit-scope-child'));
  const names = inheritedProps().map(p => p.name).sort();
  assert.deepEqual(Object.keys(bag).sort(), names);
});

test('a bag derived from a bare node with no declarations equals the empty bag', () => {
  const raw = { attrs: new Multimap(), tags: [], children: [] };
  assert.deepEqual(deriveBag(emptyBag(), raw, {}), emptyBag());
});

test('seedBag with an empty head equals the empty bag', () => {
  assert.deepEqual(seedBag(EMPTY_HEAD), emptyBag());
});

// ── exhibit: inheritance ──────────────────────────────────────────────────────

test('the declaring node carries its own exhibit', () => {
  const node = nodeOf(index, 'exhibit-scope-root');
  assert.equal(node.exhibit.rawRef, './other#other-root');
});

test('a child inherits the exhibit of its declaring ancestor', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-child').exhibit.rawRef, './other#other-root');
});

test('inheritance reaches arbitrarily deep, not just one level', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-grandchild').exhibit.rawRef, './other#other-root');
});

test('a nested declaration overrides for its own subtree', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-nested').exhibit.rawRef, './other#pass-exhibit-target');
});

test('the override applies below the node that declares it', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-nested-child').exhibit.rawRef, './other#pass-exhibit-target');
});

test('a nested override does not leak back to its siblings', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-child').exhibit.rawRef, './other#other-root');
});

test('a node outside every exhibit scope has none', () => {
  assert.equal(nodeOf(index, 'exhibit-outside').exhibit, null);
});

test('being outside a scope is inherited too', () => {
  assert.equal(nodeOf(index, 'exhibit-outside-child').exhibit, null);
});

test('exhibit carries the declaring node attrs, so the panel can read exhibit-pass', () => {
  const node = nodeOf(index, 'pass-exhibit-host');
  assert.equal(node.exhibit.attrs.get('exhibit-pass'), '&exvar rw');
});

test('an inheriting node sees the DECLARING node attrs, not its own', () => {
  // pass-exhibit-host declares exhibit-pass; its scope is what descendants get.
  const declaring  = nodeOf(index, 'exhibit-scope-nested');
  const descendant = nodeOf(index, 'exhibit-scope-nested-child');
  assert.equal(descendant.exhibit.attrs, declaring.exhibit.attrs);
});

// ── exhibit: the source-tree rule ─────────────────────────────────────────────
//
// The bug this replaced: scope was read by walking rendered ancestors, so a node
// transcluded into a page adopted whatever exhibit it happened to land under.

test('a node in another file is unaffected by the transcluding page exhibit', () => {
  // other-root is transcluded under exhibit-scope-transclude-host, which sits
  // inside exhibit-scope-root's subtree. Its own file declares no exhibit.
  assert.equal(nodeOf(other, 'other-root').exhibit, null);
});

test('the transcluding host keeps the exhibit its own document gave it', () => {
  assert.equal(
    nodeOf(index, 'exhibit-scope-transclude-host').exhibit.rawRef,
    './other#other-root',
  );
});

test('exhibit resolves for nodes that are never mounted', () => {
  // Nothing here has been rendered — the property is a parse-time fact.
  assert.equal(nodeOf(index, 'exhibit-scope-grandchild').exhibit.rawRef, './other#other-root');
});

// ── exhibit: the reader ───────────────────────────────────────────────────────
//
// exhibitConfigOf is what the panel actually calls. It touches only sourceNode,
// so a stub with the right shape exercises it without a renderer.

function stubRn(file, slug, pageAddress) {
  const node = nodeOf(file, slug);
  return { sourceNode: { ...node, sourceFile: { pageAddress } } };
}

test('the reader returns the inherited ref for a node below the declaration', () => {
  const config = exhibitConfigOf(stubRn(index, 'exhibit-scope-grandchild', '/index.rvmark'));
  assert.equal(config.rawRef, './other#other-root');
});

test('the reader resolves the ref against the holding node own file', () => {
  const config = exhibitConfigOf(stubRn(index, 'exhibit-scope-child', '/sub/index.rvmark'));
  assert.equal(config.sourceFileAddress, '/sub/index.rvmark');
});

test('the reader returns null outside any scope, which blanks the panel', () => {
  assert.equal(exhibitConfigOf(stubRn(index, 'exhibit-outside', '/index.rvmark')), null);
});

test('the reader hands the panel the declaring node attrs', () => {
  const config = exhibitConfigOf(stubRn(index, 'pass-exhibit-host', '/index.rvmark'));
  assert.equal(config.attrs.get('exhibit-pass'), '&exvar rw');
});

test('a foreign node under a transcluding host reads no exhibit from that host', () => {
  // The regression: the old DOM walk gave this node the host page's exhibit.
  assert.equal(exhibitConfigOf(stubRn(other, 'other-root', '/other.rvmark')), null);
});

// ── exhibit-pass binds in the selected node's frame ───────────────────────────
//
// The selected node determines which exhibit is shown, and likewise the state
// the exhibit sees: {exhibit-pass} resolves its names from that node's frame.
// See the comment on exhibitOpen.

test('exhibit-pass from a node under a scope reaches the declared variable', () => {
  const scope = new StateFrame(null);
  scope.declare('exvar', '0');
  const host  = new StateFrame(scope);
  const child = new StateFrame(host);

  const pass = buildStatePass(child, [{ childKey: 'exvar', parentKey: 'exvar', mode: 'rw' }]);
  assert.equal(pass._set('exvar', '1'), true, 'write should reach a binding');

  assert.equal(scope.get('exvar'), '1');
});

test('exhibit-pass observes an intervening let, like any other state attribute', () => {
  const scope = new StateFrame(null);
  scope.declare('exvar', '0');
  const middle = new StateFrame(scope);
  middle.declare('exvar', '0');   // an in-between {let &exvar = 0}
  const child = new StateFrame(middle);

  const pass = buildStatePass(child, [{ childKey: 'exvar', parentKey: 'exvar', mode: 'rw' }]);
  assert.equal(pass._set('exvar', '1'), true, 'write should reach a binding');

  assert.equal(middle.get('exvar'), '1', 'nearest binding takes the write');
  assert.equal(scope.get('exvar'),  '0', 'outer binding is untouched');
});

// ── searchable ────────────────────────────────────────────────────────────────

test('a node under {searchable} is in scope', () => {
  assert.equal(nodeOf(index, 'search-child-visible').searchable, true);
});

test('searchable latches on for the whole subtree', () => {
  assert.equal(nodeOf(index, 'search-grandchild-collapsed').searchable, true);
});

test('a node outside every {searchable} is not in scope', () => {
  assert.equal(nodeOf(index, 'search-unsearchable-node').searchable, false);
  assert.equal(nodeOf(index, 'search-unsearchable-child').searchable, false);
});

test('searchable is false, not undefined, when absent', () => {
  assert.equal(nodeOf(index, 'exhibit-outside').searchable, false);
});

// ── meta ──────────────────────────────────────────────────────────────────────

test('meta inherits from the file head', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-child').meta.author, 'test-author');
});

test('meta inherits down the source tree', () => {
  assert.equal(nodeOf(index, 'exhibit-scope-grandchild').meta.author, 'test-author');
});

test('a node in another file gets that file own head meta, not the transcluding page', () => {
  // other-root is transcluded into index.rvmark, which declares test-author.
  // It keeps its own file's author regardless of where it is rendered.
  assert.equal(nodeOf(other, 'other-root').meta.author, 'other-author');
});

test('meta is always an object, never undefined', () => {
  for (const slug of ['exhibit-outside', 'exhibit-scope-root', 'search-child-visible']) {
    assert.equal(typeof nodeOf(index, slug).meta, 'object');
  }
});
