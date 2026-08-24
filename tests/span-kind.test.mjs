// Which kind a span is: selection-driven (option) or action-driven (manual
// toggle). See rvmark-site/tools/toggle-spans-design-note.md §1c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInlineSpanParams } from '../out/client/markdown.js';
import { spanIsSelectionDriven, isListbox } from '../out/client/listbox-utils.js';
import { Multimap } from '../out/shared/multimap.js';

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

// §6: a targetless {toggle} is a checkbox — independently on/off, where an
// option is one-of-N. It must stay one even where everything else would be
// claimed as an option, or its mutation would fire on selection instead of on
// its own activation.
test('a targetless {toggle} is a checkbox, never an option', () => {
  assert.equal(kind('toggle'), false);
  assert.equal(kind('toggle; set &x = "1"'), false);
  assert.equal(kind('toggle; set &x = "1"', nodeAttrs('listbox')), false);
  assert.equal(kind('toggle; set &x = "1"', nodeAttrs('listbox-volatile')), false);
  // Targetless, so it cannot behave as one-of-N whatever else it says.
  assert.equal(kind('option; toggle'), false);
});

// A transcluding toggle is untouched by the checkbox rule: it has a target, so
// it contends for the children area and keeps disclosure semantics.
test('a transcluding {toggle} is still a manual toggle', () => {
  assert.equal(kind('toggle; => #a'), false);
  assert.equal(kind('toggle; => #a', nodeAttrs('listbox')), false);
});

// Checkboxes are not options, so a label holding only checkboxes has no
// listbox to build — their bare mutations file under on-action like anything
// else, which used to be enough to infer one.
test('a label of checkboxes builds no listbox', () => {
  const spans = new Map([[1, parseInlineSpanParams('toggle; set &x = "1"')]]);
  assert.equal(isListbox(new Multimap(), spans), false);
});
