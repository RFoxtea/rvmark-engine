// rvmark state tree
//
// State is organised as a tree of StateFrame instances mirroring the node
// tree. Each frame is owned by the node that created it and holds a reference
// to its parent. Reads walk up the parent chain — a node sees its own
// declarations plus everything declared by its ancestors, but nothing from
// siblings or unrelated subtrees.
//
// StatePass instances sit between frames at file/trust boundaries. They gate
// which keys can be read or written across the boundary. Variables with a
// "--" prefix always pass through read-only regardless of the pass config.
//
// The preroot frame sits above all page frames; main.ts seeds it from URLSearchParams.

const DELETED = Symbol('deleted');
type FrameValue = string | typeof DELETED;

// ── Subscriptions ─────────────────────────────────────────────────────────────
// Each subscription is tied to a key and a subscriber frame. When a key is
// set in an owning frame, each subscriber walks up its own parent chain: if it
// reaches the owning frame before any closer frame that also owns the key, the
// change is visible and the callback fires. Otherwise it skips.
//
// Any-subscriptions (subscribeAny) fire on the subscriber frame whenever any
// visible key changes, using the same visibility walk but without key matching.

interface Subscription {
  frame: StateFrame;
  fn:    (val: string | undefined) => void;
}

const subscribers = new Map<string, Set<Subscription>>();
const anySubscribers = new Set<{ frame: StateFrame; fn: (key: string, value: string | undefined) => void }>();

function notify(key: string, owningFrame: StateFrame): void {
  const subs = subscribers.get(key);
  if (subs) {
    for (const sub of subs) {
      let f: StateNode | null = sub.frame;
      while (f) {
        if (f instanceof StateFrame) {
          if (f === owningFrame) { sub.fn(sub.frame.get(key)); break; }
          if (f.owns(key))       { break; }
        }
        f = f.parent;
      }
    }
  }
  for (const sub of anySubscribers) {
    // Walk upward from subscriber toward owningFrame. At each StatePass we
    // translate from the local key (parent side) to the remote key (child side)
    // and check readability. k starts as the mutated key in owningFrame and
    // gets translated at each boundary as we descend conceptually — but since
    // we walk upward from subscriber, we need to find what local key in the
    // parent corresponds to what the subscriber sees.
    // Strategy: walk upward collecting the chain, then check top-down.
    const chain: StateNode[] = [];
    let f: StateNode | null = sub.frame;
    let found = false;
    while (f) {
      chain.push(f);
      if (f === owningFrame) { found = true; break; }
      f = f.parent;
    }
    if (!found) continue;

    // Walk the chain top-down (owningFrame → subscriber), translating the key
    // through each StatePass boundary.
    let k = key;
    let blocked = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      if (node instanceof StatePass) {
        const childKey = node.childKeyFor(k);
        if (childKey === undefined) { blocked = true; break; }
        k = childKey;
      } else if (node instanceof StateFrame && node !== owningFrame) {
        if (node.owns(k)) { blocked = true; break; } // shadowed
      }
    }
    if (!blocked) sub.fn(k, sub.frame.get(k));
  }
}

// ── StateNode ─────────────────────────────────────────────────────────────────
// Common interface for StateFrame, StatePass, and StateRelay.

export interface StateNode {
  readonly parent: StateNode | null;
  get(key: string): string | undefined;
  _set(key: string, value: string): boolean;
  subscribe(key: string, fn: (val: string | undefined) => void): void;
  unsubscribe(key: string, fn: (val: string | undefined) => void): void;
}

// ── StatePass ─────────────────────────────────────────────────────────────────
// Sits between two StateFrames at a file/trust boundary. Gates reads and writes
// by key. "--" prefix variables always pass through read-only.

export type PassMode = 'r' | 'w' | 'rw';

export interface PassPermission {
  parentKey: string;
  mode:      PassMode;
}

export class StatePass implements StateNode {
  private readonly _permissions: Map<string, PassPermission>;
  readonly parent: StateNode | null;

  constructor(parent: StateNode | null, permissions: Map<string, PassPermission>) {
    this.parent = parent;
    this._permissions = permissions;
  }

  canRead(childKey: string): boolean {
    if (childKey.startsWith('--')) return true;
    const perm = this._permissions.get(childKey);
    return perm?.mode === 'r' || perm?.mode === 'rw';
  }

  parentKeyFor(childKey: string): string | undefined {
    return this._permissions.get(childKey)?.parentKey;
  }

