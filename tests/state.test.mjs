import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateFrame, StatePass, buildStatePass } from '../out/client/state.js';
import { parsePass } from '../out/client/handler-utils.js';
import { parseStateEntries, parseShowWhen, parseAttrBlock } from '../out/shared/parser.js';

// ── StateFrame basics ──────────────────────────────────────────────────────────

test('declare and get', () => {
  const f = new StateFrame();
  f.declare('x', 'hello');
  assert.equal(f.get('x'), 'hello');
});

test('get returns undefined for undeclared key', () => {
  const f = new StateFrame();
  assert.equal(f.get('x'), undefined);
});

test('delete makes key undefined', () => {
  const f = new StateFrame();
  f.declare('x', 'hello');
  f.delete('x');
  assert.equal(f.get('x'), undefined);
});

test('child inherits from parent', () => {
  const parent = new StateFrame();
  parent.declare('x', 'hello');
  const child = new StateFrame(parent);
  assert.equal(child.get('x'), 'hello');
});

test('child shadows parent', () => {
  const parent = new StateFrame();
  parent.declare('x', 'parent');
  const child = new StateFrame(parent);
  child.declare('x', 'child');
  assert.equal(child.get('x'), 'child');
  assert.equal(parent.get('x'), 'parent');
});

// ── set ────────────────────────────────────────────────────────────────────────

test('set modifies owning ancestor', () => {
  const parent = new StateFrame();
  parent.declare('x', 'old');
  const child = new StateFrame(parent);
  child.set('x', 'new');
  assert.equal(parent.get('x'), 'new');
  assert.equal(child.get('x'), 'new');
});

test('set declares on self when no owner found', () => {
  const parent = new StateFrame();
  const child = new StateFrame(parent);
  child.set('x', 'value');
  assert.equal(child.get('x'), 'value');
  assert.equal(parent.get('x'), undefined);
});

test('set stops at shadowing frame, not grandparent', () => {
  const grandparent = new StateFrame();
  grandparent.declare('x', 'gp');
  const parent = new StateFrame(grandparent);
  parent.declare('x', 'p');
  const child = new StateFrame(parent);
  child.set('x', 'new');
  assert.equal(parent.get('x'), 'new');
  assert.equal(grandparent.get('x'), 'gp');
});

// ── subscriptions ──────────────────────────────────────────────────────────────

test('declare triggers subscriber', () => {
  const f = new StateFrame();
  let received;
  f.subscribe('x', v => received = v);
  f.declare('x', 'hello');
  assert.equal(received, 'hello');
});

test('set triggers subscriber on owning frame', () => {
  const parent = new StateFrame();
  parent.declare('x', 'old');
  const child = new StateFrame(parent);
  let received;
  child.subscribe('x', v => received = v);
  child.set('x', 'new');
  assert.equal(received, 'new');
});

test('subscriber does not fire when shadowed', () => {
  const parent = new StateFrame();
  parent.declare('x', 'parent');
  const child = new StateFrame(parent);
  child.declare('x', 'child');
  let fired = false;
  child.subscribe('x', () => fired = true);
  // modifying parent's x should not fire child's subscriber
  parent.declare('x', 'new');
  assert.equal(fired, false);
});

test('delete triggers subscriber with undefined', () => {
  const f = new StateFrame();
  f.declare('x', 'hello');
  let received = 'sentinel';
  f.subscribe('x', v => received = v);
  f.delete('x');
  assert.equal(received, undefined);
});

// ── StatePass ──────────────────────────────────────────────────────────────────

test('StatePass blocks read by default', () => {
  const parent = new StateFrame();
  parent.declare('x', 'secret');
  const pass = new StatePass(parent, new Map());
  const child = new StateFrame(pass);
  assert.equal(child.get('x'), undefined);
});

test('StatePass allows read with r permission', () => {
  const parent = new StateFrame();
  parent.declare('x', 'value');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'r' }]]));
  const child = new StateFrame(pass);
  assert.equal(child.get('x'), 'value');
});

test('StatePass blocks write with r permission', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'r' }]]));
  const child = new StateFrame(pass);
  child.set('x', 'modified');
  assert.equal(parent.get('x'), 'original');
  assert.equal(child.get('x'), 'modified'); // declared on child itself
});

test('StatePass allows write with w permission', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'w' }]]));
  const child = new StateFrame(pass);
  child.set('x', 'modified');
  assert.equal(parent.get('x'), 'modified');
});

