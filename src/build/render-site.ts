/**
 * render-site.ts — the pure half of the site generator.
 *
 * Sources in, files out: every page, the draft-stripped sources, and the
 * sitemap, as a map of dist-relative path → text. No filesystem, so it runs in
 * a browser as well as under Node. site.ts is the Node host; the engine's
 * bundles, stylesheet, vendor libs and envoy are the host's to supply.
 *
 * Importing this evaluates the type modules, which read `globalThis.marked`
 * and `DOMPurify` — a host installs both first (site.ts, browser.ts).
 */

import { fileToUrlStem, resolveAddress, resolveMediaAddress, addressToFile, addressToSlug, addressToHref, parseTranscludeEntry, RV_EXT, isRvFile, stripRvExt, toRvFile } from '../shared/shared.js';
import { defaultTypeName } from '../shared/node-types.js';
import { parse, resolveFile } from '../shared/parser.js';
import type { RvNode, NodeAttrs, ResolvedTag, TagDef, OriginDef, SourceFile } from '../shared/parser.js';
import { Multimap } from '../shared/multimap.js';
import { factoryGet } from '../client/render-node.js';
import { RvFile } from '../envoy/rv-file.js';
import { staticRenderBullet, staticBulletProps } from '../types/text.js';
import { staticMdInline, staticMdInlineResolved } from '../client/markdown.js';
import '../types/block.js';
import '../types/video.js';
import '../types/iframe.js';
import '../types/image.js';
import '../types/tr.js';
import '../types/table.js';
import { parseCells } from '../types/tr-base.js';
import '../types/hr.js';
import '../types/gap.js';

export interface RenderSiteInput {
  /** Every file in the content tree, by its path within it. */
  paths: string[];
  /** A content file's text, or null if it has none. */
  read(path: string): string | null;
  /** For the sitemap's lastmod; defaults to now. */
  lastModified?(path: string): Date;
  /** The page template's contents. */
  template: string;
  /** HTML injected at the end of every page's <head>. */
  siteHead?: string;
  includeDrafts?: boolean;
  mountPath?: string;
  log?(line: string): void;
}

/** Where content is mirrored in the dist, e.g. '_rvmark' for '/_rvmark/'. */
export const contentOutDir = (mountPath: string) => mountPath.replace(/^\/+|\/+$/g, '') || '_rvmark';

