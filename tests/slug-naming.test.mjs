// nodeMap slug precedence: a declared {#id} must outrank an auto-numbered
// ordinal that spells the same string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, resolveFile } from '../out/shared/parser.js';
import { resolveSlugInFile } from '../out/shared/shared.js';
import { Multimap } from '../out/shared/multimap.js';

const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);

// Euclid's shape: a node declares {#11}, and unlabelled separators inside a
// LATER subtree fall on auto-ordinal 11. Before the fix the separator won,
// so `#11` transcluded an empty node.
const SRC = `- {#book} Book
  - {#11} Proposition 11
    - {#11-1} To draw a straight-line.
  - {#43} Proposition 43
    - {#43-1} First.
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
    - {= hr}
`;

test('a declared id is not shadowed by a later auto ordinal', () => {
  const { nodeMap } = parse(SRC, 'test.rvmark');
  const n = get(nodeMap, '11');
  assert.ok(n, '#11 must resolve');
  assert.equal(n.attrs.get('id'), '11');
  assert.equal(n.label, 'Proposition 11');
  assert.equal(n.children.length, 1, '#11 must be the proposition, not an empty separator');
});

// A bare ordinal is not a name a node claimed, so it never belonged in nodeMap.
// `#11` means id 11; position is addressed by compound path or the `.`-prefixed
// root form (`#.11`), both resolved by walking `numbering`.
test('ordinal-only nodes do not claim a nodeMap name', () => {
  const { nodeMap } = parse(`- {#a} A
  - one
  - two
`, 'test.rvmark');
  assert.equal(get(nodeMap, '1'), undefined, 'bare ordinal must not be indexed');
  assert.equal(get(nodeMap, '2'), undefined, 'bare ordinal must not be indexed');
  assert.ok(get(nodeMap, 'a'), 'declared ids are still indexed');
});

test('ordinal-only nodes stay reachable by path', () => {
  const file = parse(`- {#a} A
  - one
  - two
`, 'test.rvmark');
  const r = resolveSlugInFile({ nodeMap: file.nodeMap, roots: file.roots }, 'a.2');
  assert.ok(r, 'a.2 should resolve');
  assert.equal(r.node.label, 'two');
});

// parseInt('43-proof') === 43, so a digit-prefixed id used to end the anchor
// before it began and the whole compound slug became one key that matched
// nothing. Only an all-digits segment is a position.
test('a compound path resolves under a digit-prefixed anchor', () => {
  const file = parse(`- {#book} Book
  - {#43-proof} Proof
    - first
    - second
    - third
`, 'test.rvmark');
  const r = resolveSlugInFile({ nodeMap: file.nodeMap, roots: file.roots }, '43-proof.2');
  assert.ok(r, '43-proof.2 should resolve');
  assert.equal(r.node.label, 'second');
});

// resolveFile builds a SECOND nodeMap — the one the runtime resolves refs
// against. Fixing only assignOrdinals left `#11` broken in the browser while
// every build-time check passed, so the runtime map needs its own coverage.
test('resolveFile applies the same naming rule as parse', () => {
  const raw = parse(SRC, 'test.rvmark');
  const emptyHead = { meta: new Multimap(), tagDefs: {}, origins: {} };
  const { nodeMap } = resolveFile(raw, emptyHead);
  const n = get(nodeMap, '11');
  assert.ok(n, '#11 must resolve at runtime');
  assert.equal(n.label, 'Proposition 11');
  assert.equal(n.children.length, 1, 'runtime map must not hand #11 to a separator');
});

test('a declared id wins regardless of document order', () => {
  // Separator ordinals occur BEFORE the declared #3 here.
  const src = `- {#book} Book
  - {#x} X
    - {= hr}
    - {= hr}
    - {= hr}
  - {#3} Proposition 3
    - {#3-1} Body.
`;
  const { nodeMap } = parse(src, 'test.rvmark');
  const n = get(nodeMap, '3');
  assert.equal(n.label, 'Proposition 3');
  assert.equal(n.children.length, 1);
});