test('StatePass blocks read with w permission', () => {
  const parent = new StateFrame();
  parent.declare('x', 'secret');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'w' }]]));
  const child = new StateFrame(pass);
  assert.equal(child.get('x'), undefined);
});

test('StatePass allows read and write with rw permission', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'rw' }]]));
  const child = new StateFrame(pass);
  assert.equal(child.get('x'), 'original');
  child.set('x', 'modified');
  assert.equal(parent.get('x'), 'modified');
});

test('-- prefix always passes read-only', () => {
  const parent = new StateFrame();
  parent.declare('--theme', 'dark');
  const pass = new StatePass(parent, new Map()); // no explicit permissions
  const child = new StateFrame(pass);
  assert.equal(child.get('--theme'), 'dark');
});

test('-- prefix cannot be written through StatePass', () => {
  const parent = new StateFrame();
  parent.declare('--theme', 'dark');
  const pass = new StatePass(parent, new Map());
  const child = new StateFrame(pass);
  child.set('--theme', 'light');
  assert.equal(parent.get('--theme'), 'dark');
  assert.equal(child.get('--theme'), 'light'); // declared locally on child, shadows parent
});

// ── StatePass rename ───────────────────────────────────────────────────────────

test('StatePass rename: get translates remote key to local key', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'value');
  const pass = new StatePass(parent, new Map([['remoteX', { parentKey: 'localX', mode: 'r' }]]));
  const child = new StateFrame(pass);
  assert.equal(child.get('remoteX'), 'value');
  assert.equal(child.get('localX'), undefined); // local key not visible under remote name
});

test('StatePass rename: _set translates remote key to local key', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'original');
  const pass = new StatePass(parent, new Map([['remoteX', { parentKey: 'localX', mode: 'rw' }]]));
  const child = new StateFrame(pass);
  child.set('remoteX', 'modified');
  assert.equal(parent.get('localX'), 'modified');
});

// ── parsePass ──────────────────────────────────────────────────────────────────

test('parsePass: bare key defaults to r', () => {
  const entries = parsePass('&foo');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'r' }]);
});

test('parsePass: explicit r suffix', () => {
  const entries = parsePass('&foo r');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'r' }]);
});

test('parsePass: w suffix', () => {
  const entries = parsePass('&foo w');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'w' }]);
});

test('parsePass: rw suffix', () => {
  const entries = parsePass('&foo rw');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'rw' }]);
});

test('parsePass: rename', () => {
  const entries = parsePass('&remote=&local');
  assert.deepEqual(entries, [{ childKey: 'remote', parentKey: 'local', mode: 'r' }]);
});

test('parsePass: rename with mode', () => {
  const entries = parsePass('&remote=&local rw');
  assert.deepEqual(entries, [{ childKey: 'remote', parentKey: 'local', mode: 'rw' }]);
});

test('parsePass: comma-separated entries', () => {
  const entries = parsePass('&foo, &bar w, &baz=&qux rw');
  assert.deepEqual(entries, [
    { childKey: 'foo', parentKey: 'foo', mode: 'r' },
    { childKey: 'bar', parentKey: 'bar', mode: 'w' },
    { childKey: 'baz', parentKey: 'qux', mode: 'rw' },
  ]);
});

test('parsePass: "--" prefixed keys keep their dashes', () => {
  const entries = parsePass('&--dashvar');
  assert.deepEqual(entries, [{ childKey: '--dashvar', parentKey: '--dashvar', mode: 'r' }]);
});

test('parsePass: unprefixed key throws', () => {
  assert.throws(() => parsePass('foo'), /pass key must be &-prefixed/);
});

test('parsePass: unprefixed key on either side of a rename throws', () => {
  assert.throws(() => parsePass('&remote=local'), /pass key must be &-prefixed/);
  assert.throws(() => parsePass('remote=&local'), /pass key must be &-prefixed/);
});

test('parsePass: unrecognised mode throws rather than defaulting to r', () => {
  assert.throws(() => parsePass('&foo x'), /pass mode must be/);
});

test('parsePass: trailing junk throws', () => {
  assert.throws(() => parsePass('&foo rw extra'), /unexpected text after pass mode/);
});

// ── buildStatePass ─────────────────────────────────────────────────────────────

test('buildStatePass: constructs correct permissions from entries', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'hello');
  const pass = buildStatePass(parent, [{ childKey: 'remoteX', parentKey: 'localX', mode: 'r' }]);
  const child = new StateFrame(pass);
  assert.equal(child.get('remoteX'), 'hello');
});