export function renderSite(input: RenderSiteInput): Map<string, string> {
  const {
    paths,
    read,
    lastModified = () => new Date(),
    template: TEMPLATE,
    siteHead: SITE_HEAD = '',
    includeDrafts: INCLUDE_DRAFTS = false,
    mountPath = '/_rvmark/',
    log = console.log,
  } = input;

  const out = new Map<string, string>();

  // Build context passed to every staticRenderBody hook (see render-node.ts).
  // `url` is what the origin resolved a media ref to — path-only at build time,
  // since a built page has no origin yet. Mapping it back to a content file is
  // the origin's build-side half doing what its browser half does with fetch.
  const buildCtx = {
    readFile(url: string) {
      if (!url || !url.startsWith(mountPath)) return null;
      const relPath = url.slice(mountPath.length).split('#')[0];
      return read(sourcePathOf.get(relPath) ?? relPath);
    },
    // The build-time twin of Origin.resolveResource, and synchronous because the
    // builder IS the origin's Node-side half: the store is in hand and there is
    // no wire between them. A node carries the document it came from, so a
    // transcluded foreign node still resolves against its own file.
    resolveMedia(node: RvNode, ref: string) {
      return resolveMediaAddress(ref, node.pageAddress) ?? ref;
    },
  };

  // A node's label, with any `img:` on a span resolved against the file that
  // node came from — the same rule the hydrated path follows, and the reason a
  // transcluded label is resolved against ITS node rather than the host's.
  const staticLabel = (node: RvNode, label?: string) =>
    staticMdInlineResolved(label ?? node.label ?? '', (refs) => refs.map((ref) => buildCtx.resolveMedia(node, ref)));

  // Per-build state (was module-level in the monorepo script).
  const urlStemToFile = new Map();
  const sourceFiles = new Map<string, SourceFile>();  // first pass, per relPath
  const rvFiles = new Map(); // second pass: resolved { head, roots, nodeMap, rvFile }
  const siteMap: Record<string, { file: string }> = {};

  // ── Path-valued meta keys ────────────────────────────────────────────────────
  // Meta inherits down the index.rvmark chain, and the merge flattens each value
  // into a key→value pair — the file it was written in is gone by the time
  // anything reads it. A key holding an address must therefore be resolved while
  // that provenance is still in hand, so `./card.png` in the root header means
  // the root's directory even when it is read from a page three levels down.
  //
  // This is the one path where inheritance crosses a file. Node-level inherited
  // properties do not — `sidepanel` (inherited.ts) can keep its ref raw and let
  // the reader resolve it against its own rvFile precisely because every
  // node holding a scope is in the file that declared it. A head value is read
  // from files its author never saw, so raw is not an option here.
  //
  // Adding a path-valued key is one registration here. Each value passes
  // resolution exactly once — resolveMediaAddress is not idempotent
  // ('/_rvmark/x' → '/_rvmark/_rvmark/x').
  const PATH_VALUED_META = new Set(['card-img']);

  // ── Inherited head from ancestor index.rvmark files ──────────────────────────

  function resolveInheritedHead(relPath: string) {
  const parts = relPath.split('/');
  const chain = ['index' + RV_EXT];
  for (let i = 0; i < parts.length - 1; i++) {
    chain.push(parts.slice(0, i + 1).join('/') + '/index' + RV_EXT);
  }

  const mergedMeta = new Multimap();
  const mergedTagDefs: Record<string, TagDef> = {};
  const mergedOrigins: Record<string, OriginDef> = {};
  for (const indexPath of chain) {
    if (indexPath === relPath) continue;
    const p = sourceFiles.get(indexPath);
    if (!p) continue;
    // RvFile.resolveMediaUrl is the method for this, but the ancestor's
    // RvFile is not built yet — the merge feeds the very pass that builds
    // it. Same resolution against the same address it would use.
    const ancestorAddress = mountPath + indexPath;
    for (const [k, v] of p.head.meta.allEntries())
      mergedMeta.append(k, PATH_VALUED_META.has(k) ? (resolveMediaAddress(v, ancestorAddress) ?? v) : v);
    // withSource is the step this merge used to skip: a def carried out of the
    // file that wrote it has to say so, or its relative addresses get read
    // against whichever file happens to use the tag.
    for (const [name, def] of Object.entries(p.head.tagDefs))
      mergedTagDefs[name] = def.withSource(ancestorAddress);
    Object.assign(mergedOrigins, p.head.origins);
  }
  return { meta: mergedMeta, tagDefs: mergedTagDefs, origins: mergedOrigins };
}

// ── Reserved-namespace validation ─────────────────────────────────────────────
// The dist root reserves underscore-prefixed segments for engine artifacts
// (_rvmark/, _assets/, _engine/, _vendor/, and envoy.html's future home). To keep
// that guarantee, the content tree may not contain underscore-prefixed directories
// or underscore-prefixed .rvmark files — they would shadow or collide with reserved
// paths once mirrored under _rvmark/. Collect every offender, then fail once.
// A directory is reported once, at its outermost underscore segment.
function collectReservedNameViolations(paths: string[]): string[] {
  const violations = new Set<string>();
  for (const path of paths) {
    const segs = path.split('/');
    const dirAt = segs.slice(0, -1).findIndex((seg) => seg.startsWith('_'));
    if (dirAt !== -1) violations.add(`${segs.slice(0, dirAt + 1).join('/')}/  (directory)`);
    else if (isRvFile(path) && segs[segs.length - 1].startsWith('_')) violations.add(`${path}  (rvmark file)`);
  }
  return [...violations];
}

const reservedViolations = collectReservedNameViolations(paths);
if (reservedViolations.length) {
  throw new Error(
    `Reserved-name violation: underscore-prefixed directories and rvmark files are ` +
    `not allowed in the content tree (the '_' prefix is reserved for engine paths).\n` +
    reservedViolations.map(v => `  - ${v}`).join('\n'),
  );
}

// ── Rvmark files ──────────────────────────────────────────────────────────────

// Keyed by the published name (foo.rv.md); the source may be foo.rvmark.
const sourcePathOf = new Map<string, string>();
for (const src of paths.filter(isRvFile)) {
  const published = toRvFile(src);
  const clash = sourcePathOf.get(published);
  if (clash) throw new Error(`${clash} and ${src} both publish as ${published}`);
  sourcePathOf.set(published, src);
}
const allRvmarkFiles = [...sourcePathOf.keys()].sort();

// Primacy: foo.rv.md shadows foo/index.rv.md
const allFileSet = new Set(allRvmarkFiles);
const shadowedSet = new Set();
for (const f of allRvmarkFiles) {
  if (!f.endsWith('/index' + RV_EXT)) continue;
  const dirStem = f.slice(0, -('/index' + RV_EXT).length);
  const shadowFile = dirStem + RV_EXT;
  if (allFileSet.has(shadowFile)) {
    console.warn(`  ⚠ ${shadowFile} shadows ${f} — skipping ${f}`);
    shadowedSet.add(f);
  }
}
const rvmarkFiles = allRvmarkFiles.filter(f => !shadowedSet.has(f));

// ── Draft pruning ─────────────────────────────────────────────────────────────

/**
 * Recursively remove nodes with {draft} from a node list.
 * Also removes them from nodeMap.
 */
function pruneDraftNodes(nodes: RvNode[], nodeMap: Record<string, RvNode>) {
  const kept = [];
  for (const node of nodes) {
    if (node.attrs.has('draft')) {
      // Remove this node and all descendants from nodeMap
      removeFromNodeMap(node, nodeMap);
      continue;
    }
    node.children = pruneDraftNodes(node.children, nodeMap);
    kept.push(node);
  }
  return kept;
}

function removeFromNodeMap(node: RvNode, nodeMap: Record<string, RvNode>) {
  if (nodeMap[node.slug] === node) delete nodeMap[node.slug];
  for (const child of node.children) removeFromNodeMap(child, nodeMap);
}

/**
 * Strip draft nodes from raw rvmark source text using indentation.
 * A draft node line and all following lines at greater indentation are removed.
 * Also removes multiline body blocks ({/=} / {/media} delimited).
 */
function stripDraftLines(src: string) {
  const lines = src.split('\n');
  const out = [];
  let skipIndent = null; // indent string of the draft node being skipped
  let fenceChar  = null; // backtick char of open fence inside skipped body
  let fenceLen   = 0;    // length of open fence

  for (const line of lines) {
    // If we're inside a fenced body of a skipped node, skip until closing fence
    if (fenceChar !== null) {
      const closeM = line.match(/^[ \t]*(`{3,}|~{3,})\s*$/);
      if (closeM && closeM[1][0] === fenceChar && closeM[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen  = 0;
      }
      continue;
    }

    // If we're skipping a draft subtree, check if this line is still in it
    if (skipIndent !== null) {
      const m = line.match(/^( *)(?:[a-zA-Z0-9]+\.|([-*]))\s/);
      if (m) {
        const indent = m[1];
        // If this line's indent is greater than the draft node's indent, skip it
        if (indent.length > skipIndent.length) {
          // Check if this child node opens a fenced body
          const openM = line.match(/(`{3,}|~{3,})/);
          if (openM) { fenceChar = openM[1][0]; fenceLen = openM[1].length; }
          continue;
        }
        // Back to same or lesser indent — stop skipping
        skipIndent = null;
      } else {
        // Could be an opening fence of the draft node's own body
        const openM = line.match(/^[ \t]*(`{3,}|~{3,})/);
        if (openM) { fenceChar = openM[1][0]; fenceLen = openM[1].length; }
        continue;
      }
    }

    // Check if this line is a draft node
    const nodeM = line.match(/^( *)(?:[a-zA-Z0-9]+\.|([-*]))\s+(.*)/);
    if (nodeM) {
      const rest = nodeM[3];
      // Check for {draft} in the attrs block
      const paramM = rest.match(/^\{([^}]*)\}/);
      if (paramM) {
        const keys = paramM[1].split(';').map((s: string) => s.trim());
        if (keys.includes('draft')) {
          skipIndent = nodeM[1];
          continue;
        }
      }
    }

    out.push(line);
  }
  return out.join('\n');
}

// ── Parse files ───────────────────────────────────────────────────────────────

// First pass: parse each file to get raw head (local meta + tagDefs only).
for (const relPath of rvmarkFiles) {
  const src = read(sourcePathOf.get(relPath)!) ?? '';
  const raw = parse(src);

  if (!INCLUDE_DRAFTS && raw.head.meta?.has('draft')) {
    log(`  [draft] skipping ${relPath}`);
    continue;
  }

  sourceFiles.set(relPath, raw);

  const urlStem = fileToUrlStem(relPath);
  urlStemToFile.set(urlStem, relPath);
  siteMap[urlStem] = { file: relPath };
}

// Second pass: resolve each file with its inherited head.
for (const [relPath, raw] of sourceFiles) {
  const inheritedHead = resolveInheritedHead(relPath);
  const resolved = resolveFile(raw, inheritedHead);
  if (!INCLUDE_DRAFTS) resolved.roots = pruneDraftNodes(resolved.roots, resolved.nodeMap);
  const sf = new RvFile(resolved.nodeMap, resolved.roots, resolved.head, relPath, mountPath + relPath);
  // A path-valued key written in this file's OWN header resolves against this
  // file — sf.resolveMediaUrl is the same method a node's media goes through.
  // The inherited copies of these keys arrived already resolved (against the
  // ancestor that wrote them); this overwrites them with the local one, which
  // is what nearest-wins means.
  //
  // Written to sf's head, never back to raw.head: sourceFiles is what
  // resolveInheritedHead reads for every later file, so rewriting a root header
  // in place would leave descendants inheriting an already-resolved value and
  // resolving it a second time — and resolveMediaAddress is not idempotent
  // ('/_rvmark/x' → '/_rvmark/_rvmark/x').
  for (const k of PATH_VALUED_META) {
    const v = raw.head.meta.get(k);
    if (v !== undefined) sf.head.meta.set(k, sf.resolveMediaUrl(v));
  }
  rvFiles.set(relPath, sf);
}

// ── Escape helper (used in static HTML tree renderer) ─────────────────────────

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Static HTML tree renderer ─────────────────────────────────────────────────

function resolveTransclusion(val: string, rvFile: RvFile) {
  if (!val || typeof val !== 'string') return null;
  if (val.startsWith('https://') || val.startsWith('http://')) return null;

  const address = resolveAddress(val, rvFile.pageAddress);
  if (!address || address.startsWith('https://') || address.startsWith('http://')) return null;

  let targetFile = addressToFile(address);
  const targetSlug = addressToSlug(address);
  if (!targetFile) return null;

  let targetSf = rvFiles.get(targetFile);
  if (!targetSf) {
    targetFile = stripRvExt(targetFile) + '/index' + RV_EXT;
    targetSf = rvFiles.get(targetFile);
  }
  if (!targetSf) return null;

  if (targetSlug) {
    const node = targetSf.nodeMap[targetSlug];
    return node ? { node, file: targetFile } : null;
  }
  return targetSf.roots.length ? { node: targetSf.roots[0], file: targetFile } : null;
}

function isInterpageRef(val: string, rvFile: RvFile) {
  if (!val || typeof val !== 'string') return false;
  if (val.startsWith('#')) return false;
  if (val.startsWith('https://') || val.startsWith('http://')) return true;
  const address = resolveAddress(val, rvFile.pageAddress);
  if (!address) return false;
  if (address.startsWith('https://') || address.startsWith('http://')) return true;
  const targetFile = addressToFile(address);
  return !!targetFile && targetFile !== rvFile.address;
}

function transclusionHref(val: string, rvFile: RvFile) {
  if (!val || typeof val !== 'string') return null;
  if (val.startsWith('https://') || val.startsWith('http://')) return val;

  const address = resolveAddress(val, rvFile.pageAddress);
  if (!address) return null;
  if (address.startsWith('https://') || address.startsWith('http://')) return address;

  if (val.startsWith('#')) return val;

  let targetFile = addressToFile(address);
  if (!targetFile) return null;

  if (!rvFiles.has(targetFile)) {
    const fallback = stripRvExt(targetFile) + '/index' + RV_EXT;
    if (rvFiles.has(fallback)) targetFile = fallback;
  }

  return addressToHref(address.startsWith(mountPath) ? mountPath + targetFile + (address.includes('#') ? '#' + addressToSlug(address) : '') : address);
}

// String twin of buildTagChips (tags.ts). Same classes, same order, same
// trailing space — the space is a real character there for clipboard reasons,
// and matching it keeps copied text identical between the two renderings.
function buildStaticTagChips(tags: ResolvedTag[]) {
  return tags
    .map(({ name, def }: ResolvedTag) => {
      if (def.has('internal')) return '';
      const color = def.get('color');
      const tip   = def.get('tip');
      const href  = def.get('href');
      const label = def.get('label');
      const style = color ? ` style="--tag-color:${escHtml(color)}"` : '';
      const title = tip   ? ` title="${escHtml(tip)}"` : '';
      const displayName = staticMdInline(label ?? name);
      if (href) {
        return `<a class="node-tag node-tag--link" href="${escHtml(href)}"${style}${title}>${displayName}</a> `;
      }
      return `<span class="node-tag"${style}${title}>${displayName}</span> `;
    })
    .join('');
}

// Class list for .node-content, mirroring applyTagClasses (handler-utils.ts):
// tag-defined classes first, then the node's own {class} attrs.
function staticContentClasses(node: RvNode, attrs: NodeAttrs) {
  const out = [];
  for (const { def } of node.tags) {
    for (const cls of def.getAll('class')) out.push(...cls.split(/\s+/).filter(Boolean));
  }
  // `attrs` is the resolved view, so this picks up tag-supplied `node.class`
  // alongside the node's own — the same two sources, in the same order, as
  // applyTagClasses.
  for (const cls of attrs.getAll('class')) out.push(...cls.split(/\s+/).filter(Boolean));
  return [...new Set(out)];
}

// Which types draw a bullet, and which can collapse. Both answers belong to the
// type, not to this builder — but a plain data table is the honest way to say
// so from here without bolting build-time hooks onto NodeTypeFactory, which is
// a runtime interface every type implements.
//
// BULLET_TYPES mirrors who calls buildToggleBullet in the DOM: text, and the
// tr/table family via tr-base. Everything else supplies its own chrome (block's
// left border strip) or is a bare band across the row (hr, gap, image, video).
//
// ALWAYS_OPEN_TYPES mirrors ToggleSet({ alwaysOpen: true }): a block's children
// are never behind a disclosure, so wrapping one in <details> would invent a
// collapse the hydrated page does not offer.
const BULLET_TYPES      = new Set(['text', 'tr', 'table']);
const ALWAYS_OPEN_TYPES = new Set(['block']);

// Bullet icons are painted as CSS masks, and a mask fetch is subject to CORS.
// A file:// document has an opaque origin, so Firefox refuses to read even a
// sibling file ("CORS request not http") and the gutter renders empty. Inlining
// the SVG as a data: URI removes the fetch entirely — no origin, no CORS check
// — and costs nothing on a served site, where icon sets are small and already
// inlined once per page rather than requested per node.
//
// The hydrated path inlines too, but arrives there differently: its icons are
// fetched by the origin that owns them (origin.ts fetchResources) rather than
// read off disk here, since a federated node's bullet lives on its own origin
// and this build never sees it. What both paths buy is the same — a mask that
// cannot fail to load, so neither needs a second request per row to find out
// whether the first one did.
const bulletDataUriCache = new Map();
function inlineBulletUrls(styles: string[]) {
  return styles.map((decl: string) => decl.replace(/url\("([^"]+)"\)/g, (whole: string, url: string) => {
    if (!url.endsWith('.svg') || /^(data:|https?:)/.test(url)) return whole;
    if (bulletDataUriCache.has(url)) return bulletDataUriCache.get(url);
    // Strip the mount prefix, then read from the content tree it mirrors.
    const rel = url.replace(/^\/?_rvmark\//, '').replace(/^\//, '');
    // A missing icon leaves the URL; CSS falls back to the dot.
    const svg = read(rel);
    const inlined = svg === null ? whole
      : `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
    bulletDataUriCache.set(url, inlined);
    return inlined;
  }));
}

// Wrap a row + its children in the collapsed-by-default disclosure. The static
// page has no JS to drive expansion, so <details> supplies it natively: the
// engine's own expansion is async (children are built on demand, see
// setChildren in render-node.ts) and cannot be handed to the browser, but at
// build time every child already exists, which is exactly the case <details>
// assumes.
//
// aria-expanded is written literally so the [aria-expanded] presence rules —
// the ones that draw a triangle instead of a dot — match with no CSS change.
// The ="true" rules key off `details[open] >` instead; see styles.css.
// The permalink id rides on whichever element is outermost for this node —
// <details> when there are children, the row itself when there are not — so a
// '#id' link lands on the node either way, and :target can reach the <details>
// it needs to force open.
function wrapDisclosure(rowHtml: string, childrenHtml: string, open: boolean, idAttr: string) {
  if (!childrenHtml) return rowHtml.replace(/^<(summary|div)/, `<$1${idAttr}`);
  return `<details${open ? ' open' : ''}${idAttr}>${rowHtml}<div class="node-children">${childrenHtml}</div></details>`;
}

function renderStaticNode(node: RvNode, rvFile: RvFile, depth = 0) {
  // Merged view: tag-supplied `node.*` attrs (e.g. a {.book} tag defining
  // node.bullet) plus the node's own. The hydrated page reads exactly this via
  // resolveAttrs, so reading raw node.attrs here would silently drop every
  // tag-driven bullet, {li} and {class} from the fallback.
  const attrs = node.attrs;
  const isHidden = attrs.has('hidden');

  const transcludeRaw = attrs.get('transclude') ?? null;
  // The '^' prefix selects what the hydrated page puts in the children area; the
  // static fallback renders every transclusion as a hyperlink either way, so the
  // prefix is stripped here and the link is the same. Left on, it would reach
  // resolveAddress as a literal path segment and yield a dead href.
  const embedList  = transcludeRaw
    ? transcludeRaw.split(',').map((s: string) => parseTranscludeEntry(s).ref).filter(Boolean)
    : null;
  const hasLabel   = (node.label || '').trim() !== '';
  const isChildrenMode = transcludeRaw !== null && (
    hasLabel ||
    (embedList && (embedList.length > 1 || embedList.includes('*')))
  );
  const embedVal        = !isChildrenMode && embedList ? embedList[0] : null;
  const childrenLinkVal = isChildrenMode && embedList
    ? (embedList.find((s: string) => s !== '*') ?? null)
    : null;
  const id               = node.permalinkId;
  const idAttr           = ` id="${escHtml(id)}"`;

  const tags = buildStaticTagChips(node.tags);

  // Tag/attr classes belong on .node-content, matching applyTagClasses. The
  // {hidden} marker stays on the li: it suppresses the whole row, children
  // included, and .node-content would only reach the row itself.
  const contentClasses = staticContentClasses(node, attrs);
  const liClasses = [
    isHidden ? 'static-hidden' : '',
    'node',
    attrs.get('open') === 'always' ? 'static-always-open' : '',
  ].filter(Boolean);
  const liClassAttr = ` class="${escHtml(liClasses.join(' '))}"`;

  const sidepanelVal = attrs.get('sidepanel') ?? null;
  let sidepanelLinkHtml = '';
  if (sidepanelVal) {
    const mediaAddr = resolveMediaAddress(sidepanelVal, rvFile.pageAddress);
    const href = mediaAddr ? addressToHref(mediaAddr) : null;
    if (href) {
      sidepanelLinkHtml = ` <a class="static-sidepanel-link" href="${escHtml(href)}" title="Open sidepanel (requires JavaScript for interactive view)">◧</a>`;
    }
  }

  const nodeType   = attrs.get('type') ?? defaultTypeName();
  const hasBullet  = BULLET_TYPES.has(nodeType);

  // The `open` attribute, read exactly as text.ts/toggle-set.ts read it:
  // bare `{open}` and `open: true` start expanded; `always` is not collapsible
  // at all; `never` is not expandable at all; `false` is the plain default.
  const openVal    = attrs.get('open');
  const openAlways = openVal === 'always';
  const openNever  = openVal === 'never';
  const openInit   = attrs.has('open') && (openVal === '' || openVal === 'true');

  // `always` gets no disclosure at all: the row stays a <div> and the children
  // sit beside it, permanently visible — the same shape ALWAYS_OPEN_TYPES uses.
  // `never` likewise, so the fallback never offers a collapse the hydrated page
  // refuses. Both rely on the !isSummary branches below to stay out of
  // <details>, which synthesises a "Details" summary around a non-summary row.
  const collapsible = !ALWAYS_OPEN_TYPES.has(nodeType) && !openAlways && !openNever;

  // Bullet props only mean anything to a type that draws a bullet; asking for
  // them elsewhere would put .li or a bullet image on a row with no gutter.
  const { classes: bulletClasses, styles: rawBulletStyles, bulletAlt } = hasBullet
    ? staticBulletProps(node, attrs, buildCtx)
    : { classes: [], styles: [], bulletAlt: null };
  const bulletStyles = inlineBulletUrls(rawBulletStyles);
  const styleAttr = bulletStyles.length ? ` style="${escHtml(bulletStyles.join(';'))}"` : '';

  // Build the .node-content row. `leaf` mirrors setExpandable: a row with no
  // children draws a dot and carries no aria-expanded at all.
  //
  // aria-expanded states the disclosure's INITIAL state and nothing more. The
  // browser flips <details open> as the reader clicks and cannot be asked to
  // update an ARIA attribute alongside it, so this attribute goes stale the
  // moment anything is toggled. That is tolerable only because <summary>
  // announces its own open/closed state natively — the attribute is here for
  // the CSS presence rules ([aria-expanded] draws a triangle rather than a
  // dot), not for assistive tech, which reads the disclosure instead.
  const row = (innerHtml: string, isSummary: boolean, open = false, extraClasses: string[] = []) => {
    const cls = ['node-content', ...contentClasses, ...bulletClasses, ...extraClasses].join(' ');
    const expanded = isSummary ? ` aria-expanded="${open}"` : '';
    const tag = isSummary ? 'summary' : 'div';
    const bullet = hasBullet ? staticRenderBullet(!isSummary, bulletAlt, escHtml) : '';
    return `<${tag} class="${escHtml(cls)}"${expanded}${styleAttr}>${bullet}${innerHtml}</${tag}>`;
  };

  // Transclusion — render as hyperlink (embedding, no id)
  const transcludeVal = embedVal ?? childrenLinkVal;

  if (transcludeVal) {
    const href = transclusionHref(transcludeVal, rvFile);
    const refClass = isInterpageRef(transcludeVal, rvFile) ? 'static-ref static-ref--interpage' : 'static-ref';
    let linkLabel = node.label || '';
    if (embedVal && !linkLabel) {
      const resolved = resolveTransclusion(embedVal, rvFile);
      if (resolved) {
        linkLabel = resolved.node.label || linkLabel || transcludeVal;
        const targetSourceFile = rvFiles.get(resolved.file);
        const targetTags = targetSourceFile ? buildStaticTagChips(resolved.node.tags) : '';
        const lbl = `<span class="node-label">${tags}${targetTags}<a class="${refClass}" href="${escHtml(href ?? '')}">${staticLabel(resolved.node, linkLabel ?? undefined)}</a></span>`;
        return `<li${liClassAttr}>${row(lbl, false)}</li>\n`;
      }
    }
    if (href) {
      const lbl = `<span class="node-label">${tags}<a class="${refClass}" href="${escHtml(href)}">${staticLabel(node, linkLabel || transcludeVal)}</a></span>`;
      return `<li${liClassAttr}>${row(lbl, false)}</li>\n`;
    }
  }

  // `open: never` is not expandable, so its children are unreachable in the
  // hydrated page. Emitting them here would leave them permanently visible —
  // the exact inverse of the attribute — so they are dropped outright.
  const hasChildren = node.children.length > 0 && !openNever;
  const childrenHtml = hasChildren ? renderStaticNodes(node.children, rvFile, depth + 1) : '';
  // Collapsed by default, matching renderRoot in main.ts: the hydrated page
  // mounts roots[0] and selects it without expanding. The fallback has no
  // selection to show for it, so the two agree on the painted result. An
  // authored {open}/`open: true` overrides that, as it does when hydrated.
  const open = openInit;
  // An always-open type keeps its children, but not behind a disclosure — so
  // its row stays a <div> and the children sit beside it, always visible.
  const isSummary = hasChildren && collapsible;

  // For typed nodes, render body directly via factory.
  const typeName = attrs.get('type');
  if (typeName) {
    const factory = factoryGet(typeName);
    const bodyHtml = factory?.staticRenderBody?.(node, buildCtx) ?? null;
    const rowHtml = row(bodyHtml ?? '', isSummary, open);
    if (!isSummary) {
      const kids = childrenHtml ? `<div class="node-children">${childrenHtml}</div>` : '';
      return `<li${liClassAttr}>${rowHtml.replace(/^<(summary|div)/, `<$1${idAttr}`)}${kids}</li>\n`;
    }
    return `<li${liClassAttr}>${wrapDisclosure(rowHtml, childrenHtml, open, idAttr)}</li>\n`;
  }

  // Text node: label + children
  const lbl = `<span class="node-label">${tags}${staticLabel(node)}${sidepanelLinkHtml}</span>`;
  const rowHtml = row(lbl, isSummary, open);
  // A non-summary row must never go inside <details>: the element requires a
  // <summary> first child and synthesises a "Details" one when it is missing.
  // Same shape as the typed branch above — children sit beside the row.
  if (!isSummary) {
    const kids = childrenHtml ? `<div class="node-children">${childrenHtml}</div>` : '';
    return `<li${liClassAttr}>${rowHtml.replace(/^<(summary|div)/, `<$1${idAttr}`)}${kids}</li>\n`;
  }
  return `<li${liClassAttr}>${wrapDisclosure(rowHtml, childrenHtml, open, idAttr)}</li>\n`;
}

// Static twin of TrTypeHandlerBase (types/tr-base.ts) — the table/tr family.
//
// These cannot use <details> like the rest of the tree. Their children are grid
// items of an ancestor (.tr-row > .node-children is grid-column 2/-1; a table's
// .node-children is display:contents so its rows join the table grid), and a
// <details> wraps everything after its <summary> in an anonymous slot box that
// display:contents does not dissolve. That box becomes the grid item instead,
// and every cell alignment in the table collapses.
//
// So the disclosure here is a hidden checkbox with the toggle bullet as its
// <label>. It adds no box of its own — the input is display:none and the label
// IS the bullet element the grid already places — so the box tree is exactly
// what the hydrated page builds, and :checked ~ .node-children drives the same
// collapse aria-expanded drives there.
function renderStaticTableNode(node: RvNode, rvFile: RvFile, depth: number, typeName: string) {
  const attrs  = node.attrs;
  const isTable = typeName === 'table';
  const factory = factoryGet(typeName);

  const liClasses = [
    'node',
    isTable ? 'table-node' : 'tr-row',
    attrs.has('hidden') ? 'static-hidden' : '',
    attrs.get('open') === 'always' ? 'static-always-open' : '',
  ].filter(Boolean);

  // The header/row cells come from the type's own staticRenderBody, which
  // already emits .node-content--table / .node-content with .tr-cell children.
  const rowHtml = factory?.staticRenderBody?.(node, buildCtx) ?? '';

  // Same `open` contract as renderStaticNode — see the comment there. `never`
  // drops its children; `always` shows them with no toggle; `true` ships the
  // checkbox pre-checked, which is what :checked ~ .node-children reads.
  const openVal    = attrs.get('open');
  const openAlways = openVal === 'always';
  const openNever  = openVal === 'never';
  const openInit   = attrs.has('open') && (openVal === '' || openVal === 'true');

  const hasChildren = node.children.length > 0 && !openNever;
  const childrenHtml = hasChildren
    ? `<div class="node-children">${renderStaticNodes(node.children, rvFile, depth + 1)}</div>`
    : '';

  const { bulletAlt } = staticBulletProps(node, attrs, buildCtx);
  const togClass = isTable ? 'table-toggle toggle' : 'tr-toggle toggle';

  let toggleHtml;
  let inputHtml = '';
  if (hasChildren && openAlways) {
    // Always-open: children are shown outright, so no checkbox and no label —
    // a leaf bullet, matching the hydrated row that offers no collapse either.
    toggleHtml = staticRenderBullet(true, bulletAlt, escHtml).replace('class="toggle leaf"', `class="${togClass} leaf"`);
  } else if (hasChildren) {
    // The id has to be unique per page and stable across builds; the permalink
    // id already is both.
    const tid = `rvt-${node.permalinkId ?? `${depth}-${node.slug ?? ''}`}`;
    inputHtml = `<input type="checkbox" class="static-toggle" id="${escHtml(tid)}"${openInit ? ' checked' : ''}>`;
    const alt = bulletAlt ? `<span class="visually-hidden">${escHtml(bulletAlt)} </span>` : '';
    toggleHtml = `<label class="${togClass}" for="${escHtml(tid)}">${alt}<span class="toggle-badge" aria-hidden="true"></span></label>`;
  } else {
    toggleHtml = staticRenderBullet(true, bulletAlt, escHtml).replace('class="toggle leaf"', `class="${togClass} leaf"`);
  }

  // The grid's column track list lives on the li, matching table.ts's onSetup.
  // A tr inherits its columns from the table's subgrid, so only a table sets it.
  let styleAttr = '';
  if (isTable) {
    const colCount = parseCells(node.label).length || 1;
    const cols = attrs.get('cols') ?? `repeat(${colCount}, 1fr)`;
    styleAttr = ` style="--table-cols:${escHtml(cols)}"`;
  }

  const idAttr = node.permalinkId ? ` id="${escHtml(node.permalinkId)}"` : '';
  return `<li class="${escHtml(liClasses.join(' '))}"${idAttr}${styleAttr}>${inputHtml}${toggleHtml}${rowHtml}${childrenHtml}</li>\n`;
}

function renderStaticNodes(nodes: RvNode[], rvFile: RvFile, depth = 0) {
  if (!nodes.length) return '';
  let html = '<ul class="tree">\n';
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    const typeName = node.attrs.get('type') ?? defaultTypeName();

    if (typeName === 'table' || typeName === 'tr') {
      html += renderStaticTableNode(node, rvFile, depth, typeName);
      i++;
    } else {
      html += renderStaticNode(node, rvFile, depth);
      i++;
    }
  }
  html += '</ul>\n';
  return html;
}

