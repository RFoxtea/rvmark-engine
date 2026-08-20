/**
 * shared.ts
 *
 * Pure utility functions shared between build.mjs (Node) and main.js / renderer.js (browser).
 * No DOM, no imports, no side effects.
 */

import type { SourceNode } from './parser.js';

// Reserved engine namespace: content source/media is published under this
// underscore-prefixed segment so it can never collide with user content paths.
// Build output mirrors this: _rvmark/ (content), _assets/ (CSS), _engine/ (JS),
// _vendor/ (third-party libs). See build-rvmark.mjs.
export const RVMARK_SEGMENT = '/_rvmark/';

/**
 * The boot context a built page hands the engine, stamped inline as
 * window.__RVMARK_PAGE__ by the builder (see template.html), read by main.ts
 * init and shell.ts's mount-path lookup.
 *
 *   file - the page's source, relative to the content root ('docs/writing.rvmark')
 *   base - the prefix from this output page up to the site root ('../../'),
 *          relative rather than root-absolute so links also work over file://
 *
 * anchor and focus are optional: a directly-loaded page reads its fragment from
 * location instead.
 */
export interface RvmarkPageContext {
  file:    string;
  base:    string;
  anchor?: string | null;
  focus?:  string | null;
}

// ── Address resolution ─────────────────────────────────────────────────────────
//
// Runtime canonical address form: <origin>/_rvmark/<file>#<slug>
//   - origin: 'https://host' (or 'http://host') — always present at runtime.
//     For same-origin local files, runtime prepends location.origin in loadPageFile.
//   - /_rvmark/: literal path segment where every federated site publishes raw files.
//   - file:    relative path within the origin's rvmark tree, e.g. 'docs.rvmark'
//              or 'logic/nd.rvmark', or an asset path like 'images/photo.jpg'.
//   - #slug:   optional fragment.
//
// Examples:
//   'https://thissite.com/_rvmark/docs.rvmark#intro'
//   'https://alice.example/_rvmark/docs.rvmark#intro'
//   'https://thissite.com/_rvmark/images/photo.jpg'
//
// sourceFileAddress is a canonical address (the file that owns the ref).
// Its origin determines what local-relative refs resolve against.
//
// Build-time addresses (path-only, no origin) are handled by separate logic in
// build-rvmark.mjs — these helpers assume full URLs.
//
// resolveAddress       — for transclusion refs pointing at rvmark nodes
// resolveMediaAddress  — for asset refs (images, markdown files, html files)
// addressToHref        — convert canonical address to navigable href for <a href>
// addressOrigin        — extract origin ('https://host') from a canonical address

/**
 * Extract the origin ('https://host', no trailing slash) from a canonical address.
 * Returns '' for path-only addresses (build-time form).
 */
export function addressOrigin(address: string): string {
  const schemeEnd = address.indexOf('://');
  if (schemeEnd === -1) return '';
  const pathStart = address.indexOf('/', schemeEnd + 3);
  return pathStart === -1 ? address : address.slice(0, pathStart);
}

function resolveLocalPath(ref: string, sourceFileAddress: string): string {
  const origin = addressOrigin(sourceFileAddress);
  const localPart = sourceFileAddress.slice(origin.length); // starts with '/'

  if (ref.startsWith('/')) return origin + RVMARK_SEGMENT + ref.slice(1);
  if (ref.startsWith('./') || ref.startsWith('../')) {
    const dir = localPart.replace(/[^/]*$/, '');
    const parts = (dir + ref).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return origin + out.join('/');
  }
  // Bare path — relative to sourceFileAddress's directory
  const dir = localPart.replace(/[^/]*$/, '');
  return origin + dir + ref;
}

/**
 * Resolve a transclusion ref string to a canonical address.
 * sourceFileAddress is the canonical address of the file that owns the ref.
 */