test('buildStatePass: empty entries blocks everything except --', () => {
  const parent = new StateFrame();
  parent.declare('x', 'secret');
  parent.declare('--theme', 'dark');
  const pass = buildStatePass(parent, []);
  const child = new StateFrame(pass);
  assert.equal(child.get('x'), undefined);
  assert.equal(child.get('--theme'), 'dark');
});

// ── subscribeAny ───────────────────────────────────────────────────────────────

test('subscribeAny fires when ancestor key changes', () => {
  const parent = new StateFrame();
  parent.declare('x', 'old');
  const child = new StateFrame(parent);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('x', 'new');
  assert.equal(fired, true);
});

test('subscribeAny fires when own key changes', () => {
  const frame = new StateFrame();
  frame.declare('x', 'old');
  let fired = false;
  frame.subscribeAny(() => { fired = true; });
  frame.declare('x', 'new');
  assert.equal(fired, true);
});

test('subscribeAny does not fire when shadowed key changes', () => {
  const parent = new StateFrame();
  parent.declare('x', 'parent');
  const child = new StateFrame(parent);
  child.declare('x', 'child');
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  // parent's x is shadowed by child's x — child cannot see this change
  parent.declare('x', 'new');
  assert.equal(fired, false);
});

test('subscribeAny does not fire through blocking StatePass', () => {
  const parent = new StateFrame();
  parent.declare('x', 'secret');
  const pass = new StatePass(parent, new Map()); // blocks x
  const child = new StateFrame(pass);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('x', 'new');
  assert.equal(fired, false);
});

test('subscribeAny fires through permitting StatePass', () => {
  const parent = new StateFrame();
  parent.declare('x', 'old');
  const pass = new StatePass(parent, new Map([['x', { parentKey: 'x', mode: 'r' }]]));
  const child = new StateFrame(pass);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('x', 'new');
  assert.equal(fired, true);
});

test('subscribeAny fires through StatePass with rename', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'old');
  const pass = new StatePass(parent, new Map([['remoteX', { parentKey: 'localX', mode: 'r' }]]));
  const child = new StateFrame(pass);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('localX', 'new');
  assert.equal(fired, true);
});

test('subscribeAny does not fire through StatePass when renamed key is blocked', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'old');
  // pass only exposes 'remoteY' → 'localY', not 'localX'
  const pass = new StatePass(parent, new Map([['remoteY', { parentKey: 'localY', mode: 'r' }]]));
  const child = new StateFrame(pass);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('localX', 'new');
  assert.equal(fired, false);
});

test('unsubscribeAny stops firing', () => {
  const frame = new StateFrame();
  frame.declare('x', 'old');
  let count = 0;
  const fn = () => { count++; };
  frame.subscribeAny(fn);
  frame.declare('x', 'new');
  frame.unsubscribeAny(fn);
  frame.declare('x', 'newer');
  assert.equal(count, 1);
});

test('subscribeAny -- prefix fires through empty StatePass', () => {
  const parent = new StateFrame();
  parent.declare('--theme', 'dark');
  const pass = new StatePass(parent, new Map()); // blocks regular keys, not --
  const child = new StateFrame(pass);
  let fired = false;
  child.subscribeAny(() => { fired = true; });
  parent.declare('--theme', 'light');
  assert.equal(fired, true);
});

test('subscribeAny callback receives key and value', () => {
  const frame = new StateFrame();
  frame.declare('x', 'old');
  let receivedKey, receivedVal;
  frame.subscribeAny((k, v) => { receivedKey = k; receivedVal = v; });
  frame.declare('x', 'new');
  assert.equal(receivedKey, 'x');
  assert.equal(receivedVal, 'new');
});

test('subscribeAny callback receives translated key through StatePass rename', () => {
  const parent = new StateFrame();
  parent.declare('localX', 'old');
  const pass = new StatePass(parent, new Map([['remoteX', { parentKey: 'localX', mode: 'r' }]]));
  const child = new StateFrame(pass);
  let receivedKey;
  child.subscribeAny((k) => { receivedKey = k; });
  parent.declare('localX', 'new');
  assert.equal(receivedKey, 'remoteX'); // translated to the name visible in child
});

test('subscribeAny callback receives undefined value on delete', () => {
  const frame = new StateFrame();
  frame.declare('x', 'hello');
  let receivedVal = 'sentinel';
  frame.subscribeAny((_k, v) => { receivedVal = v; });
  frame.delete('x');
  assert.equal(receivedVal, undefined);
});

// ── parseStateEntries ─────────────────────────────────────────────────────────

