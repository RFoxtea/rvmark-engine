import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../out/shared/parser.js';
import { stringifyFile } from '../out/build/stringify.js';
import { migrate } from '../out/shared/migrate.js';

test('frontmatter scalars become meta, as strings', () => {
  const f = parse('---\nrvmark: 2\ntitle: 1984\nauthor: "Some: One"\n---\n@rv {url: https://x.example/}\n\n- A\n');
  assert.equal(f.head.meta.get('rvmark'), '2');
  assert.equal(f.head.meta.get('title'), '1984');
  assert.equal(f.head.meta.get('author'), 'Some: One');
  assert.equal(f.head.origins['@rv'].url, 'https://x.example/');
  assert.equal(f.roots.length, 1);
});

test('unquoted true is a flag, unquoted false is absent, quoted stays text', () => {
  const m = parse('---\ndraft: true\nsearchable: false\ntitle: "true"\nempty:\n---\n- A\n').head.meta;
  assert.equal(m.get('draft'), '');
  assert.equal(m.has('searchable'), false);
  assert.equal(m.get('title'), 'true');
  assert.equal(m.get('empty'), '');
});

test('non-scalar values and block scalars', () => {
  const m = parse('---\ntags: [a, b]\nnested:\n  k: v\ndescription: >\n  long\n  text\n---\n- A\n').head.meta;
  assert.equal(m.has('tags'), false);
  assert.equal(m.has('nested'), false);
  assert.equal(m.get('description'), 'long text');
});

test('errors: newer edition, both header forms, unclosed, invalid YAML', () => {
  assert.throws(() => parse('---\nrvmark: 3\n---\n- A\n'), /edition 3/);
  assert.throws(() => parse('---\ntitle: T\n---\n{author: A}\n- A\n'), /not both/);
  assert.throws(() => parse('---\ntitle: T\n- A\n'), /never closed/);
  assert.throws(() => parse('---\ntitle: a: b\n---\n- A\n'), /frontmatter/);
});

test('the edition-1 meta block still parses', () => {
  assert.equal(parse('{title: Root; draft}\n\n- A\n').head.meta.get('title'), 'Root');
});

test('stringify keeps untouched frontmatter verbatim and edits in place', () => {
  const src = '---\n# a comment\ntitle:   Old\ntags: [a, b]\n---\n\n- A\n';
  const f = parse(src);
  assert.equal(stringifyFile(f), src);
  f.head.meta.set('title', 'New');
  f.head.meta.set('draft', '');
  assert.equal(stringifyFile(f), '---\n# a comment\ntitle: New\ntags: [a, b]\ndraft: true\n---\n\n- A\n');
});

test('migrate rewrites the meta block and nothing else', () => {
  const body = '\n@rv {url: https://x.example/}\n\n1.  {#a}   Odd   spacing\n   - child\n';
  const out = migrate('{title: A: B;\n license: <a href="https://x.example/">CC</a>; draft}' + body, { stamp: true });
  assert.equal(out, '---\nrvmark: 2\ntitle: "A: B"\nlicense: <a href="https://x.example/">CC</a>\ndraft: true\n---' + body);
  const m = parse(out).head.meta;
  assert.equal(m.get('title'), 'A: B');
  assert.equal(m.get('license'), '<a href="https://x.example/">CC</a>');
  assert.equal(m.get('draft'), '');
  assert.equal(migrate(out, { stamp: true }), out);
});

test('migrate leaves headerless files alone unless stamping', () => {
  assert.equal(migrate('- A\n'), '- A\n');
  assert.equal(migrate('- A\n', { stamp: true }), '---\nrvmark: 2\n---\n\n- A\n');
});