  childKeyFor(parentKey: string): string | undefined {
    if (parentKey.startsWith('--')) return parentKey;
    for (const [child, perm] of this._permissions) {
      if (perm.parentKey === parentKey && (perm.mode === 'r' || perm.mode === 'rw')) return child;
    }
    return undefined;
  }

  _canWrite(childKey: string): boolean {
    if (childKey.startsWith('--')) return false;
    const perm = this._permissions.get(childKey);
    return perm?.mode === 'w' || perm?.mode === 'rw';
  }

  get(childKey: string): string | undefined {
    if (!this.canRead(childKey)) return undefined;
    const parentKey = this._permissions.get(childKey)?.parentKey ?? childKey;
    return this.parent?.get(parentKey);
  }

  _set(childKey: string, value: string): boolean {
    if (!this._canWrite(childKey)) return false;
    const parentKey = this._permissions.get(childKey)?.parentKey ?? childKey;
    return this.parent?._set(parentKey, value) ?? false;
  }

  private _wrappedSubs = new Map<(val: string | undefined) => void, (val: string | undefined) => void>();

  subscribe(childKey: string, fn: (val: string | undefined) => void): void {
    if (!this.canRead(childKey)) return;
    const parentKey = this._permissions.get(childKey)?.parentKey ?? childKey;
    let frame: StateNode | null = this.parent;
    while (frame && !(frame instanceof StateFrame)) frame = frame.parent;
    if (!frame) return;
    const wrapped = () => fn(this.get(childKey));
    this._wrappedSubs.set(fn, wrapped);
    frame.subscribe(parentKey, wrapped);
  }

  unsubscribe(childKey: string, fn: (val: string | undefined) => void): void {
    const wrapped = this._wrappedSubs.get(fn);
    if (!wrapped) return;
    this._wrappedSubs.delete(fn);
    const parentKey = this._permissions.get(childKey)?.parentKey ?? childKey;
    let frame: StateNode | null = this.parent;
    while (frame && !(frame instanceof StateFrame)) frame = frame.parent;
    frame?.unsubscribe(parentKey, wrapped);
  }
}

// ── StateFrame ────────────────────────────────────────────────────────────────

export class StateFrame implements StateNode {
  private readonly _data: Record<string, FrameValue> = Object.create(null);
  parent: StateNode | null;

  constructor(parent: StateNode | null = null) {
    this.parent = parent;
  }