test('parseStateEntries: let &key → declare with val 1', () => {
  assert.deepEqual(parseStateEntries('let &foo'), [{ key: 'foo', op: 'declare', val: '1' }]);
});

test('parseStateEntries: let &key = "val" → declare', () => {
  assert.deepEqual(parseStateEntries('let &foo = "bar"'), [{ key: 'foo', op: 'declare', val: 'bar' }]);
});

test('parseStateEntries: set &key = "val" → set (mutate upward)', () => {
  assert.deepEqual(parseStateEntries('set &foo = "bar"'), [{ key: 'foo', op: 'set', val: 'bar' }]);
});

test('parseStateEntries: remove &key → delete', () => {
  assert.deepEqual(parseStateEntries('remove &foo'), [{ key: 'foo', op: 'delete' }]);
});

test('parseStateEntries: bare numbers and identifiers need no quotes', () => {
  assert.deepEqual(parseStateEntries('let &n = 42'), [{ key: 'n', op: 'declare', val: '42' }]);
});

test('parseStateEntries: &ref value passes through unquoted', () => {
  assert.deepEqual(parseStateEntries('set &a = &b'), [{ key: 'a', op: 'set', val: '&b' }]);
});

test('parseStateEntries: quoted value may contain the ; separator', () => {
  assert.deepEqual(parseStateEntries('let &msg = "a; b"'), [{ key: 'msg', op: 'declare', val: 'a; b' }]);
});

test('parseStateEntries: escaped quote inside a value', () => {
  assert.deepEqual(parseStateEntries('let &q = "say \\"hi\\""'), [{ key: 'q', op: 'declare', val: 'say "hi"' }]);
});

test('parseStateEntries: explicit empty string blanks a variable', () => {
  assert.deepEqual(parseStateEntries('set &x = ""'), [{ key: 'x', op: 'set', val: '' }]);
});

test('parseStateEntries: semicolon-separated multiple entries', () => {
  assert.deepEqual(parseStateEntries('let &a = 1; set &b = 2; remove &c; let &d'), [
    { key: 'a', op: 'declare', val: '1' },
    { key: 'b', op: 'set',     val: '2' },
    { key: 'c', op: 'delete'            },
    { key: 'd', op: 'declare', val: '1' },
  ]);
});

test('parseStateEntries: a missing keyword is an error, not a silent no-op', () => {
  assert.throws(() => parseStateEntries('&foo = "bar"'), /must start with 'let', 'set', or 'remove'/);
});

test('parseStateEntries: unquoted multi-word value is an error', () => {
  assert.throws(() => parseStateEntries('let &x = some variable'), /must be quoted/);
});

test('parseStateEntries: unterminated string literal is an error', () => {
  assert.throws(() => parseStateEntries('let &x = "oops'), /unterminated string literal/);
});

test('parseStateEntries: set does set on owning ancestor, not declare', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const child = new StateFrame(parent);
  // simulate what applyEventAttr does with op='set'
  for (const e of parseStateEntries('set &x = "mutated"')) {
    if (e.op === 'set')          child.set(e.key, e.val);
    else if (e.op === 'declare') child.declare(e.key, e.val);
    else if (e.op === 'delete')  child.delete(e.key);
  }
  assert.equal(parent.get('x'), 'mutated');
  assert.equal(child.get('x'), 'mutated');
});

test('parseStateEntries: let does declare on own frame, not ancestor', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const child = new StateFrame(parent);
  for (const e of parseStateEntries('let &x = "shadow"')) {
    if (e.op === 'set')          child.set(e.key, e.val);
    else if (e.op === 'declare') child.declare(e.key, e.val);
    else if (e.op === 'delete')  child.delete(e.key);
  }
  assert.equal(child.get('x'), 'shadow');
  assert.equal(parent.get('x'), 'original'); // parent unchanged
});

// ── attr-block keyword sugar ──────────────────────────────────────────────────

// `remove` is the counterpart of `let` — same frame, same event — so it
// defaults to spawn. Only `set` defaults to the node's action.
test('parseAttrBlock: bare let/remove → on-spawn, bare set → on-action', () => {
  assert.deepEqual(parseAttrBlock('let &x = "1"').allEntries(), [['on-spawn', 'let &x = "1"']]);
  assert.deepEqual(parseAttrBlock('set &x = "2"').allEntries(), [['on-action', 'set &x = "2"']]);
  assert.deepEqual(parseAttrBlock('remove &x').allEntries(),     [['on-spawn', 'remove &x']]);
});

