/**
 * frontmatter.ts
 *
 * The file head's metadata: a YAML block between `---` lines, first thing in
 * the file. Replaces the edition-1 `{key: value; …}` meta block, which parse()
 * still reads.
 *
 * YAML is parsed in full but read narrowly. Every scalar is a string (failsafe
 * schema), with one exception: an unquoted `true` is a bare flag (value '') and
 * an unquoted `false` leaves the key out. Non-scalar values are other tools'
 * business — they stay in the text and never reach `meta`.
 *
 * Exports:
 *   EDITION                    → the language edition this engine reads and writes
 *   splitFrontmatter(lines)    → the block's YAML text and the line after it
 *   readFrontmatter(yaml)      → FileMeta
 *   writeFrontmatter(meta, raw?) → YAML text, edited in place when `raw` is given
 */

import { parseDocument, isMap, isScalar, Scalar, Document, YAMLMap } from 'yaml';
import { Multimap } from './multimap.js';

export const EDITION = 2;
export const EDITION_KEY = 'rvmark';

const OPEN_RE  = /^---[ \t]*$/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

export function splitFrontmatter(lines: readonly string[]): { yaml: string; next: number } | null {
  if (!lines.length || !OPEN_RE.test(lines[0].replace(/^﻿/, ''))) return null;
  for (let j = 1; j < lines.length; j++) {
    if (CLOSE_RE.test(lines[j])) return { yaml: lines.slice(1, j).join('\n'), next: j + 1 };
  }
  throw new Error(`rvmark: frontmatter opened with '---' is never closed`);
}

function parseYaml(yaml: string): Document {
  const doc = parseDocument(yaml, { schema: 'failsafe' });
  if (doc.errors.length) throw new Error(`rvmark: frontmatter: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error(`rvmark: frontmatter must be a list of 'key: value' lines`);
  }
  return doc;
}

function scalarEntries(doc: Document): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!isMap(doc.contents)) return out;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const key = String(pair.key.value);
    const v = pair.value;
    if (v === null) { out.push([key, '']); continue; }
    if (!isScalar(v)) continue;
    const text = String(v.value ?? '');
    if (v.type === Scalar.PLAIN) {
      if (text === 'true')  { out.push([key, '']); continue; }
      if (text === 'false') continue;
    }
    const block = v.type === Scalar.BLOCK_FOLDED || v.type === Scalar.BLOCK_LITERAL;
    out.push([key, block ? text.replace(/\n+$/, '') : text]);
  }
  return out;
}

export function readFrontmatter(yaml: string): Multimap {
  const meta = new Multimap(scalarEntries(parseYaml(yaml)));
  const edition = meta.get(EDITION_KEY);
  if (edition !== undefined) {
    if (!/^\d+$/.test(edition)) {
      throw new Error(`rvmark: frontmatter '${EDITION_KEY}' must be a whole number, got '${edition}'`);
    }
    if (Number(edition) > EDITION) {
      throw new Error(`rvmark: this file is edition ${edition}; this engine reads up to edition ${EDITION}`);
    }
  }
  return meta;
}

function scalarFor(val: string): Scalar {
  if (val === '') return new Scalar('true');
  const s = new Scalar(val);
  if (val === 'true' || val === 'false') s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

export function writeFrontmatter(meta: Multimap, raw?: string): string {
  const doc = raw !== undefined ? parseYaml(raw) : new Document(new YAMLMap(), { schema: 'failsafe' });
  if (!isMap(doc.contents)) doc.contents = new YAMLMap();
  const map = doc.contents as YAMLMap;

  const before = new Map(scalarEntries(doc));
  let dirty = false;
  for (const key of before.keys()) if (!meta.has(key)) { map.delete(key); dirty = true; }
  for (const key of meta.keys()) {
    const val = meta.get(key)!;
    if (before.get(key) !== val) { map.set(new Scalar(key), scalarFor(val)); dirty = true; }
  }
  if (!dirty && raw !== undefined) return raw;
  return map.items.length ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n$/, '') : '';
}
