// The '^' entry prefix: transclude the target node itself rather than the
// children it would otherwise be unwrapped into. Per-entry, so a
// multiple-transclusion can mix the two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscludeEntry, absolutiseTranscludeList } from '../out/shared/shared.js';

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

// ── absolutiseTranscludeList ────────────────────────────────────────────────
//
// A `transclude` value is a comma-separated LIST, and two of its tokens are not
// addresses: '*' (the node's own children) and '^' (the target as a row). The
// origin used to hand the whole value to absolutiseRef, which read it as one
// ref: `*, #other` came back as `/dir/*, #other`, the client's `entry === '*'`
// test then failed, and the star silently contributed nothing — a node's own
// lines vanished while the refs beside them still resolved.

const FILE = 'http://x/_rvmark/games/text-adventure.rvmark';

test('a lone star is not an address', () => {
  assert.equal(absolutiseTranscludeList('*', FILE), '*');
});

test('a star keeps its meaning beside a ref', () => {
  assert.equal(
    absolutiseTranscludeList('*, #peasant-woman-dialogue', FILE),
    '*, #peasant-woman-dialogue',
  );
});

test('every entry in a list is absolutised, not just the first', () => {
  assert.equal(
    absolutiseTranscludeList('a.rvmark, ./b.rvmark#n', FILE),
    '/games/a.rvmark, /games/b.rvmark#n',
  );
});

// Absolutising through the prefix would embed it mid-string ('/games/^#foo'),
// where parseTranscludeEntry's leading-only strip can no longer see it.
test('^ survives as a prefix, not as part of the path', () => {
  assert.equal(absolutiseTranscludeList('^#foo', FILE), '^#foo');
});

test('^ on a relative ref absolutises the ref beneath it', () => {
  assert.equal(
    absolutiseTranscludeList('^./other.rvmark#x', FILE),
    '^/games/other.rvmark#x',
  );
});

test('^ and the star compose', () => {
  assert.equal(absolutiseTranscludeList('^*', FILE), '^*');
});

// The early-outs absolutiseRef already had, reached one entry at a time.
test('fragments, sigils and absolute refs are left alone', () => {
  assert.equal(
    absolutiseTranscludeList('#frisia, @site/x, /abs/x', FILE),
    '#frisia, @site/x, /abs/x',
  );
});

test('relative refs still resolve against the writing file', () => {
  assert.equal(absolutiseTranscludeList('./rel.rvmark', FILE), '/games/rel.rvmark');
});

// Idempotent for the same reason absolutiseRef is: its own output is the case
// each early-out returns untouched.
test('absolutising twice changes nothing', () => {
  const once = absolutiseTranscludeList('*, ./b.rvmark, ^#c', FILE);
  assert.equal(absolutiseTranscludeList(once, FILE), once);
});

test('an empty value is left alone', () => {
  assert.equal(absolutiseTranscludeList('', FILE), '');
});
