import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpanParams } from '../out/markdown.js';
import { parseStateEntries } from '../out/parser.js';

// A span's attr block parses to a Multimap, like every other rvmark attr
// collection. State mutations are stored raw under their event key and parsed at
// apply time, so these tests read them back through parseStateEntries.
const entriesOf = (result, key = 'on-action') =>
  result.getAll(key).flatMap(v => parseStateEntries(v));

// ── parseInlineSpanParams: state assignments ───────────────────────────────────

test('parseInlineSpanParams: set &key = "val" → set op', () => {
  const result = parseInlineSpanParams('set &key = "val"');
  assert.deepEqual(entriesOf(result), [{ key: 'key', op: 'set', val: 'val' }]);
});

test('parseInlineSpanParams: let &key = "val" → declare op', () => {
  const result = parseInlineSpanParams('let &key = "val"');
  assert.deepEqual(entriesOf(result), [{ key: 'key', op: 'declare', val: 'val' }]);
});

test('parseInlineSpanParams: let &key bare → declare with val 1', () => {
  const result = parseInlineSpanParams('let &key');
  assert.deepEqual(entriesOf(result), [{ key: 'key', op: 'declare', val: '1' }]);
});

test('parseInlineSpanParams: remove &key → delete op', () => {
  const result = parseInlineSpanParams('remove &key');
  assert.deepEqual(entriesOf(result), [{ key: 'key', op: 'delete' }]);
});

test('parseInlineSpanParams: multiple state mutations via semicolons', () => {
  const result = parseInlineSpanParams('set &a = 1; set &b = 2');
  assert.deepEqual(entriesOf(result), [
    { key: 'a', op: 'set', val: '1' },
    { key: 'b', op: 'set', val: '2' },
  ]);
});

test('parseInlineSpanParams: a quoted ; stays inside one value', () => {
  const result = parseInlineSpanParams('set &a = "x; y"; option');
  assert.equal(result.has('option'), true);
  assert.deepEqual(entriesOf(result), [{ key: 'a', op: 'set', val: 'x; y' }]);
});

test('parseInlineSpanParams: keyword combined with option', () => {
  const result = parseInlineSpanParams('set &step = 0; option');
  assert.equal(result.has('option'), true);
  assert.deepEqual(entriesOf(result), [{ key: 'step', op: 'set', val: '0' }]);
});

test('parseInlineSpanParams: no keyword → no state mutations', () => {
  const result = parseInlineSpanParams('option');
  assert.deepEqual(entriesOf(result), []);
  assert.equal(result.has('option'), true);
});

test('parseInlineSpanParams: bare let/set/remove normalize to on-action', () => {
  const result = parseInlineSpanParams('let &a = "1"');
  assert.deepEqual(result.getAll('on-action'), ['let &a = "1"']);
});

// ── Repeated keys ─────────────────────────────────────────────────────────────
// The bespoke one-field-per-key shape this replaced kept only the last value.

test('parseInlineSpanParams: repeated on-select handlers are all preserved', () => {
  const result = parseInlineSpanParams('on-select: set &a = "1"; on-select: set &b = "2"');
  assert.deepEqual(result.getAll('on-select'), ['set &a = "1"', 'set &b = "2"']);
});

test('parseInlineSpanParams: an explicit on-action joins the bare-form ones', () => {
  const result = parseInlineSpanParams('set &a = "1"; on-action: set &b = "2"');
  assert.deepEqual(entriesOf(result), [
    { key: 'a', op: 'set', val: '1' },
    { key: 'b', op: 'set', val: '2' },
  ]);
});

test('parseInlineSpanParams: repeated class values are all preserved', () => {
  const result = parseInlineSpanParams('class: foo; class: bar');
  assert.deepEqual(result.getAll('class'), ['foo', 'bar']);
});

// ── parseInlineSpanParams: other attrs unaffected ─────────────────────────────

test('parseInlineSpanParams: href', () => {
  const result = parseInlineSpanParams('href: /foo');
  assert.equal(result.get('href'), '/foo');
});

test('parseInlineSpanParams: class', () => {
  const result = parseInlineSpanParams('class: foo bar');
  assert.equal(result.get('class'), 'foo bar');
});

test('parseInlineSpanParams: transclude via =>', () => {
  const result = parseInlineSpanParams('=> #slug');
  assert.equal(result.get('transclude'), '#slug');
});

test('parseInlineSpanParams: selected flag', () => {
  const result = parseInlineSpanParams('selected');
  assert.equal(result.has('selected'), true);
});

test('parseInlineSpanParams: a flag key has the empty-string value, as in parseAttrBlock', () => {
  const result = parseInlineSpanParams('option');
  assert.equal(result.get('option'), '');
});

test('parseInlineSpanParams: an unknown key is kept rather than dropped', () => {
  const result = parseInlineSpanParams('data-thing: 7; someflag');
  assert.equal(result.get('data-thing'), '7');
  assert.equal(result.has('someflag'), true);
});

// ── show-when on a span ────────────────────────────────────────────────────────
// The condition grammar itself is parseShowWhen's (tested via nodes); these
// cover that a span carries the raw values through intact, including the
// multi-value case that a one-field-per-key shape would have collapsed.

test('parseInlineSpanParams: show-when is captured as its raw condition', () => {
  const result = parseInlineSpanParams('show-when: &x == "1"');
  assert.deepEqual(result.getAll('show-when'), ['&x == "1"']);
});

test('parseInlineSpanParams: show-when survives alongside option and a mutation', () => {
  const result = parseInlineSpanParams('option; show-when: &vis; set &a = 1');
  assert.deepEqual(result.getAll('show-when'), ['&vis']);
  assert.equal(result.has('option'), true);
  assert.deepEqual(entriesOf(result), [{ key: 'a', op: 'set', val: '1' }]);
});

test('parseInlineSpanParams: two show-when parts stay distinct', () => {
  const result = parseInlineSpanParams('show-when: &a == 1; show-when: &b == 1');
  assert.deepEqual(result.getAll('show-when'), ['&a == 1', '&b == 1']);
});

test('parseInlineSpanParams: a quoted ; inside show-when does not split the condition', () => {
  const result = parseInlineSpanParams('show-when: &x == "a; b"');
  assert.deepEqual(result.getAll('show-when'), ['&x == "a; b"']);
});
