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
 *   invalidateLoaderCaches(baseUrl)  — drop everything cached for one origin
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
  const source = await res.text();
  // Content-type guard. A missing .rvmark can come back as HTTP 200 when the
  // server rewrites unknown paths to an HTML fallback (SPA catch-all, custom
  // 200 error page). Without this check the HTML would be parse()d as rvmark,
  // yielding a corrupt SourceFile instead of a clean miss — which silently
  // defeats the caller's /index.rvmark fallback (see loadRvmarkFile). Treat an
  // HTML response as not-found so the fallback fires. We check both the
  // declared content-type and the body's leading bytes, because a server may
  // serve .rvmark as application/octet-stream (nginx default) yet still hand
  // back an HTML document for the miss.
  if (looksLikeHtml(res, source)) {
    throw new Error(`expected rvmark source, got HTML (${url})`);
  }
  return { source };
}

// True when the response body is an HTML document rather than rvmark source.
function looksLikeHtml(res: Response, source: string): boolean {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) return true;
  const head = source.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
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

// The head depends only on the index.rvmark chain above a file, not on the file
// itself — so every file in a directory resolves the identical head. Keying by
// address made each one walk and retain its own copy. The chain is fixed by the
// file's directory, plus whether the file IS that directory's index (which is
// skipped in its own chain), so those two are the key.
function inheritedHeadKey(address: string): string {
  const file = addressToFile(address);
  if (!file) return addressOrigin(address) + '|';
  const slash = file.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.slice(0, slash + 1);
  const isOwnIndex = file === dir + 'index.rvmark';
  return addressOrigin(address) + '|' + dir + (isOwnIndex ? '|self' : '');
}

function resolveInheritedHead(address: string): Promise<Head> {
  const key = stripFragment(address);
  const cacheKey = inheritedHeadKey(key);
  if (inheritedHeadCache.has(cacheKey)) return inheritedHeadCache.get(cacheKey)!;

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

  inheritedHeadCache.set(cacheKey, p);
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

// ── Invalidation ──────────────────────────────────────────────────────────────
// Drop everything cached for one baseUrl. The store belongs to the origin now,
// so this is reached only through `Origin.invalidate` (origin.ts) — the loader
// is not something a caller outside gets to poke.
export function invalidateLoaderCaches(baseUrl: string): void {
  for (const cache of [rawCache, sourceFileCache] as Map<string, unknown>[]) {
    for (const key of [...cache.keys()]) if (key.startsWith(baseUrl)) cache.delete(key);
  }
  for (const key of [...inheritedHeadCache.keys()]) {
    if (key.startsWith(baseUrl + '|')) inheritedHeadCache.delete(key);
  }
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