// The bare form is only emitted when the keyword's default event matches the
// attr it sits on, so a bare `remove` must come back as on-spawn, and a
// non-default pairing must keep its explicit `key: val` spelling.
test('bare remove round-trips as on-spawn', () => {
  assert.deepEqual(parseAttrBlock('remove &x').allEntries(), [['on-spawn', 'remove &x']]);
  assert.deepEqual(parseAttrBlock('on-action: remove &x').allEntries(), [['on-action', 'remove &x']]);
});

test('parseAttrBlock: explicit event attr keeps the keyword meaning', () => {
  const attrs = parseAttrBlock('on-expand: set &x = "1"');
  assert.deepEqual(attrs.allEntries(), [['on-expand', 'set &x = "1"']]);
  assert.deepEqual(parseStateEntries(attrs.get('on-expand')), [{ key: 'x', op: 'set', val: '1' }]);
});

test('parseAttrBlock: a quoted ; does not split the attr block', () => {
  assert.deepEqual(parseAttrBlock('#one; let &m = "a; b"').allEntries(), [
    ['id', 'one'],
    ['on-spawn', 'let &m = "a; b"'],
  ]);
});

// ── parseShowWhen ─────────────────────────────────────────────────────────────

test('parseShowWhen: truthy, negation, and comparison', () => {
  assert.deepEqual(parseShowWhen('&x'),  [{ key: 'x', op: 'truthy' }]);
  assert.deepEqual(parseShowWhen('!&x'), [{ key: 'x', op: '!truthy' }]);
  assert.deepEqual(parseShowWhen('&x == "1"'), [{ key: 'x', op: '==', val: '1' }]);
  assert.deepEqual(parseShowWhen('&x >= 25'),  [{ key: 'x', op: '>=', val: '25' }]);
});

test('parseShowWhen: quoted comparison value may contain ;', () => {
  assert.deepEqual(parseShowWhen('&x == "a; b"'), [{ key: 'x', op: '==', val: 'a; b' }]);
});

// ── StatePass: keys outside the permission map ────────────────────────────────

test('StatePass blocks a key that is not in the permission map', () => {
  const parent = new StateFrame();
  parent.declare('allowed', 'yes');
  parent.declare('secret', 'no');
  const pass = buildStatePass(parent, parsePass('&allowed'));
  const child = new StateFrame(pass);
  assert.equal(child.get('allowed'), 'yes');
  assert.equal(child.get('secret'), undefined);
});

test('StatePass blocks a write to a key outside the permission map', () => {
  const parent = new StateFrame();
  parent.declare('allowed', 'yes');
  parent.declare('secret', 'original');
  const pass = buildStatePass(parent, parsePass('&allowed rw'));
  const child = new StateFrame(pass);
  child.set('secret', 'hacked');
  assert.equal(parent.get('secret'), 'original');
});

test('StatePass carries several keys with independent modes', () => {
  const parent = new StateFrame();
  parent.declare('a', 'avalue');
  parent.declare('b', 'bvalue');
  const pass = buildStatePass(parent, parsePass('&a, &b w'));
  const child = new StateFrame(pass);
  assert.equal(child.get('a'), 'avalue');
  assert.equal(child.get('b'), undefined);  // w-only: not readable
  child.set('b', 'written');
  assert.equal(parent.get('b'), 'written');
});

test('a child declaring a passed key shadows it without touching the host', () => {
  const parent = new StateFrame();
  parent.declare('x', 'host');
  const pass = buildStatePass(parent, parsePass('&x rw'));
  const child = new StateFrame(pass);
  child.declare('x', 'local');
  assert.equal(child.get('x'), 'local');
  assert.equal(parent.get('x'), 'host');
});

// ── StatePass: prototype-pollution style keys ─────────────────────────────────

test('a prototype key is not readable through a pass that does not grant it', () => {
  const parent = new StateFrame();
  const pass = buildStatePass(parent, parsePass('&safe'));
  const child = new StateFrame(pass);
  assert.equal(child.get('__proto__'), undefined);
  assert.equal(child.get('constructor'), undefined);
  assert.equal(child.get('prototype'), undefined);
});

test('writing a prototype key through a pass does not pollute Object.prototype', () => {
  const parent = new StateFrame();
  const pass = buildStatePass(parent, parsePass('&safe rw'));
  const child = new StateFrame(pass);
  child.set('__proto__', 'polluted');
  child.set('constructor', 'polluted');
  assert.equal({}.polluted, undefined);
  assert.equal(({}).__proto__, Object.prototype);
});
