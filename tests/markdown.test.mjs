import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpanParams } from '../out/markdown.js';

// ── parseInlineSpanParams: state assignments ───────────────────────────────────

test('parseInlineSpanParams: set &key = "val" → set op', () => {
  const result = parseInlineSpanParams('set &key = "val"');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'set', val: 'val' }]);
});

test('parseInlineSpanParams: let &key = "val" → declare op', () => {
  const result = parseInlineSpanParams('let &key = "val"');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'declare', val: 'val' }]);
});

test('parseInlineSpanParams: let &key bare → declare with val 1', () => {
  const result = parseInlineSpanParams('let &key');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'declare', val: '1' }]);
});

test('parseInlineSpanParams: unset &key → delete op', () => {
  const result = parseInlineSpanParams('unset &key');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'delete' }]);
});

test('parseInlineSpanParams: multiple state mutations via semicolons', () => {
  const result = parseInlineSpanParams('set &a = 1; set &b = 2');
  assert.deepEqual(result.stateAssignments, [
    { key: 'a', op: 'set', val: '1' },
    { key: 'b', op: 'set', val: '2' },
  ]);
});

test('parseInlineSpanParams: a quoted ; stays inside one value', () => {
  const result = parseInlineSpanParams('set &a = "x; y"; option');
  assert.equal(result.option, true);
  assert.deepEqual(result.stateAssignments, [{ key: 'a', op: 'set', val: 'x; y' }]);
});

test('parseInlineSpanParams: keyword combined with option', () => {
  const result = parseInlineSpanParams('set &step = 0; option');
  assert.equal(result.option, true);
  assert.deepEqual(result.stateAssignments, [{ key: 'step', op: 'set', val: '0' }]);
});

test('parseInlineSpanParams: no keyword → no stateAssignments', () => {
  const result = parseInlineSpanParams('option');
  assert.equal(result.stateAssignments, undefined);
  assert.equal(result.option, true);
});

// ── parseInlineSpanParams: other attrs unaffected ─────────────────────────────

test('parseInlineSpanParams: href', () => {
  const result = parseInlineSpanParams('href: /foo');
  assert.equal(result.href, '/foo');
});

test('parseInlineSpanParams: class', () => {
  const result = parseInlineSpanParams('class: foo bar');
  assert.equal(result.class, 'foo bar');
});

test('parseInlineSpanParams: transclude via =>', () => {
  const result = parseInlineSpanParams('=> #slug');
  assert.equal(result.transclude, '#slug');
});

test('parseInlineSpanParams: selected flag', () => {
  const result = parseInlineSpanParams('selected');
  assert.equal(result.selected, true);
});
