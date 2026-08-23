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
import { parse, resolveFile } from '../out/shared/parser.js';
import { Multimap } from '../out/shared/multimap.js';
import { seedBag, deriveBag, emptyBag, bagOf, bagToWire, bagFromWire, inheritedProps } from '../out/shared/inherited.js';
import { serializeNode, deserializeNode } from '../out/shared/portable-node.js';
import { sidepanelConfigOf } from '../out/client/sidepanel.js';
import { StateFrame, buildStatePass } from '../out/client/state.js';

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
  assert.ok(props.length >= 3, 'expected at least meta, searchable, sidepanel');
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
  const bag = bagOf(nodeOf(index, 'sidepanel-scope-child'));
  const names = inheritedProps().map(p => p.name).sort();
  assert.deepEqual(Object.keys(bag).sort(), names);
});

// ── Crossing the wire ─────────────────────────────────────────────────────────
// structuredClone is what a postMessage does to a bag: plain data survives,
// prototypes do not. A Multimap that crosses undeclared arrives method-less and
// throws at the first .get() — which is what toWire/fromWire exist to stop.

test('every registered property declares toWire and fromWire together or not at all', () => {
  for (const p of inheritedProps()) {
    assert.equal('toWire' in p, 'fromWire' in p, `${p.name}: half a conversion is worse than none`);
  }
});

test('a sidepanel scope survives a structured clone with its attrs live', () => {
  const node = nodeOf(index, 'sidepanel-scope-child');
  assert.ok(node.sidepanel, 'fixture node carries no sidepanel scope');

  const back = bagFromWire(structuredClone(bagToWire(node)));
  assert.equal(back.sidepanel.rawRef, node.sidepanel.rawRef);
  assert.equal(typeof back.sidepanel.attrs.get, 'function');
  assert.deepEqual(back.sidepanel.attrs.allEntries(), node.sidepanel.attrs.allEntries());
});

test('a node round-trips through an envoy-shaped clone with its scope intact', () => {
  const node = nodeOf(index, 'sidepanel-scope-child');
  // Serialization reads the node's own address for its key. A node straight out
  // of the parser has not been through a SourceFile, so it has none — the point
  // of the test is the inherited bag surviving the clone, not the addressing.
  node.address = { baseUrl: 'https://example.test', key: '/_rvmark/index.rvmark#sidepanel-scope-child' };
  node.pageAddress = 'https://example.test/_rvmark/index.rvmark';

  const back = deserializeNode(structuredClone(serializeNode(node)), 'https://example.test');
  assert.equal(typeof back.sidepanel.attrs.get, 'function');
  assert.equal(back.sidepanel.attrs.get('sidepanel'), node.sidepanel.attrs.get('sidepanel'));
});

test('a node crossing the wire arrives without its subtree, but knowing it has one', () => {
  const node = nodeOf(index, 'sidepanel-scope-root');
  node.address = { baseUrl: 'https://example.test', key: '/_rvmark/index.rvmark#sidepanel-scope-root' };
  node.pageAddress = 'https://example.test/_rvmark/index.rvmark';
  assert.ok(node.children.length, 'fixture node has no children to drop');

  const wire = structuredClone(serializeNode(node));
  assert.equal(wire.children, undefined, 'children must not cross the wire');
  assert.equal(wire.hasChildren, true);

  const back = deserializeNode(wire, 'https://example.test');
  assert.deepEqual(back.children, [], 'a node arrives with no children in hand');
  assert.equal(back.hasChildren, true, 'but knowing childrenOf would answer');
  assert.equal(back.address.baseUrl, 'https://example.test');
  assert.equal(back.address.key, '/_rvmark/index.rvmark#sidepanel-scope-root');
});

test('a bag whose wire form is malformed falls back rather than throwing', () => {
  const bag = bagFromWire({ sidepanel: { rawRef: './x#y', attrs: 'not entries' } });
  assert.equal(bag.sidepanel, null);
});

test('a bag missing from the wire entirely comes back empty, not undefined', () => {
  assert.deepEqual(bagFromWire(undefined), emptyBag());
  assert.deepEqual(bagFromWire({}), emptyBag());
});

test('a bag derived from a bare node with no declarations equals the empty bag', () => {
  const raw = { attrs: new Multimap(), tags: [], children: [] };
  assert.deepEqual(deriveBag(emptyBag(), raw, {}), emptyBag());
});

test('seedBag with an empty head equals the empty bag', () => {
  assert.deepEqual(seedBag(EMPTY_HEAD), emptyBag());
});

// ── sidepanel: inheritance ──────────────────────────────────────────────────────

test('the declaring node carries its own sidepanel', () => {
  const node = nodeOf(index, 'sidepanel-scope-root');
  assert.equal(node.sidepanel.rawRef, './other#other-root');
});

test('a child inherits the sidepanel of its declaring ancestor', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-child').sidepanel.rawRef, './other#other-root');
});

test('inheritance reaches arbitrarily deep, not just one level', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-grandchild').sidepanel.rawRef, './other#other-root');
});

test('a nested declaration overrides for its own subtree', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-nested').sidepanel.rawRef, './other#pass-sidepanel-target');
});

test('the override applies below the node that declares it', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-nested-child').sidepanel.rawRef, './other#pass-sidepanel-target');
});

test('a nested override does not leak back to its siblings', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-child').sidepanel.rawRef, './other#other-root');
});

