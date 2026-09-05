// The '*' entry through the SERVING path.
//
// '*' names a node's own children, so a `{=> *, #other}` node keeps its own
// lines and borrows a shared block beside them — the idiom behind dialogue,
// menus, and anything with a reusable option list.
//
// The unit tests in transclude-entry.test.mjs cover the absolutiser in
// isolation. These serve a real document instead, because the failure they
// exist to catch was not in the star handling at all: the origin rewrote '*'
// into a directory path on its way to the client ('/games/*'), the client's
// `entry === '*'` test then failed, and the node's own lines silently vanished
// while the ref beside them still resolved. Nothing errored, and no fixture
// anywhere wrote '=> *', so the corpus never met the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, resolveFile } from '../out/shared/parser.js';
import { Multimap } from '../out/shared/multimap.js';
import { RvFile } from '../out/envoy/rv-file.js';

const EMPTY_HEAD = { meta: new Multimap(), tagDefs: {}, origins: {} };

// A file in a subdirectory: the bug only appeared where a directory prefix
// existed to be glued on, so a root-level fixture would have passed throughout.
function serve(src, pageAddress = '/_rvmark/games/g.rvmark') {
  const file = resolveFile(parse(src), EMPTY_HEAD);
  return new RvFile(file.nodeMap, file.roots, EMPTY_HEAD, 'games/g.rvmark', pageAddress);
}

const DOC = `
- {#talk} [.option] Talk
- {#greeting; => *, #options}
   - "Hail, and well met."
   - "What's it to you?"
- {#options}
   - [.option] "Nothing."
`;

test('a served * entry is not rewritten into a path', () => {
  const served = serve(DOC);
  assert.equal(served.nodeMap['greeting'].attrs.get('transclude'), '*, #options');
});

test('a served * entry survives at the root of a site too', () => {
  const served = serve(DOC, '/_rvmark/g.rvmark');
  assert.equal(served.nodeMap['greeting'].attrs.get('transclude'), '*, #options');
});

// The half that kept working is what made the bug hard to see: the ref resolved
// and its options rendered, so the node looked alive with its own lines missing.
test('the ref beside a * is still a resolvable fragment', () => {
  const served = serve(DOC);
  const [star, ref] = served.nodeMap['greeting'].attrs.get('transclude').split(',').map(s => s.trim());
  assert.equal(star, '*');
  assert.equal(ref, '#options');
});

test('the children a * contributes are still served', () => {
  const served = serve(DOC);
  const kids = served.nodeMap['greeting'].children;
  assert.deepEqual(kids.map(k => k.label), ['"Hail, and well met."', '"What\'s it to you?"']);
});

// A relative ref in the same list must still be absolutised: the fix exempts
// the star, not the list.
test('a relative ref beside a * is still made absolute', () => {
  const served = serve(`
- {#greeting; => *, ./other.rvmark#x}
   - "Hail."
`);
  assert.equal(served.nodeMap['greeting'].attrs.get('transclude'), '*, /games/other.rvmark#x');
});

test('a ^ entry keeps its prefix through the serving path', () => {
  const served = serve(`
- {#greeting; => ^#options}
   - "Hail."
- {#options}
   - [.option] "Nothing."
`);
  assert.equal(served.nodeMap['greeting'].attrs.get('transclude'), '^#options');
});
