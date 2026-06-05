import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateFrame, StatePass, buildStatePass } from '../out/state.js';
import { parsePass } from '../out/handler-utils.js';
import { parseOnSpawn } from '../out/parser.js';

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
  const entries = parsePass('foo');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'r' }]);
});

test('parsePass: w suffix', () => {
  const entries = parsePass('foo w');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'w' }]);
});

test('parsePass: rw suffix', () => {
  const entries = parsePass('foo rw');
  assert.deepEqual(entries, [{ childKey: 'foo', parentKey: 'foo', mode: 'rw' }]);
});

test('parsePass: rename', () => {
  const entries = parsePass('remote=local');
  assert.deepEqual(entries, [{ childKey: 'remote', parentKey: 'local', mode: 'r' }]);
});

test('parsePass: rename with mode', () => {
  const entries = parsePass('remote=local rw');
  assert.deepEqual(entries, [{ childKey: 'remote', parentKey: 'local', mode: 'rw' }]);
});

test('parsePass: comma-separated entries', () => {
  const entries = parsePass('foo, bar w, baz=qux rw');
  assert.deepEqual(entries, [
    { childKey: 'foo', parentKey: 'foo', mode: 'r' },
    { childKey: 'bar', parentKey: 'bar', mode: 'w' },
    { childKey: 'baz', parentKey: 'qux', mode: 'rw' },
  ]);
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

// ── parseOnSpawn ───────────────────────────────────────────────────────────────

test('parseOnSpawn: bare key → declare with val 1', () => {
  const entries = parseOnSpawn('&foo');
  assert.deepEqual(entries, [{ key: 'foo', op: 'declare', val: '1' }]);
});

test('parseOnSpawn: key=val → declare', () => {
  const entries = parseOnSpawn('&foo=bar');
  assert.deepEqual(entries, [{ key: 'foo', op: 'declare', val: 'bar' }]);
});

test('parseOnSpawn: key<<val → set (mutate upward)', () => {
  const entries = parseOnSpawn('&foo<<bar');
  assert.deepEqual(entries, [{ key: 'foo', op: 'set', val: 'bar' }]);
});

test('parseOnSpawn: !key → delete', () => {
  const entries = parseOnSpawn('!&foo');
  assert.deepEqual(entries, [{ key: 'foo', op: 'delete' }]);
});

test('parseOnSpawn: semicolon-separated multiple entries', () => {
  const entries = parseOnSpawn('&a=1; &b<<2; !&c; &d');
  assert.deepEqual(entries, [
    { key: 'a', op: 'declare', val: '1' },
    { key: 'b', op: 'set',     val: '2' },
    { key: 'c', op: 'delete'             },
    { key: 'd', op: 'declare', val: '1' },
  ]);
});

test('parseOnSpawn: << does set on owning ancestor, not declare', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const child = new StateFrame(parent);
  // simulate what applyEventAttr does with op='set'
  const entries = parseOnSpawn('&x<<mutated');
  for (const e of entries) {
    if (e.op === 'set')     child.set(e.key, e.val);
    else if (e.op === 'declare') child.declare(e.key, e.val);
    else if (e.op === 'delete')  child.delete(e.key);
  }
  assert.equal(parent.get('x'), 'mutated');
  assert.equal(child.get('x'), 'mutated');
});

test('parseOnSpawn: = does declare on own frame, not ancestor', () => {
  const parent = new StateFrame();
  parent.declare('x', 'original');
  const child = new StateFrame(parent);
  const entries = parseOnSpawn('&x=shadow');
  for (const e of entries) {
    if (e.op === 'set')      child.set(e.key, e.val);
    else if (e.op === 'declare') child.declare(e.key, e.val);
    else if (e.op === 'delete')  child.delete(e.key);
  }
  assert.equal(child.get('x'), 'shadow');
  assert.equal(parent.get('x'), 'original'); // parent unchanged
});
