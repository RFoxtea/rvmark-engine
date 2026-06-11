/**
 * loader.ts
 *
 * File fetching with a per-session cache, and page context for resolving
 * relative paths in cross-file transclusion refs.
 *
 * Operates in canonical-address space (full URLs). The canonical address of a
 * .rvmark file is the URL its raw source is fetched from — same-origin local
 * files use location.origin; remote files use their declared origin.
 *
 * Exports:
 *   setPageContext(file, basePath)  — called once by init() when a page loads
 *   getPageContext()                — used by exhibit.ts to resolve relative paths
 *   loadPageFile(file, basePath)    — load the current page with inherited head
 *   loadRvmarkFile(address)         — resolve a canonical address → SourceFile | null
 */

import { parse, resolveFile } from './parser.js';
import type { RawFile, Head, OriginDef } from './parser.js';
import { Multimap } from './multimap.js';
import { SourceFile } from './source-file.js';
import { addressToFile, addressOrigin, RVMARK_SEGMENT } from './shared.js';

// ── Page context ──────────────────────────────────────────────────────────────

export interface PageContext {
  file:     string;
  basePath: string;
}

let _ctx: PageContext = { file: '', basePath: '' };

export function setPageContext(file: string, basePath: string): void {
  _ctx = { file, basePath };
}

export function getPageContext(): PageContext {
  return _ctx;
}

// ── Source acquisition ────────────────────────────────────────────────────────
// getRvmarkSource is the abstraction step 7 (adapters) extends: today the only
// implementation is plain fetch + text. An adapter-backed implementation will
// post to a Web Worker and return the synthesized rvmark source.

interface RvmarkSourceResult {
  source: string;
}

async function getRvmarkSource(address: string): Promise<RvmarkSourceResult> {
  // address is the canonical full URL of the .rvmark file to fetch.
  const url = addressToFetchUrl(address);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { source: await res.text() };
}

// Compute the URL to fetch given a canonical address. The canonical address
// already encodes the fetch location: '<origin>/_rvmark/<file>'. We strip the
// fragment, and for same-origin addresses we use a relative URL so the dev
// server / production deployment URL doesn't need to be known.
function addressToFetchUrl(address: string): string {
  const hashIdx = address.indexOf('#');
  const noFrag = hashIdx === -1 ? address : address.slice(0, hashIdx);
  const origin = addressOrigin(noFrag);
  if (origin === '' || origin === location.origin) {
    return noFrag.slice(origin.length); // path-only
  }
  return noFrag;
}

// ── Raw file cache (first pass) ───────────────────────────────────────────────
// Keyed by canonical address (no fragment).

const rawCache = new Map<string, Promise<RawFile>>();

function fetchRawFile(address: string): Promise<RawFile> {
  const key = stripFragment(address);
  if (rawCache.has(key)) return rawCache.get(key)!;
  const p = getRvmarkSource(key)
    .then(({ source }) => parse(source))
    .catch(err => { rawCache.delete(key); throw err; });
  rawCache.set(key, p);
  return p;
}

function stripFragment(address: string): string {
  const i = address.indexOf('#');
  return i === -1 ? address : address.slice(0, i);
}

// ── Inherited head resolution ─────────────────────────────────────────────────
// Walks the index.rvmark chain within the file's own origin.

const inheritedHeadCache = new Map<string, Promise<Head>>();

function resolveInheritedHead(address: string): Promise<Head> {
  const key = stripFragment(address);
  if (inheritedHeadCache.has(key)) return inheritedHeadCache.get(key)!;

  const p = (async (): Promise<Head> => {
    const origin = addressOrigin(key);
    const file = addressToFile(key);
    if (!file) return { meta: new Multimap(), tagDefs: {}, origins: {} };

    const parts = file.split('/');
    const chain: string[] = ['index.rvmark'];
    for (let i = 0; i < parts.length - 1; i++) {
      chain.push(parts.slice(0, i + 1).join('/') + '/index.rvmark');
    }

    const mergedMeta = new Multimap();
    const mergedTagDefs: Record<string, Multimap> = {};
    const mergedOrigins: Record<string, OriginDef> = {};
    for (const indexFile of chain) {
      if (indexFile === file) continue;
      const indexAddress = origin + RVMARK_SEGMENT + indexFile;
      try {
        const raw = await fetchRawFile(indexAddress);
        for (const [k, v] of raw.head.meta.allEntries()) mergedMeta.append(k, v);
        Object.assign(mergedTagDefs, raw.head.tagDefs);
        Object.assign(mergedOrigins, raw.head.origins);
      } catch (_) { /* missing index — fine */ }
    }
    return { meta: mergedMeta, tagDefs: mergedTagDefs, origins: mergedOrigins };
  })();

  inheritedHeadCache.set(key, p);
  return p;
}

// ── SourceFile cache ─────────────────────────────────────────────────────────
// Keyed by canonical address (no fragment).

const sourceFileCache = new Map<string, Promise<SourceFile>>();

function loadResolvedFile(address: string): Promise<SourceFile> {
  const key = stripFragment(address);
  if (sourceFileCache.has(key)) return sourceFileCache.get(key)!;

  const p = (async (): Promise<SourceFile> => {
    const [raw, inheritedHead] = await Promise.all([
      fetchRawFile(key),
      resolveInheritedHead(key),
    ]);
    const resolved = resolveFile(raw, inheritedHead);
    const file = addressToFile(key) ?? '';
    return new SourceFile(resolved.nodeMap, resolved.roots, resolved.head, file, key);
  })();

  sourceFileCache.set(key, p);
  p.catch(() => sourceFileCache.delete(key));
  return p;
}

// ── loadPageFile ──────────────────────────────────────────────────────────────
// Load the current page's primary file. Called by main.ts on init.
export function loadPageFile(file: string, basePath: string): Promise<SourceFile> {
  // basePath is preserved for backward compatibility with main.ts's signature,
  // but the canonical address is built from location.origin directly.
  void basePath;
  const address = location.origin + RVMARK_SEGMENT + file;
  return loadResolvedFile(address);
}

// ── loadRvmarkFile ────────────────────────────────────────────────────────────
// Resolve a canonical address → SourceFile. Tries <file>/index.rvmark fallback.
export async function loadRvmarkFile(address: string): Promise<SourceFile | null> {
  const key = stripFragment(address);
  const file = addressToFile(key);
  if (!file) return null;

  try {
    return await loadResolvedFile(key);
  } catch (_) {
    const origin = addressOrigin(key);
    const fallbackFile = file.replace(/\.rvmark$/, '') + '/index.rvmark';
    const fallbackAddress = origin + RVMARK_SEGMENT + fallbackFile;
    try {
      return await loadResolvedFile(fallbackAddress);
    } catch (_2) { return null; }
  }
}
