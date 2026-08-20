import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse, resolveFile } from '../out/shared/parser.js';
import { Multimap } from '../out/shared/multimap.js';

const TESTS = dirname(fileURLToPath(import.meta.url));
const SRC = join(TESTS, 'rvmark');
const DIST = join(TESTS, 'dist');

const EMPTY_HEAD = { meta: new Multimap(), tagDefs: {}, origins: {} };

/** Every draft-only string planted in the fixture. */
const DRAFT_STRINGS = [
  'DRAFT_NODE_LABEL',
  'DRAFT_CHILD_LABEL',
  'DRAFT_GRANDCHILD_LABEL',
  'DRAFT_BODY_CONTENT',
  'DRAFT_TOP_BODY_CONTENT',
  'DRAFT_CONTINUATION_TEXT',
  'DRAFT_NESTED_LABEL',
  'DRAFT_NESTED_CHILD_LABEL',
];

const resolved = resolveFile(parse(readFileSync(join(SRC, 'index.rvmark'), 'utf8')), EMPTY_HEAD);

/** Walk every node in the resolved tree. */
function* walk(nodes) {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

const allSlugs = new Set([...walk(resolved.roots)].map(n => n.slug));

/** Nodes reachable once {draft} subtrees are pruned, as the renderer prunes them. */
function* walkPublished(nodes) {
  for (const n of nodes) {
    if (n.attrs.has('draft')) continue;
    yield n;
    yield* walkPublished(n.children);
  }
}

const publishedSlugs = new Set([...walkPublished(resolved.roots)].map(n => n.slug));

// ── Parsing: the fixture really does mark these nodes draft ───────────────────

test('fixture parses with the draft nodes present in the raw tree', () => {
  assert.ok(allSlugs.has('draft-node'));
  assert.ok(allSlugs.has('draft-nested'));
  assert.ok(allSlugs.has('draft-continuation'));
});

test('draft attr is set on the marked nodes', () => {
  for (const slug of ['draft-node', 'draft-with-body', 'draft-continuation', 'draft-nested']) {
    const node = [...walk(resolved.roots)].find(n => n.slug === slug);
    assert.ok(node, `${slug} missing from fixture`);
    assert.ok(node.attrs.has('draft'), `${slug} lacks draft attr`);
  }
});

// ── Pruning: draft subtrees drop out, siblings survive ────────────────────────

test('draft node is pruned', () => {
  assert.ok(!publishedSlugs.has('draft-node'));
});

test('children of a draft node are pruned with it', () => {
  assert.ok(!publishedSlugs.has('draft-child'));
});

test('siblings of a draft node survive', () => {
  assert.ok(publishedSlugs.has('draft-sibling-before'));
  assert.ok(publishedSlugs.has('draft-sibling-after'));
});

test('nested draft node is pruned', () => {
  assert.ok(!publishedSlugs.has('draft-nested'));
});

test('siblings of a nested draft survive', () => {
  assert.ok(publishedSlugs.has('draft-nested-sibling-before'));
  assert.ok(publishedSlugs.has('draft-nested-sibling-after'));
});

test('no draft label text survives pruning', () => {
  const text = [...walkPublished(resolved.roots)]
    .map(n => n.label + '\n' + n.bodyLines.join('\n'))
    .join('\n');
  for (const s of DRAFT_STRINGS) {
    assert.ok(!text.includes(s), `${s} leaked into the published tree`);
  }
});

// ── Build output: nothing draft reaches disk ──────────────────────────────────

test('draft content is absent from built static HTML', () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  for (const s of DRAFT_STRINGS) {
    assert.ok(!html.includes(s), `${s} leaked into index.html`);
  }
});

test('draft content is absent from the served .rvmark source', () => {
  const src = readFileSync(join(DIST, '_rvmark/index.rvmark'), 'utf8');
  for (const s of DRAFT_STRINGS) {
    assert.ok(!src.includes(s), `${s} leaked into the served source`);
  }
});

test('draft file has no built page', () => {
  assert.ok(existsSync(join(SRC, 'draft-file.rvmark')), 'fixture draft-file.rvmark missing');
  assert.ok(!existsSync(join(DIST, 'draft-file/index.html')));
});

test('draft file is absent from the site map', () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const m = html.match(/__RVMARK_SITE_MAP__\s*=\s*(\{.*?\});/s);
  assert.ok(m, 'site map not found in index.html');
  assert.ok(!Object.keys(JSON.parse(m[1])).includes('draft-file'));
});
