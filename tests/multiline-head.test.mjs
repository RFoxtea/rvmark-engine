/**
 * multiline-head.test.mjs — head constructs wrapping across lines.
 *
 * The meta block, tag defs and origin defs were each matched against a single
 * line. A root header carries every inherited key, so it outgrows one line — and
 * a wrapped one did not merely fail, it vanished: the `{` line matched nothing,
 * the lines fell through to the node collector, which matched them either, and
 * the document parsed with no metadata and no error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../out/shared/parser.js';

test('a meta block may wrap across lines', () => {
  const f = parse('{title: Root;\n author: Someone;\n license: CC0}\n\n- A\n');
  assert.equal(f.head.meta.get('title'), 'Root');
  assert.equal(f.head.meta.get('author'), 'Someone');
  assert.equal(f.head.meta.get('license'), 'CC0');
  assert.equal(f.roots.length, 1);
});

test('a single-line meta block still parses', () => {
  const f = parse('{title: Root; author: Someone}\n\n- A\n');
  assert.equal(f.head.meta.get('title'), 'Root');
  assert.equal(f.head.meta.get('author'), 'Someone');
});

test('a tag def may wrap across lines', () => {
  const f = parse('[Big {\n  node.bullet: /i/x.svg;\n  node.bullet-alt: X\n}]\n\n- [Big] A\n');
  const def = f.head.tagDefs['Big'];
  assert.ok(def, 'tag def missing');
  assert.equal(def.get('node.bullet'), '/i/x.svg');
  assert.equal(def.get('node.bullet-alt'), 'X');
});

test('an origin def may wrap across lines', () => {
  const f = parse('@other {\n  url: https://example.com;\n  fallback: /f\n}\n\n- A\n');
  assert.deepEqual(f.head.origins['@other'], { url: 'https://example.com', fallback: '/f' });
});

test('meta, tag defs and origins may all wrap, in sequence', () => {
  const f = parse(
    '{title: T;\n author: A}\n' +
    '[One {\n node.bullet: /a.svg\n}]\n' +
    '@o {\n url: https://e.com\n}\n' +
    '[Two {node.bullet: /b.svg}]\n' +
    '\n- [One] X\n');
  assert.equal(f.head.meta.get('title'), 'T');
  assert.equal(f.head.tagDefs['One'].get('node.bullet'), '/a.svg');
  assert.equal(f.head.tagDefs['Two'].get('node.bullet'), '/b.svg');
  assert.equal(f.head.origins['@o'].url, 'https://e.com');
  assert.equal(f.roots.length, 1);
});

test('a value containing a closing brace survives', () => {
  const f = parse('{title: a{b}c; author: X}\n\n- A\n');
  assert.equal(f.head.meta.get('title'), 'a{b}c');
  assert.equal(f.head.meta.get('author'), 'X');
});

test('an unclosed head brace throws instead of vanishing', () => {
  assert.throws(
    () => parse('{title: Root;\n author: Someone\n\n- A\n'),
    /unclosed .* in document head/,
  );
});

test('a document with no head is unaffected', () => {
  const f = parse('- A\n- B\n');
  assert.equal(f.roots.length, 2);
  assert.equal(f.head.meta.get('title'), undefined);
});