// ── Site-wide identity, from the root header ──────────────────────────────────

// site-url is read off the root file's own header rather than through the
// inheritance chain because it describes the site, not a page: every page's
// absolute URL is built from the same origin, and a subtree that overrode it
// would be claiming to live somewhere else. Trailing slash trimmed so
// SITE_URL + '/' + stem never doubles it.
const rootMeta = rvFiles.get('index' + RV_EXT)?.head?.meta;
const SITE_URL = (rootMeta?.get('site-url') ?? '').replace(/\/+$/, '');
if (SITE_URL && !/^https?:\/\//.test(SITE_URL))
  throw new Error(`buildSite: site-url must be an absolute origin (got '${SITE_URL}')`);
if (!SITE_URL)
  console.warn('  warning: no {site-url} in the root header — omitting canonical, og:url and sitemap.xml');
const siteName = rootMeta?.get('title') || 'rvmark';

// robots takes a named value, the way `open: always|never` does. It cannot be
// presence-only like {draft} or {hidden} because the default is ON: a bare
// {robots} would have to mean "index", which is what omitting it already means.
//
// Exact match, and anything unrecognised throws rather than defaulting. The
// failure this guards is silent and invisible in the output: a page that meant
// to be excluded and is quietly indexed instead looks identical in dist/.
const indexable = (m: { get(k: string): string | undefined } | undefined, where: string) => {
  const v = m?.get('robots');
  if (v === undefined || v === 'index') return true;
  if (v === 'noindex') return false;
  throw new Error(`${where}: robots must be 'index' or 'noindex' (got '${v}')`);
};

// ── Generate pages ────────────────────────────────────────────────────────────

const siteMapJson = JSON.stringify(siteMap);

for (const [relPath, rvFile] of rvFiles) {
  const urlStem = fileToUrlStem(relPath);
  const isRoot  = urlStem === '';

  const outPath = isRoot ? 'index.html' : urlStem + '/index.html';

  const base = isRoot ? '' : '../'.repeat(urlStem.split('/').length);

  const meta        = rvFile.head.meta;
  const title       = meta?.get('title') || urlStem || 'index';
  const description = meta?.get('description') || 'A tree-structured website powered by rvmark — expand nodes to explore.';
  const license     = meta?.get('license') ?? '';
  const author      = meta?.get('author') ?? '';
  const footerLabel = meta?.get('footer-label') ?? 'rvmark';

  // Absolute page URL. site-url is authored once, in the root header; without it
  // there is no origin to build one from, and the tags that need an absolute URL
  // (og:url, canonical, an absolute og:image) are simply omitted rather than
  // emitted relative — a crawler reading a relative canonical against the wrong
  // base is worse than no canonical.
  const pageUrl  = SITE_URL ? SITE_URL + '/' + (urlStem ? urlStem + '/' : '') : '';
  // card-img arrives already resolved to a root-absolute '/_rvmark/…' address
  // (see PATH_VALUED_META). Scrapers do not follow relative image URLs, so an
  // absolute origin is required for it too.
  const cardImgRef = meta?.get('card-img') ?? '';
  const cardImg    = !cardImgRef ? ''
    : /^https?:\/\//.test(cardImgRef) ? cardImgRef
    : SITE_URL ? SITE_URL + cardImgRef : '';

  const socialMeta = [
    ...(indexable(meta, relPath) ? [] : ['  <meta name="robots" content="noindex, follow">']),
    `  <meta property="og:type" content="${isRoot ? 'website' : 'article'}">`,
    `  <meta property="og:title" content="${escHtml(title)}">`,
    `  <meta property="og:description" content="${escHtml(description)}">`,
    `  <meta property="og:site_name" content="${escHtml(siteName)}">`,
    ...(pageUrl ? [`  <meta property="og:url" content="${escHtml(pageUrl)}">`] : []),
    ...(cardImg ? [`  <meta property="og:image" content="${escHtml(cardImg)}">`] : []),
    // summary with no image still unfurls as title + description + domain, which
    // is most of the benefit; summary_large_image with a missing image does not.
    `  <meta name="twitter:card" content="${cardImg ? 'summary_large_image' : 'summary'}">`,
    `  <meta name="twitter:title" content="${escHtml(title)}">`,
    `  <meta name="twitter:description" content="${escHtml(description)}">`,
    ...(cardImg ? [`  <meta name="twitter:image" content="${escHtml(cardImg)}">`] : []),
    ...(pageUrl ? [`  <link rel="canonical" href="${escHtml(pageUrl)}">`] : []),
  ].join('\n') + '\n';

  // Asset URLs come out of addressToHref root-absolute ('/_rvmark/…'), which a
  // server resolves correctly but a file:// reader does not — there '/' is the
  // filesystem root, so every bullet, image and link 404s and the fallback
  // renders bare. The template's own assets already go through {{BASE}} for
  // exactly this reason; this applies the same base to the rendered markup.
  // Root pages have an empty base, where '/_rvmark/' → '_rvmark/' is still the
  // correct relative form.
  // Both quote forms occur: plain " in href/src, and &quot; inside the escaped
  // style attribute that carries --node-bullet-image.
  //
  // Cross-page transclusion links (static-ref hrefs) are the other root-
  // absolute case: transclusionHref returns addressToHref's page form
  // ('/docs/writing#slug'), same problem as the asset form. It has no access
  // to this page's `base` — that is computed per-page, here, not inside
  // transclusionHref — so it is corrected after the fact like the asset URLs
  // rather than threaded through the whole render call chain.
  //
  // href="/..." (root-absolute) is rewritten; href="//host/..." (protocol-
  // relative) and href="/_rvmark/..." (already handled above) are excluded so
  // neither is rewritten twice or wrongly.
  //
  // What's left after that exclusion is always a page URL stem
  // ('docs/navigating', optionally '#slug') — never a real file. A server
  // maps that stem to docs/navigating/index.html implicitly; file:// has no
  // server, so the literal filename has to be in the href, inserted before
  // any fragment.
  const rebase = (html: string) => {
    const rel = base + mountPath.replace(/^\//, '');
    return html
      .replaceAll(`"${mountPath}`, `"${rel}`)
      .replaceAll(`&quot;${mountPath}`, `&quot;${rel}`)
      .replace(/href="\/(?!\/)([^"#]*)(#[^"]*)?"/g, (_: string, stem: string, frag: string) =>
        `href="${base}${stem}${stem && !stem.endsWith('/') ? '/' : ''}index.html${frag ?? ''}"`);
  };

  const staticHtml = rebase(renderStaticNodes(rvFile.roots, rvFile));

  let html = TEMPLATE;
  // Before {{BASE}}, so a fragment referencing {{BASE}}_assets/... resolves too.
  html = html.replaceAll('{{SITE_HEAD}}',     () => SITE_HEAD);
  html = html.replaceAll('{{SOCIAL_META}}',   () => socialMeta);
  html = html.replaceAll('{{TITLE}}',         escHtml(title));
  html = html.replaceAll('{{DESCRIPTION}}',   escHtml(description));
  html = html.replaceAll('{{BASE}}',          base);
  html = html.replaceAll('{{RVMARK_FILE}}',   relPath);
  html = html.replaceAll('{{SITE_MAP_JSON}}', siteMapJson);
  {
    // The template places these three chips back-to-back with no separator of
    // its own, and any chip (including footerLabel) may be empty — so each
    // chip after the first present one needs a leading " · ".
    //
    // No show-hidden toggle here: it drives runtime state, so in the static
    // rendering it would be an inert control. The hydrated footer builds its
    // own (inside the view menu); the static view has no use for one, and
    // renders [.hidden] nodes unconditionally anyway.
    let seenChip = false;
    const sep = () => { const s = seenChip ? ' · ' : ''; seenChip = true; return s; };

    html = html.replaceAll('{{FOOTER_LABEL}}', footerLabel ? `${sep()}<span class="footer-section">${staticMdInline(footerLabel)}</span>` : '');
    html = html.replaceAll('{{LICENSE}}',      license ? `${sep()}<span class="footer-section">${staticMdInline(license)}</span>` : '');
    html = html.replaceAll('{{AUTHOR}}',       author  ? `${sep()}<span class="footer-section">${staticMdInline(author)}</span>` : '');
  }
  html = html.replace('{{STATIC_HTML}}', () => staticHtml);

  out.set(outPath, html);
  log(`  ${relPath} → ${outPath}`);
}
  // Emit rvmark source files, stripping draft nodes and skipping draft files.
  // Iterate allRvmarkFiles (not the shadow-filtered rvmarkFiles) so the dist
  // source tree mirrors the rvmark dir: a file shadowed for *page* generation
  // is still copied here. Shadowing governs which HTML page wins, not which
  // source bytes are emitted. Draft handling is unchanged.
  for (const relPath of allRvmarkFiles) {
    const src = read(sourcePathOf.get(relPath)!) ?? '';
    // Skip draft files. Can't use sourceFiles membership here — shadowed files are
    // absent from sourceFiles regardless of draft status — so check the source.
    if (!INCLUDE_DRAFTS && parse(src).head.meta?.has('draft')) continue;
    const stripped = INCLUDE_DRAFTS ? src : stripDraftLines(src);
    out.set(contentOutDir(mountPath) + '/' + relPath, stripped);
  }

  // ── sitemap.xml + robots.txt ────────────────────────────────────────────────
  //
  // A sitemap usually earns little — crawlers follow links. rvmark is the case
  // where it earns its keep: the crawlable markup lives in #static-content,
  // which ships display:none, and the inter-page links live inside it. Hidden
  // content is deprioritised, so the link graph between pages may never be
  // walked and pages beyond the root may never be found. The sitemap asserts
  // the URL set instead of depending on that traversal.
  //
  // The input is urlStemToFile — already shadow-filtered and draft-skipped,
  // which is exactly the published page set. NOT allRvmarkFiles, which is
  // deliberately unfiltered so shadowed files still get copied as source.
  //
  // robots.txt stays permissive and carries only the Sitemap: line. Disallowing
  // would stop crawlers reading the pages, and therefore stop them seeing any
  // noindex — the per-page mechanism is `robots: false`, not a disallow rule.
  if (SITE_URL) {
    const urls: string[] = [];
    for (const [urlStem, relPath] of urlStemToFile) {
      if (!indexable(rvFiles.get(relPath)?.head?.meta, relPath)) continue;
      const lastmod = lastModified(sourcePathOf.get(relPath)!).toISOString().slice(0, 10);
      urls.push(
        `  <url>\n` +
        `    <loc>${escHtml(SITE_URL + '/' + (urlStem ? urlStem + '/' : ''))}</loc>\n` +
        `    <lastmod>${lastmod}</lastmod>\n` +
        `  </url>`
      );
    }
    urls.sort();
    out.set('sitemap.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.join('\n') + `\n</urlset>\n`);
    out.set('robots.txt',
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    log(`  sitemap.xml (${urls.length} urls) + robots.txt`);
  }

  return out;
}