export function resolveAddress(ref: string, sourceFileAddress: string): string | null {
  if (!ref) return null;
  if (ref.startsWith('https://') || ref.startsWith('http://')) return ref;

  const hashIdx = ref.indexOf('#');
  const pathPart = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : ref.slice(hashIdx); // includes '#'

  if (ref.startsWith('#')) {
    // Same-file anchor — strip any existing fragment, add the new one
    const baseHashIdx = sourceFileAddress.indexOf('#');
    const base = baseHashIdx === -1 ? sourceFileAddress : sourceFileAddress.slice(0, baseHashIdx);
    return base + fragment;
  }

  let resolved = resolveLocalPath(pathPart, sourceFileAddress);
  // A trailing slash names a directory, so it takes that directory's index
  // rather than a file called '.rvmark'. Same rule buildSigilAddress applies
  // (origin.ts); without it the '.rvmark' request 404s and only the
  // <file>/index.rvmark fallback in loadRvmarkFile makes the ref work.
  if (resolved.endsWith('/')) resolved += 'index.rvmark';
  else if (!resolved.endsWith('.rvmark')) resolved += '.rvmark';
  return resolved + fragment;
}

/**
 * Resolve a media/asset ref string to a canonical address.
 * sourceFileAddress is the canonical address of the file that owns the ref.
 */
export function resolveMediaAddress(ref: string, sourceFileAddress: string): string | null {
  if (!ref) return null;
  if (ref.startsWith('https://') || ref.startsWith('http://')) return ref;
  return resolveLocalPath(ref, sourceFileAddress);
}

/**
 * Convert a canonical address to a navigable href for <a href>.
 * Strips '/_rvmark/', strips '.rvmark', maps 'index' to '', preserves origin.
 *   'https://thissite.com/_rvmark/docs.rvmark#x'  → 'https://thissite.com/docs#x'
 *   'https://alice.com/_rvmark/docs.rvmark#x'    → 'https://alice.com/docs#x'
 *   'https://thissite.com/_rvmark/images/p.jpg'  → 'https://thissite.com/_rvmark/images/p.jpg'
 */
export function addressToHref(address: string): string {
  const origin = addressOrigin(address);
  const localPart = address.slice(origin.length);
  if (!localPart.startsWith(RVMARK_SEGMENT)) return address;

  const without = localPart.slice(RVMARK_SEGMENT.length);
  const hashIdx = without.indexOf('#');
  const filePart = hashIdx === -1 ? without : without.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : without.slice(hashIdx);

  // Non-rvmark assets are served under /_rvmark/ as-is
  if (!filePart.endsWith('.rvmark')) return origin + RVMARK_SEGMENT + filePart + fragment;
  return origin + '/' + fileToUrlStem(filePart) + fragment;
}

/**
 * Extract the .rvmark file path (relative to the origin's rvmark tree) from a
 * canonical address. Returns null if the address doesn't point under /_rvmark/.
 */
export function addressToFile(address: string): string | null {
  const origin = addressOrigin(address);
  const localPart = address.slice(origin.length);
  if (!localPart.startsWith(RVMARK_SEGMENT)) return null;
  const without = localPart.slice(RVMARK_SEGMENT.length);
  const hashIdx = without.indexOf('#');
  return hashIdx === -1 ? without : without.slice(0, hashIdx);
}

/**
 * Extract the slug fragment from a canonical address.
 */
export function addressToSlug(address: string): string | null {
  const hashIdx = address.indexOf('#');
  return hashIdx === -1 ? null : address.slice(hashIdx + 1) || null;
}

/**
 * Convert a relative rvmark file path to its URL stem.
 *   'index.rvmark'        → ''
 *   'docs.rvmark'         → 'docs'
 *   'logic/nd.rvmark'     → 'logic/nd'
 *   'logic/index.rvmark'  → 'logic'
 */
export function fileToUrlStem(relPath: string): string {
  let stem = relPath.replace(/\.rvmark$/, '');
  if (stem === 'index') return '';
  if (stem.endsWith('/index')) stem = stem.slice(0, -'/index'.length);
  return stem;
}

/**
 * Compute a relative URL from one URL stem to another.
 *   relativeUrl('a/b', 'a/c') → '../c/'
 *   relativeUrl('a',   'a')   → './'
 */
