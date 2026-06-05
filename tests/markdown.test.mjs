import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpanParams } from '../out/markdown.js';

// ── parseInlineSpanParams: state assignments ───────────────────────────────────

test('parseInlineSpanParams: &key<<val → set op', () => {
  const result = parseInlineSpanParams('&key<<val');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'set', val: 'val' }]);
});

test('parseInlineSpanParams: &key=val → declare op', () => {
  const result = parseInlineSpanParams('&key=val');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'declare', val: 'val' }]);
});

test('parseInlineSpanParams: &key bare → declare with val 1', () => {
  const result = parseInlineSpanParams('&key');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'declare', val: '1' }]);
});

test('parseInlineSpanParams: &!key → delete op', () => {
  const result = parseInlineSpanParams('&!key');
  assert.deepEqual(result.stateAssignments, [{ key: 'key', op: 'delete' }]);
});

test('parseInlineSpanParams: multiple state assignments via semicolons in & token', () => {
  const result = parseInlineSpanParams('&a<<1; b<<2');
  // only the &-prefixed token is a state assignment; b<<2 falls through to extra
  assert.deepEqual(result.stateAssignments, [{ key: 'a', op: 'set', val: '1' }]);
});

test('parseInlineSpanParams: & combined with option', () => {
  const result = parseInlineSpanParams('&step<<0; option');
  assert.equal(result.option, true);
  assert.deepEqual(result.stateAssignments, [{ key: 'step', op: 'set', val: '0' }]);
});

test('parseInlineSpanParams: no & prefix → no stateAssignments', () => {
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
