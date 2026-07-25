/**
 * multimap.ts
 *
 * Ordered multimap with web-platform-style API (URLSearchParams / Headers / FormData).
 * Used for all rvmark attribute collections: node attrs, tag defs, tag props,
 * inline span attrs, document meta.
 *
 * Repeated declarations of the same key are preserved in insertion order.
 * `.get(k)` returns the last value (the common case); `.getAll(k)` returns every
 * value. Consumers that need every value (e.g. `on-*` handler chains) must use
 * `.getAll()` explicitly — no silent merging or discarding.
 */

export class Multimap {
  private _entries: Array<[string, string]> = [];

  constructor(init?: Iterable<[string, string]>) {
    if (init) for (const [k, v] of init) this._entries.push([k, v]);
  }

  /**
   * Build a Multimap from a plain object, for the common builder case where an
   * object literal is more ergonomic than a list of pairs. An array value emits
   * one entry per element (in order), so repeated keys — e.g. two `on-select`
   * handlers — are expressible: `{ 'on-select': ['&a<<', '&b<<'] }`. Non-string
   * scalars are String()-coerced; null/undefined values are skipped.
   */
  static from(obj: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>): Multimap {
    const m = new Multimap();
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const el of v) { if (el != null) m.append(k, String(el)); }
      else m.append(k, String(v));
    }
    return m;
  }

  get(key: string): string | undefined {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      if (this._entries[i][0] === key) return this._entries[i][1];
    }
    return undefined;
  }

  getAll(key: string): string[] {
    const out: string[] = [];
    for (const [k, v] of this._entries) if (k === key) out.push(v);
    return out;
  }

  has(key: string): boolean {
    for (const [k] of this._entries) if (k === key) return true;
    return false;
  }

  set(key: string, value: string): void {
    this.delete(key);
    this._entries.push([key, value]);
  }

  append(key: string, value: string): void {
    this._entries.push([key, value]);
  }

  delete(key: string): void {
    this._entries = this._entries.filter(([k]) => k !== key);
  }

  keys(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [k] of this._entries) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }

  allEntries(): Array<[string, string]> {
    return this._entries.slice();
  }

  get size(): number {
    return this._entries.length;
  }

  clone(): Multimap {
    return new Multimap(this._entries);
  }
}
