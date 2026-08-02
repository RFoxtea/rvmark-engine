import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse, resolveFile } from '../out/parser.js';
import { Multimap } from '../out/multimap.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), 'rvmark');
const EMPTY_HEAD = { meta: new Multimap(), tagDefs: {}, origins: {} };

function resolveFixture(name) {
  return resolveFile(parse(readFileSync(join(SRC, name), 'utf8')), EMPTY_HEAD);
}

const index = resolveFixture('index.rvmark');
const other = resolveFixture('other.rvmark');

/** Resolved meta for a node, by slug. */
function metaOf(file, slug) {
  const node = file.nodeMap[slug];
  assert.ok(node, `node ${slug} missing from fixture`);
  return node.meta;
}

/** First child of a node, by slug. */
function firstChild(file, slug) {
  const node = file.nodeMap[slug];
  assert.ok(node, `node ${slug} missing from fixture`);
  assert.ok(node.children.length, `node ${slug} has no children`);
  return node.children[0];
}

// ── File-level metadata ───────────────────────────────────────────────────────

test('file metadata supplies author and license', () => {
  assert.equal(index.head.meta.get('author'), 'test-author');
  assert.equal(index.head.meta.get('license'), 'Test License');
  assert.equal(index.head.meta.get('title'), 'Test Fixture');
});

test('an untagged node inherits the file author', () => {
  assert.equal(metaOf(index, 'child-b').author, 'test-author');
});

// ── Tag-supplied meta overrides the file ──────────────────────────────────────

test('tag meta.author overrides the file author on the tagged node', () => {
  assert.equal(metaOf(index, 'child-tagged').author, 'AI Author');
});

test('tag meta.author cascades to children of the tagged node', () => {
  assert.equal(firstChild(index, 'child-tagged').meta.author, 'AI Author');
});

test('a sibling outside the tagged subtree keeps the file author', () => {
  assert.equal(metaOf(index, 'child-a').author, 'test-author');
});

test('a second registry tag supplies its own author', () => {
  assert.equal(metaOf(index, 'child-global-ai').author, 'Global AI Author');
  assert.equal(firstChild(index, 'child-global-ai').meta.author, 'Global AI Author');
});

// ── Cascade depth and precedence ──────────────────────────────────────────────

test('tag meta cascades through a synthetic multi-level subtree', () => {
  // The index fixture's tagged subtree is only one level deep, so build a
  // deeper one to pin the recursion rather than the fixture's shape.
  const src = [
    '{author: file-author}',
    '[T {meta.author: Tag Author}]',
    '',
    '1. {#top} [T] Top',
    '  1. {#mid} Mid',
    '    1. {#deep} Deep',
  ].join('\n');
  const f = resolveFile(parse(src), EMPTY_HEAD);
  assert.equal(f.nodeMap['top'].meta.author, 'Tag Author');
  assert.equal(f.nodeMap['mid'].meta.author, 'Tag Author');
  assert.equal(f.nodeMap['deep'].meta.author, 'Tag Author');
});

test('a deeper tag overrides an ancestor tag for its own subtree', () => {
  const src = [
    '{author: file-author}',
    '[T {meta.author: Outer}]',
    '[U {meta.author: Inner}]',
    '',
    '1. {#top} [T] Top',
    '  1. {#mid} [U] Mid',
    '    1. {#deep} Deep',
  ].join('\n');
  const f = resolveFile(parse(src), EMPTY_HEAD);
  assert.equal(f.nodeMap['top'].meta.author, 'Outer');
  assert.equal(f.nodeMap['mid'].meta.author, 'Inner');
  assert.equal(f.nodeMap['deep'].meta.author, 'Inner');
});

test('a node attr meta.* overrides a tag on the same node', () => {
  const src = [
    '[T {meta.author: Tag Author}]',
    '',
    '1. {#top; meta.author: Attr Author} [T] Top',
  ].join('\n');
  const f = resolveFile(parse(src), EMPTY_HEAD);
  assert.equal(f.nodeMap['top'].meta.author, 'Attr Author');
});

test('non-author file meta still reaches nodes inside a tagged subtree', () => {
  assert.equal(metaOf(index, 'child-tagged').license, 'Test License');
});

// ── Cross-file resolution ─────────────────────────────────────────────────────

test('a tagged node in another file resolves that tag author', () => {
  // other.rvmark inherits no head here, so its own tag defs must carry the meta.
  const node = other.nodeMap['other-ai-node'];
  assert.ok(node, 'other-ai-node missing from other.rvmark');
  // The tag is defined in index.rvmark; without inheritance there is no meta.
  // Resolving with index's head as the inherited head is what the site does.
  const withHead = resolveFile(
    parse(readFileSync(join(SRC, 'other.rvmark'), 'utf8')),
    index.head,
  );
  assert.equal(withHead.nodeMap['other-ai-node'].meta.author, 'Global AI Author');
});

test('a file’s own head metadata wins over the inherited head', () => {
  const withHead = resolveFile(
    parse(readFileSync(join(SRC, 'other.rvmark'), 'utf8')),
    index.head,
  );
  // index.rvmark is titled "Test Fixture"; other.rvmark titles itself.
  assert.equal(index.head.meta.get('title'), 'Test Fixture');
  assert.equal(withHead.head.meta.get('title'), 'Other Fixture');
});