  owns(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._data, key);
  }

  get(key: string): string | undefined {
    if (this.owns(key)) {
      const v = this._data[key];
      return v === DELETED ? undefined : v as string;
    }
    return this.parent?.get(key);
  }

  _set(key: string, value: string): boolean {
    if (this.owns(key)) {
      this._data[key] = value;
      notify(key, this);
      return true;
    }
    return this.parent?._set(key, value) ?? false;
  }

  set(key: string, value: string): void {
    if (!this._set(key, value)) this.declare(key, value);
  }

  declare(key: string, value: string): void {
    this._data[key] = value;
    notify(key, this);
  }

  delete(key: string): void {
    this._data[key] = DELETED;
    notify(key, this);
  }

  subscribe(key: string, fn: (val: string | undefined) => void): void {
    let subs = subscribers.get(key);
    if (!subs) { subs = new Set(); subscribers.set(key, subs); }
    subs.add({ frame: this, fn });
  }

  unsubscribe(key: string, fn: (val: string | undefined) => void): void {
    const subs = subscribers.get(key);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.fn === fn) { subs.delete(sub); break; }
    }
  }

  subscribeAny(fn: (key: string, value: string | undefined) => void): void {
    anySubscribers.add({ frame: this, fn });
  }

  unsubscribeAny(fn: (key: string, value: string | undefined) => void): void {
    for (const sub of anySubscribers) {
      if (sub.fn === fn) { anySubscribers.delete(sub); break; }
    }
  }

  flatten(): Record<string, string> {
    const keys = new Set<string>();
    let node: StateNode | null = this;
    while (node) {
      if (node instanceof StateFrame) {
        for (const k of Object.keys(node._data)) keys.add(k);
      }
      node = node.parent;
    }
    const out: Record<string, string> = Object.create(null);
    for (const k of keys) {
      const v = this.get(k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  serialize(): string {
    return new URLSearchParams(this.flatten()).toString();
  }
}

// ── buildStatePass ────────────────────────────────────────────────────────────

export interface PassEntry {
  childKey:  string;
  parentKey: string;
  mode:      PassMode;
}

export function buildStatePass(parent: StateNode | null, entries: PassEntry[]): StatePass {
  const permissions = new Map<string, PassPermission>();
  for (const e of entries) permissions.set(e.childKey, { parentKey: e.parentKey, mode: e.mode });
  return new StatePass(parent, permissions);
}

// ── StateRelay ────────────────────────────────────────────────────────────────
// Host-side avatar for a guest's preroot. A transparent view onto a host
// StateNode — delegates all StateNode operations straight through.
// snapshot() flattens the visible host state for sending to the guest.
// applyWrite() forwards guest write-backs into the host tree.

export class StateRelay implements StateNode {
  readonly parent: StatePass;

  constructor(hostNode: StatePass) {
    this.parent = hostNode;
  }

  get(key: string): string | undefined {
    return this.parent?.get(key);
  }

  _set(key: string, value: string): boolean {
    return this.parent?._set(key, value) ?? false;
  }

  subscribe(key: string, fn: (val: string | undefined) => void): void {
    this.parent?.subscribe(key, fn);
  }

  unsubscribe(key: string, fn: (val: string | undefined) => void): void {
    this.parent?.unsubscribe(key, fn);
  }

  snapshot(): Record<string, string> {
    const parentKeys = new Set<string>();
    let node: StateNode | null = this.parent.parent;
    while (node) {
      if (node instanceof StateFrame) {
        for (const k of Object.keys((node as any)._data)) parentKeys.add(k);
      }
      node = node.parent;
    }
    const out: Record<string, string> = Object.create(null);
    for (const parentKey of parentKeys) {
      const childKey = this.parent.childKeyFor(parentKey);
      if (childKey === undefined) continue;
      const v = this.parent.get(childKey);
      if (v !== undefined) out[childKey] = v;
    }
    return out;
  }

  applyWrite(op: 'declare' | 'set' | 'delete', key: string, value?: string): void {
    if (op === 'delete') {
      // StatePass._set can't delete; walk to the nearest StateFrame via the pass's translated key
      const parentKey = this.parent.parentKeyFor(key);
      if (!this.parent._canWrite(key) || parentKey === undefined) return;
      let node: StateNode | null = this.parent.parent;
      while (node && !(node instanceof StateFrame)) node = node.parent;
      if (node instanceof StateFrame) node.delete(parentKey);
    } else {
      if (value === undefined) return;
      this.parent._set(key, value);
    }
  }

  listenWriteBack(iframeWindow: Window): () => void {
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeWindow) return;
      if (e.data?.type !== 'rvmark-state-write') return;
      this.applyWrite(e.data.op, e.data.key, e.data.value);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
}

// ── PrerootFrame ──────────────────────────────────────────────────────────────
// The topmost frame. In guest mode, gains a relay channel so that mutations
// are forwarded to the host via postMessage.

export class PrerootFrame extends StateFrame {
  private _relay: ((op: 'declare' | 'set' | 'delete', key: string, value?: string) => void) | null = null;
  private _relayCache: Record<string, string | typeof DELETED> = Object.create(null);

  enableRelay(fn: (op: 'declare' | 'set' | 'delete', key: string, value?: string) => void): void {
    this._relay = fn;
  }

  // Called for host-pushed values. Stores in relay cache (invisible to _set walk)
  // and fires notify so subscribers update.
  applyFromHost(key: string, value: string | undefined): void {
    this._relayCache[key] = value === undefined ? DELETED : value;
    notify(key, this);
  }

  override get(key: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this._relayCache, key)) {
      const v = this._relayCache[key];
      return v === DELETED ? undefined : v as string;
    }
    return super.get(key);
  }

  override _set(key: string, value: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this._relayCache, key)) {
      // Key lives on host — relay the write, update cache optimistically.
      this._relayCache[key] = value;
      notify(key, this);
      this._relay?.('set', key, value);
      return true;
    }
    const result = super._set(key, value);
    if (result) this._relay?.('set', key, value);
    return result;
  }

  override set(key: string, value: string): void {
    if (!this._set(key, value)) super.declare(key, value);
  }

  override delete(key: string): void {
    if (Object.prototype.hasOwnProperty.call(this._relayCache, key)) {
      this._relayCache[key] = DELETED;
      notify(key, this);
      this._relay?.('delete', key);
      return;
    }
    super.delete(key);
    this._relay?.('delete', key);
  }

}

export const prerootFrame = new PrerootFrame(null);
