// Which kind a span is: selection-driven (option) or action-driven (manual
// toggle). See rvmark-site/tools/toggle-spans-design-note.md §1c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpanParams } from '../out/markdown.js';
import { spanIsSelectionDriven } from '../out/listbox-utils.js';
import { Multimap } from '../out/multimap.js';

const nodeAttrs = (...keys) => {
  const m = new Multimap();
  for (const k of keys) m.append(k, '');
  return m;
};
const kind = (params, attrs = new Multimap()) =>
  spanIsSelectionDriven(parseInlineSpanParams(params), attrs);

test('a bare transcluding span is a manual toggle', () => {
  assert.equal(kind('=> ./book-1#p-3'), false);
});

test('{option} is selection-driven', () => {
  assert.equal(kind('option; => #a'), true);
});

test('node-level listbox makes an unmarked span an option', () => {
  assert.equal(kind('=> #a', nodeAttrs('listbox')), true);
  assert.equal(kind('=> #a', nodeAttrs('listbox-volatile')), true);
});

// The Euclid case: [.euclid] puts {listbox-volatile} on every node, so a
// citation must be able to say it is a manual toggle and be believed.
test('explicit {toggle} opts out of a node-level listbox', () => {
  assert.equal(kind('=> ./book-1#p-3; toggle', nodeAttrs('listbox-volatile')), false);
  assert.equal(kind('=> ./book-1#p-3; toggle', nodeAttrs('listbox')), false);
});

// §1c: an option already is a toggle, so the pair is redundant, not a conflict.
// {option} is explicit about what drives it and wins.
test('{option; toggle} stays selection-driven', () => {
  assert.equal(kind('option; toggle; => #a'), true);
  assert.equal(kind('option; toggle; => #a', nodeAttrs('listbox-volatile')), true);
});

// A targetless highlight span alongside a citation: still an option, so
// arrowing across it never knocks the citation off the hill.
test('targetless span under listbox-volatile stays an option', () => {
  assert.equal(kind('let &e-ri = "AB|line"', nodeAttrs('listbox-volatile')), true);
});