export function relativeUrl(fromStem: string, toStem: string): string {
  if (fromStem === toStem) return './';
  const fromParts = fromStem ? fromStem.split('/') : [];
  const toParts   = toStem   ? toStem.split('/')   : [];
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const ups   = fromParts.length - common;
  const downs = toParts.slice(common);
  let rel = '../'.repeat(ups) + downs.join('/');
  if (rel === '') return './';
  if (!rel.endsWith('/')) rel += '/';
  return rel;
}

// ── Transclusion entry prefix: '^' ─────────────────────────────────────────
// A transclusion entry may carry a leading '^', meaning "the target node
// itself" rather than the children it would otherwise be unwrapped into.
//
// The choice is per-ENTRY, not per-declaration: a multiple-transclusion must be
// able to mix the two — `{=> ^#p-3, #chapter-4, *}` brings postulate 3 as a row,
// chapter 4's children, and the node's own children. That is why this is not an
// attribute (node-scoped, orthogonal to a ref-scoped choice) and not a distinct
// arrow (declaration-scoped, same problem).
//
// '^' cannot collide with anything already in the ref grammar: '@' opens a
// sigil, '*' is the wildcard entry, '.' and '/' open paths, '#' opens a bare
// slug. It sits outside a sigil ref ('^@alice/path#slug') because it modifies
// the resolution, while '@' names where to resolve.
//
// It lives here, in the dependency-free address module, rather than in
// transclusion.ts: the static builder needs it before it has installed the
// globalThis stubs that transclusion.js's import graph requires at module init.
const WHOLE_NODE_PREFIX = '^';

/** Split a transclusion entry into its '^' flag and the bare ref beneath it. */
export function parseTranscludeEntry(entry: string): { ref: string; wholeNode: boolean } {
  const trimmed = entry.trim();
  return trimmed.startsWith(WHOLE_NODE_PREFIX)
    ? { ref: trimmed.slice(WHOLE_NODE_PREFIX.length).trim(), wholeNode: true }
    : { ref: trimmed, wholeNode: false };
}

// ── Slug resolution ────────────────────────────────────────────────────────────

// Internal to resolveSlugInFile. Stage 1 took its client callers away — a
// compound slug is a key the origin answers now, not a path the client walks.
function parseCompoundSlug(slug: string): { anchor: string; path: number[] } {
  const parts = slug.split('.');
  let anchorEnd = 0;
  // A path segment is a position only when it is ENTIRELY digits. parseInt
  // accepts a digit prefix, so an id like `43-proof` read as the number 43 and
  // ended the anchor before it began, collapsing `43-proof.11` into one opaque
  // key that matched nothing.
  while (anchorEnd < parts.length && !/^\d+$/.test(parts[anchorEnd])) anchorEnd++;
  return {
    anchor: parts.slice(0, anchorEnd).join('.') || slug,
    path:   parts.slice(anchorEnd).map(s => parseInt(s, 10)).filter(n => !isNaN(n)),
  };
}

export function resolveSlugInFile(
  { nodeMap, roots }: { nodeMap: Record<string, SourceNode>; roots: SourceNode[] },
  slug: string | null | undefined,
): { node: SourceNode } | null {
  if (!slug) return null;
  if (nodeMap[slug]) return { node: nodeMap[slug] };
  const { anchor, path } = parseCompoundSlug(slug);
  if (nodeMap[anchor]) {
    let node = nodeMap[anchor];
    for (const pos of path) {
      const child = node.children?.find(c => c.numbering.split('.').slice(-1)[0] === String(pos));
      if (!child) return null;
      node = child;
    }
    return { node };
  }
  const allParts = slug.startsWith('.') ? slug.slice(1).split('.') : slug.split('.');
  const rootNode = roots.find(r => r.numbering === allParts[0]);
  if (rootNode) {
    let node = rootNode;
    for (const part of allParts.slice(1)) {
      const child = node.children?.find(c => c.numbering.split('.').slice(-1)[0] === part);
      if (!child) return null;
      node = child;
    }
    return { node };
  }
  return null;
}

