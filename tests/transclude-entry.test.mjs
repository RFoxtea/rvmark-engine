// The '^' entry prefix: transclude the target node itself rather than the
// children it would otherwise be unwrapped into. Per-entry, so a
// multiple-transclusion can mix the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscludeEntry } from '../out/shared.js';

test('a bare ref is not whole-node', () => {
  assert.deepEqual(parseTranscludeEntry('./book-1#p-3'), {
    ref: './book-1#p-3', wholeNode: false,
  });
});

test('a ^ ref is whole-node and loses the prefix', () => {
  assert.deepEqual(parseTranscludeEntry('^./book-1#p-3'), {
    ref: './book-1#p-3', wholeNode: true,
  });
});

test('^ sits outside a sigil ref', () => {
  assert.deepEqual(parseTranscludeEntry('^@alice/path#slug'), {
    ref: '@alice/path#slug', wholeNode: true,
  });
});

// Entries arrive from a comma split that already trims, but the prefix must
// survive whitespace on either side of it either way.
test('whitespace around the prefix is tolerated', () => {
  assert.deepEqual(parseTranscludeEntry('  ^ #p-3  '), {
    ref: '#p-3', wholeNode: true,
  });
});

// '^' is not a path, slug, or sigil character, so nothing in the existing ref
// grammar can be mistaken for it.
test('refs that merely contain ^ are untouched', () => {
  assert.deepEqual(parseTranscludeEntry('#a^b'), { ref: '#a^b', wholeNode: false });
});

test('the wildcard is unaffected', () => {
  assert.deepEqual(parseTranscludeEntry('*'), { ref: '*', wholeNode: false });
});