test('a node outside every sidepanel scope has none', () => {
  assert.equal(nodeOf(index, 'sidepanel-outside').sidepanel, null);
});

test('being outside a scope is inherited too', () => {
  assert.equal(nodeOf(index, 'sidepanel-outside-child').sidepanel, null);
});

test('sidepanel carries the declaring node attrs, so the panel can read sidepanel-pass', () => {
  const node = nodeOf(index, 'pass-sidepanel-host');
  assert.equal(node.sidepanel.attrs.get('sidepanel-pass'), '&exvar rw');
});

test('an inheriting node sees the DECLARING node attrs, not its own', () => {
  // pass-sidepanel-host declares sidepanel-pass; its scope is what descendants get.
  const declaring  = nodeOf(index, 'sidepanel-scope-nested');
  const descendant = nodeOf(index, 'sidepanel-scope-nested-child');
  assert.equal(descendant.sidepanel.attrs, declaring.sidepanel.attrs);
});

// ── sidepanel: the source-tree rule ─────────────────────────────────────────────
//
// The bug this replaced: scope was read by walking rendered ancestors, so a node
// transcluded into a page adopted whatever sidepanel it happened to land under.

test('a node in another file is unaffected by the transcluding page sidepanel', () => {
  // other-root is transcluded under sidepanel-scope-transclude-host, which sits
  // inside sidepanel-scope-root's subtree. Its own file declares no sidepanel.
  assert.equal(nodeOf(other, 'other-root').sidepanel, null);
});

test('the transcluding host keeps the sidepanel its own document gave it', () => {
  assert.equal(
    nodeOf(index, 'sidepanel-scope-transclude-host').sidepanel.rawRef,
    './other#other-root',
  );
});

test('sidepanel resolves for nodes that are never mounted', () => {
  // Nothing here has been rendered — the property is a parse-time fact.
  assert.equal(nodeOf(index, 'sidepanel-scope-grandchild').sidepanel.rawRef, './other#other-root');
});

// ── sidepanel: the reader ───────────────────────────────────────────────────────
//
// sidepanelConfigOf is what the panel actually calls. It touches only sourceNode,
// so a stub with the right shape exercises it without a renderer.

function stubRn(file, slug, pageAddress) {
  const node = nodeOf(file, slug);
  return { sourceNode: { ...node, pageAddress } };
}

test('the reader returns the inherited ref for a node below the declaration', () => {
  const config = sidepanelConfigOf(stubRn(index, 'sidepanel-scope-grandchild', '/index.rvmark'));
  assert.equal(config.rawRef, './other#other-root');
});

test('the reader resolves the ref against the holding node own file', () => {
  const config = sidepanelConfigOf(stubRn(index, 'sidepanel-scope-child', '/sub/index.rvmark'));
  assert.equal(config.sourceFileAddress, '/sub/index.rvmark');
});

test('the reader returns null outside any scope, which blanks the panel', () => {
  assert.equal(sidepanelConfigOf(stubRn(index, 'sidepanel-outside', '/index.rvmark')), null);
});

test('the reader hands the panel the declaring node attrs', () => {
  const config = sidepanelConfigOf(stubRn(index, 'pass-sidepanel-host', '/index.rvmark'));
  assert.equal(config.attrs.get('sidepanel-pass'), '&exvar rw');
});

test('a foreign node under a transcluding host reads no sidepanel from that host', () => {
  // The regression: the old DOM walk gave this node the host page's sidepanel.
  assert.equal(sidepanelConfigOf(stubRn(other, 'other-root', '/other.rvmark')), null);
});

// ── sidepanel-pass binds in the selected node's frame ───────────────────────────
//
// The selected node determines which sidepanel is shown, and likewise the state
// the sidepanel sees: {sidepanel-pass} resolves its names from that node's frame.
// See the comment on sidepanelOpen.

test('sidepanel-pass from a node under a scope reaches the declared variable', () => {
  const scope = new StateFrame(null);
  scope.declare('exvar', '0');
  const host  = new StateFrame(scope);
  const child = new StateFrame(host);

  const pass = buildStatePass(child, [{ childKey: 'exvar', parentKey: 'exvar', mode: 'rw' }]);
  assert.equal(pass._set('exvar', '1'), true, 'write should reach a binding');

  assert.equal(scope.get('exvar'), '1');
});

test('sidepanel-pass observes an intervening let, like any other state attribute', () => {
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
  assert.equal(nodeOf(index, 'sidepanel-outside').searchable, false);
});

// ── meta ──────────────────────────────────────────────────────────────────────

test('meta inherits from the file head', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-child').meta.author, 'test-author');
});

test('meta inherits down the source tree', () => {
  assert.equal(nodeOf(index, 'sidepanel-scope-grandchild').meta.author, 'test-author');
});

test('a node in another file gets that file own head meta, not the transcluding page', () => {
  // other-root is transcluded into index.rvmark, which declares test-author.
  // It keeps its own file's author regardless of where it is rendered.
  assert.equal(nodeOf(other, 'other-root').meta.author, 'other-author');
});

test('meta is always an object, never undefined', () => {
  for (const slug of ['sidepanel-outside', 'sidepanel-scope-root', 'search-child-visible']) {
    assert.equal(typeof nodeOf(index, slug).meta, 'object');
  }
});
