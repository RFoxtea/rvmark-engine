/**
 * build-rvmark.mjs — rvmark static site generator (library form)
 *
 * Exposes `buildSite(config)`: for each .rvmark file under the content dir,
 * generates an HTML page with a flat static rendering (no-JS fallback) and
 * embeds page metadata for JS hydration.
 *
 * Paths split into two roots:
 *   - ENGINE_ROOT (this package): compiled JS (out/), template, core styles,
 *     type CSS, bundled assets, and the engine's own marked/dompurify.
 *   - config.contentDir (the consuming site): the .rvmark tree + its media.
 *
 * config = {
 *   contentDir,            // required — dir holding the .rvmark tree
 *   outDir,                // required — where the built site is written
 *   theme,                 // optional — CSS file appended after core styles
 *   template,              // optional — HTML template PATH (defaults to engine's)
 *   templateHtml,          // optional — HTML template CONTENTS (wins over template)
 *   assetsDir,             // optional — dir copied into outDir preserving its name (e.g. ./assets → dist/assets/)
 *   includeDrafts,         // optional — keep {draft} nodes/files
 *   mountPath,             // optional — URL prefix for content (default '/_rvmark/')
 * }
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, rmSync, existsSync, statSync } from 'fs';
import { join, dirname, posix } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { fileToUrlStem, relativeUrl, resolveAddress, resolveMediaAddress, addressToFile, addressToSlug, addressToHref, parseTranscludeEntry } from '../out/shared/shared.js';

// Engine package root — this file lives at <ENGINE_ROOT>/build/build-rvmark.mjs.
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = (...p) => join(ENGINE_ROOT, ...p);
const requireFromEngine = createRequire(join(ENGINE_ROOT, 'package.json'));

// ── Inject marked into globalThis before importing type files ─────────────────
// markdown.js accesses marked via globalThis.marked (works in both browser and
// Node build contexts). Load the CJS bundle by file path — marked's package
// "exports" map does not expose lib/marked.cjs as a subpath, so we resolve the
// package root then reach the bundle relative to it.

const markedRoot = dirname(requireFromEngine.resolve('marked/package.json'));
globalThis.marked = requireFromEngine(join(markedRoot, 'lib/marked.cjs'));

// ── Stub browser globals used by type files at module init ────────────────────
// Type files are now real ESM modules — they run in the actual Node environment.
// Globals that exist in the browser but not Node need stubs so module init
// doesn't throw. These stubs only need to be present; they are never called
// during build-time static rendering.

if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {} };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElement() { return {}; }, querySelector() { return null; }, addEventListener() {} };
}
if (typeof globalThis.DOMPurify === 'undefined') {
  globalThis.DOMPurify = { sanitize: s => s };
}

// ── Import parser and type modules ────────────────────────────────────────────
// Dynamic import ensures globalThis stubs are in place before module init runs.

const { parse, resolveFile } = await import('../out/shared/parser.js');
const { Multimap } = await import('../out/shared/multimap.js');

const { factoryGet } = await import('../out/client/render-node.js');
const { SourceFile } = await import('../out/envoy/source-file.js');

// Import type files for their side effects (they call RvmarkRegistry.register).
// text.js also exports the static bullet helpers — bullets belong to the types
// that draw them (text, and the tr/table family via tr-base), not to this
// builder, which only asks for them and never knows how they are made.
const { staticRenderBullet, staticBulletProps } = await import('../out/client/types/text.js');
const { staticMdInline, staticMdInlineResolved, staticMdToHtml } = await import('../out/client/markdown.js');
await import('../out/client/types/block.js');
await import('../out/client/types/video.js');
await import('../out/client/types/iframe.js');
await import('../out/client/types/image.js');
await import('../out/client/types/tr.js');
await import('../out/client/types/table.js');
// parseCells is the single definition of how a `a | b | c` label splits, shared
// with the handlers so the static column count can never drift from theirs.
const { parseCells } = await import('../out/client/types/tr-base.js');
await import('../out/client/types/hr.js');
await import('../out/client/types/gap.js');
// exhibit.js is not needed at build time (no static rendering) — skip it.

// ── Custom-type / envoy emission ──────────────────────────────────────────────
// Transpile every author custom-type module in `customTypesDir` into
// `<dist>/_custom-types/` and generate `<dist>/envoy.html` to load them. Author
// files are TypeScript that default-export a CustomType descriptor and import
// only types from 'rvmark/envoy' (erased by transpile). We transpile (strip
// types) rather than typecheck — fast, and isolatedModules-safe.
async function emitEnvoy(customTypesDir, DIST_DIR) {
  const ts = (await import(pathToFileURL(requireFromEngine.resolve('typescript')).href)).default;

  const outDir = join(DIST_DIR, '_custom-types');
  mkdirSync(outDir, { recursive: true });

  const srcFiles = readdirSync(customTypesDir).filter(f => f.endsWith('.ts'));
  const modules = []; // emitted module basenames (e.g. 'mytype.js')

  for (const f of srcFiles) {
    const src = readFileSync(join(customTypesDir, f), 'utf8');
    const { outputText } = ts.transpileModule(src, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName: f,
    });
    const outName = f.replace(/\.ts$/, '.js');
    writeFileSync(join(outDir, outName), outputText);
    modules.push(outName);
  }

  // Generated entry glue: import envoy-guest's registerTransform + every author
  // descriptor (default export), then register each. registerTransform is our
  // concern, not the author's — authors only declare a descriptor.
  const imports = modules
    .map((m, i) => `import d${i} from './_custom-types/${m}';`)
    .join('\n    ');
  const regs = modules.map((_, i) => `registerTransform(d${i});`).join('\n    ');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>rvmark envoy</title></head>
<body>
  <script type="module">
    import { registerTransform } from './_engine/envoy/envoy-guest.js';
    ${imports}
    ${regs}
  </script>
</body>
</html>
`;
  writeFileSync(join(DIST_DIR, 'envoy.html'), html);
}

/**
 * Build a site from rvmark content into a static HTML site.
 * See the config shape documented at the top of this file.
 */
export async function buildSite(config) {
  const {
    contentDir,
    outDir,
    theme = null,
    template = null,
    templateHtml = null,
    assetsDir = null,
    customTypesDir = null,
    includeDrafts = false,
    mountPath = '/_rvmark/',
  } = config;

  if (!contentDir) throw new Error('buildSite: config.contentDir is required');
  if (!outDir)     throw new Error('buildSite: config.outDir is required');

  const RVMARK_DIR     = contentDir;
  const DIST_DIR       = outDir;
  const INCLUDE_DRAFTS = includeDrafts;

  // Build context passed to every staticRenderBody hook (see render-node.ts).
  // `url` is what the origin resolved a media ref to — path-only at build time,
  // since a built page has no origin yet. Mapping it back to a file on disk is
  // the origin's Node-side half doing what its browser half does with fetch.
  const buildCtx = {
    readFile(url) {
      if (!url || !url.startsWith(mountPath)) return null;
      const relPath = url.slice(mountPath.length).split('#')[0];
      try { return readFileSync(join(RVMARK_DIR, relPath), 'utf8'); }
      catch { return null; }
    },
    // The build-time twin of Origin.resolveResource, and synchronous because the
    // builder IS the origin's Node-side half: the store is in hand and there is
    // no wire between them. A node carries the document it came from, so a
    // transcluded foreign node still resolves against its own file.
    resolveMedia(node, ref) {
      return resolveMediaAddress(ref, node.pageAddress) ?? ref;
    },
  };

  // A node's label, with any `img:` on a span resolved against the file that
  // node came from — the same rule the hydrated path follows, and the reason a
  // transcluded label is resolved against ITS node rather than the host's.
  const staticLabel = (node, label) =>
    staticMdInlineResolved(label ?? node.label ?? '', (refs) => refs.map((ref) => buildCtx.resolveMedia(node, ref)));
  // `templateHtml` (raw contents) wins over `template` (path); both default to
  // the engine's template. Lets callers patch the template in-memory (e.g. the
  // --test build relaxing the CSP for the http peer) without forking the file.
  const TEMPLATE = templateHtml ?? readFileSync(template ?? enginePath('src/template.html'), 'utf8');

  // Per-build state (was module-level in the monorepo script).
  const urlStemToFile = new Map();
  const rawFiles = new Map();    // first pass: RawFile per relPath
  const sourceFiles = new Map(); // second pass: resolved { head, roots, nodeMap, sourceFile }
  const siteMap = {};

  // ── Inherited head from ancestor index.rvmark files ──────────────────────────

  function resolveInheritedHead(relPath) {
  const parts = relPath.split('/');
  const chain = ['index.rvmark'];
  for (let i = 0; i < parts.length - 1; i++) {
    chain.push(parts.slice(0, i + 1).join('/') + '/index.rvmark');
  }

  const mergedMeta = new Multimap();
  const mergedTagDefs = {};
  for (const indexPath of chain) {
    if (indexPath === relPath) continue;
    const p = rawFiles.get(indexPath);
    if (!p) continue;
    for (const [k, v] of p.head.meta.allEntries()) mergedMeta.append(k, v);
    Object.assign(mergedTagDefs, p.head.tagDefs);
  }
  return { meta: mergedMeta, tagDefs: mergedTagDefs };
}

function resolveTag(name, sourceFile, inlineProps) {
  const def = new Multimap();
  const base = sourceFile.tagDefs?.[name];
  if (base) for (const [k, v] of base.allEntries()) def.append(k, v);
  if (inlineProps) for (const [k, v] of inlineProps.allEntries()) def.append(k, v);
  if (name.startsWith('.') && !def.has('internal') && !def.has('label')) def.append('internal', '');
  return def;
}

// ── Reserved-namespace validation ─────────────────────────────────────────────
// The dist root reserves underscore-prefixed segments for engine artifacts
// (_rvmark/, _assets/, _engine/, _vendor/, and envoy.html's future home). To keep
// that guarantee, the content tree may not contain underscore-prefixed directories
// or underscore-prefixed .rvmark files — they would shadow or collide with reserved
// paths once mirrored under _rvmark/. Collect every offender, then fail once.
function collectReservedNameViolations(dir, base) {
  const violations = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (entry.startsWith('_')) violations.push(`${rel}/  (directory)`);
      else violations.push(...collectReservedNameViolations(full, rel));
    } else if (entry.endsWith('.rvmark') && entry.startsWith('_')) {
      violations.push(`${rel}  (.rvmark file)`);
    }
  }
  return violations;
}

const reservedViolations = collectReservedNameViolations(RVMARK_DIR, '');
if (reservedViolations.length) {
  throw new Error(
    `Reserved-name violation: underscore-prefixed directories and .rvmark files are ` +
    `not allowed in the content tree (the '_' prefix is reserved for engine paths).\n` +
    reservedViolations.map(v => `  - ${v}`).join('\n'),
  );
}

// ── Scan rvmark files (recursive) ─────────────────────────────────────────────

function walkRvmark(dir, base) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      results.push(...walkRvmark(full, rel));
    } else if (entry.endsWith('.rvmark')) {
      results.push(rel);
    }
  }
  return results;
}

const allRvmarkFiles = walkRvmark(RVMARK_DIR, '').sort();

// Primacy: foo.rvmark shadows foo/index.rvmark
const allFileSet = new Set(allRvmarkFiles);
const shadowedSet = new Set();
for (const f of allRvmarkFiles) {
  if (!f.endsWith('/index.rvmark')) continue;
  const dirStem = f.slice(0, -'/index.rvmark'.length);
  const shadowFile = dirStem + '.rvmark';
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
function pruneDraftNodes(nodes, nodeMap) {
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

function removeFromNodeMap(node, nodeMap) {
  if (nodeMap[node.slug] === node) delete nodeMap[node.slug];
  for (const child of node.children) removeFromNodeMap(child, nodeMap);
}

/**
 * Strip draft nodes from raw rvmark source text using indentation.
 * A draft node line and all following lines at greater indentation are removed.
 * Also removes multiline body blocks ({/=} / {/media} delimited).
 */
function stripDraftLines(src) {
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
        const keys = paramM[1].split(';').map(s => s.trim());
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
  const src = readFileSync(join(RVMARK_DIR, relPath), 'utf8');
  const raw = parse(src);

  if (!INCLUDE_DRAFTS && raw.head.meta?.has('draft')) {
    console.log(`  [draft] skipping ${relPath}`);
    continue;
  }

  rawFiles.set(relPath, raw);

  const urlStem = fileToUrlStem(relPath);
  urlStemToFile.set(urlStem, relPath);
  siteMap[urlStem] = { file: relPath };
}

// Second pass: resolve each file with its inherited head.
for (const [relPath, raw] of rawFiles) {
  const inheritedHead = resolveInheritedHead(relPath);
  const resolved = resolveFile(raw, inheritedHead);
  if (!INCLUDE_DRAFTS) resolved.roots = pruneDraftNodes(resolved.roots, resolved.nodeMap);
  const sf = new SourceFile(resolved.nodeMap, resolved.roots, resolved.head, relPath, mountPath + relPath);
  sourceFiles.set(relPath, sf);
}

// ── Escape helper (used in static HTML tree renderer) ─────────────────────────

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Static HTML tree renderer ─────────────────────────────────────────────────

function resolveTransclusion(val, sourceFile) {
  if (!val || typeof val !== 'string') return null;
  if (val.startsWith('https://') || val.startsWith('http://')) return null;

  const address = resolveAddress(val, sourceFile.pageAddress);
  if (!address || address.startsWith('https://') || address.startsWith('http://')) return null;

  let targetFile = addressToFile(address);
  const targetSlug = addressToSlug(address);
  if (!targetFile) return null;

  let targetSf = sourceFiles.get(targetFile);
  if (!targetSf) {
    targetFile = targetFile.replace(/\.rvmark$/, '') + '/index.rvmark';
    targetSf = sourceFiles.get(targetFile);
  }
  if (!targetSf) return null;

  if (targetSlug) {
    const node = targetSf.nodeMap[targetSlug];
    return node ? { node, file: targetFile } : null;
  }
  return targetSf.roots.length ? { node: targetSf.roots[0], file: targetFile } : null;
}

function isInterpageRef(val, sourceFile) {
  if (!val || typeof val !== 'string') return false;
  if (val.startsWith('#')) return false;
  if (val.startsWith('https://') || val.startsWith('http://')) return true;
  const address = resolveAddress(val, sourceFile.pageAddress);
  if (!address) return false;
  if (address.startsWith('https://') || address.startsWith('http://')) return true;
  const targetFile = addressToFile(address);
  return !!targetFile && targetFile !== sourceFile.address;
}

function transclusionHref(val, sourceFile) {
  if (!val || typeof val !== 'string') return null;
  if (val.startsWith('https://') || val.startsWith('http://')) return val;

  const address = resolveAddress(val, sourceFile.pageAddress);
  if (!address) return null;
  if (address.startsWith('https://') || address.startsWith('http://')) return address;

  if (val.startsWith('#')) return val;

  let targetFile = addressToFile(address);
  if (!targetFile) return null;

  if (!sourceFiles.has(targetFile)) {
    const fallback = targetFile.replace(/\.rvmark$/, '') + '/index.rvmark';
    if (sourceFiles.has(fallback)) targetFile = fallback;
  }

  return addressToHref(address.startsWith(mountPath) ? mountPath + targetFile + (address.includes('#') ? '#' + addressToSlug(address) : '') : address);
}

// String twin of buildTagChips (tags.ts). Same classes, same order, same
// trailing space — the space is a real character there for clipboard reasons,
// and matching it keeps copied text identical between the two renderings.
function buildStaticTagChips(tags, sourceFile) {
  return tags
    .map(({ name, props }) => {
      const def = resolveTag(name, sourceFile, props);
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
function staticContentClasses(node, sourceFile, attrs) {
  const out = [];
  for (const { name, props } of node.tags) {
    const def = resolveTag(name, sourceFile, props);
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
// Only the static rendering does this. The hydrated path keeps real URLs: it
// runs from http(s), where the fetch is cached across every node that shares an
// icon, and applyBulletProps still has its load-failure fallback.
const bulletDataUriCache = new Map();
function inlineBulletUrls(styles, RVMARK_DIR) {
  return styles.map(decl => decl.replace(/url\("([^"]+)"\)/g, (whole, url) => {
    if (!url.endsWith('.svg') || /^(data:|https?:)/.test(url)) return whole;
    if (bulletDataUriCache.has(url)) return bulletDataUriCache.get(url);
    // Strip the mount prefix, then read from the content tree it mirrors.
    const rel = url.replace(/^\/?_rvmark\//, '').replace(/^\//, '');
    let out = whole;
    try {
      const svg = readFileSync(join(RVMARK_DIR, rel), 'utf8');
      out = `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
    } catch { /* missing icon: leave the URL, CSS falls back to the dot */ }
    bulletDataUriCache.set(url, out);
    return out;
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
function wrapDisclosure(rowHtml, childrenHtml, open, idAttr) {
  if (!childrenHtml) return rowHtml.replace(/^<(summary|div)/, `<$1${idAttr}`);
  return `<details${open ? ' open' : ''}${idAttr}>${rowHtml}<div class="node-children">${childrenHtml}</div></details>`;
}

function renderStaticNode(node, sourceFile, depth = 0) {
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
    ? transcludeRaw.split(',').map(s => parseTranscludeEntry(s).ref).filter(Boolean)
    : null;
  const hasLabel   = (node.label || '').trim() !== '';
  const isChildrenMode = transcludeRaw !== null && (
    hasLabel ||
    (embedList && (embedList.length > 1 || embedList.includes('*')))
  );
  const embedVal        = !isChildrenMode && embedList ? embedList[0] : null;
  const childrenLinkVal = isChildrenMode && embedList
    ? (embedList.find(s => s !== '*') ?? null)
    : null;
  const id               = node.permalinkId;
  const idAttr           = ` id="${escHtml(id)}"`;

  const tags = buildStaticTagChips(node.tags, sourceFile);

  // Tag/attr classes belong on .node-content, matching applyTagClasses. The
  // {hidden} marker stays on the li: it suppresses the whole row, children
  // included, and .node-content would only reach the row itself.
  const contentClasses = staticContentClasses(node, sourceFile, attrs);
  const liClasses = [
    isHidden ? 'static-hidden' : '',
    'node',
    attrs.get('open') === 'always' ? 'static-always-open' : '',
  ].filter(Boolean);
  const liClassAttr = ` class="${escHtml(liClasses.join(' '))}"`;

  const exhibitVal = attrs.get('exhibit') ?? null;
  let exhibitLinkHtml = '';
  if (exhibitVal) {
    const mediaAddr = resolveMediaAddress(exhibitVal, sourceFile.pageAddress);
    const href = mediaAddr ? addressToHref(mediaAddr) : null;
    if (href) {
      exhibitLinkHtml = ` <a class="static-exhibit-link" href="${escHtml(href)}" title="Open exhibit (requires JavaScript for interactive view)">◧</a>`;
    }
  }

  const nodeType   = attrs.get('type') ?? 'text';
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
  const bulletStyles = inlineBulletUrls(rawBulletStyles, RVMARK_DIR);
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
  const row = (innerHtml, isSummary, open = false, extraClasses = []) => {
    const cls = ['node-content', ...contentClasses, ...bulletClasses, ...extraClasses].join(' ');
    const expanded = isSummary ? ` aria-expanded="${open}"` : '';
    const tag = isSummary ? 'summary' : 'div';
    const bullet = hasBullet ? staticRenderBullet(!isSummary, bulletAlt, escHtml) : '';
    return `<${tag} class="${escHtml(cls)}"${expanded}${styleAttr}>${bullet}${innerHtml}</${tag}>`;
  };

  // Transclusion — render as hyperlink (embedding, no id)
  const transcludeVal = embedVal ?? childrenLinkVal;

  if (transcludeVal) {
    const href = transclusionHref(transcludeVal, sourceFile);
    const refClass = isInterpageRef(transcludeVal, sourceFile) ? 'static-ref static-ref--interpage' : 'static-ref';
    let linkLabel = node.label || '';
    if (embedVal && !linkLabel) {
      const resolved = resolveTransclusion(embedVal, sourceFile);
      if (resolved) {
        linkLabel = resolved.node.label || linkLabel || transcludeVal;
        const targetSourceFile = sourceFiles.get(resolved.file);
        const targetTags = targetSourceFile ? buildStaticTagChips(resolved.node.tags, targetSourceFile) : '';
        const lbl = `<span class="node-label">${tags}${targetTags}<a class="${refClass}" href="${escHtml(href)}">${staticLabel(resolved.node, linkLabel)}</a></span>`;
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
  const childrenHtml = hasChildren ? renderStaticNodes(node.children, sourceFile, depth + 1) : '';
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
    const bodyHtml = (!factory?.isComposite ? factory?.staticRenderBody?.(node, buildCtx) : null) ?? null;
    const rowHtml = row(bodyHtml ?? '', isSummary, open);
    if (!isSummary) {
      const kids = childrenHtml ? `<div class="node-children">${childrenHtml}</div>` : '';
      return `<li${liClassAttr}>${rowHtml.replace(/^<(summary|div)/, `<$1${idAttr}`)}${kids}</li>\n`;
    }
    return `<li${liClassAttr}>${wrapDisclosure(rowHtml, childrenHtml, open, idAttr)}</li>\n`;
  }

  // Text node: label + children
  const lbl = `<span class="node-label">${tags}${staticLabel(node)}${exhibitLinkHtml}</span>`;
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
function renderStaticTableNode(node, sourceFile, depth, typeName) {
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
    ? `<div class="node-children">${renderStaticNodes(node.children, sourceFile, depth + 1)}</div>`
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

function renderStaticNodes(nodes, sourceFile, depth = 0) {
  if (!nodes.length) return '';
  let html = '<ul class="tree">\n';
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    const typeName = node.attrs.get('type') ?? 'text';
    const factory = factoryGet(typeName);

    if (factory?.isComposite) {
      const runStart = i;
      while (i < nodes.length && (nodes[i].attrs.get('type') ?? 'text') === typeName) i++;
      const run = nodes.slice(runStart, i);
      html += '<li class="node">';
      for (const rn of run) {
        html += factory.staticRenderBody?.(rn, buildCtx) ?? '';
      }
      html += '</li>\n';
      const firstWithChildren = run.find(rn => rn.children.length > 0);
      if (firstWithChildren) {
        html += `<li class="node">${renderStaticNodes(firstWithChildren.children, sourceFile, depth + 1)}</li>\n`;
      }
    } else if (typeName === 'table' || typeName === 'tr') {
      html += renderStaticTableNode(node, sourceFile, depth, typeName);
      i++;
    } else {
      html += renderStaticNode(node, sourceFile, depth);
      i++;
    }
  }
  html += '</ul>\n';
  return html;
}

// ── Generate pages ────────────────────────────────────────────────────────────

if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
mkdirSync(DIST_DIR, { recursive: true });

const siteMapJson = JSON.stringify(siteMap);

for (const [relPath, sourceFile] of sourceFiles) {
  const urlStem = fileToUrlStem(relPath);
  const isRoot  = urlStem === '';

  const outDir  = isRoot ? DIST_DIR : join(DIST_DIR, urlStem);
  const outPath = join(outDir, 'index.html');
  mkdirSync(outDir, { recursive: true });

  const base = isRoot ? '' : '../'.repeat(urlStem.split('/').length);

  const meta        = sourceFile.head.meta;
  const title       = meta?.get('title') || urlStem || 'index';
  const description = meta?.get('description') || 'A tree-structured website powered by rvmark — expand nodes to explore.';
  const license     = meta?.get('license') ?? '';
  const author      = meta?.get('author') ?? '';
  const footerLabel = meta?.get('footer-label') ?? 'rvmark';

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
  const rebase = (html) => {
    const rel = base + mountPath.replace(/^\//, '');
    return html
      .replaceAll(`"${mountPath}`, `"${rel}`)
      .replaceAll(`&quot;${mountPath}`, `&quot;${rel}`)
      .replace(/href="\/(?!\/)([^"#]*)(#[^"]*)?"/g, (_, stem, frag) =>
        `href="${base}${stem}${stem && !stem.endsWith('/') ? '/' : ''}index.html${frag ?? ''}"`);
  };

  const staticHtml = rebase(renderStaticNodes(sourceFile.roots, sourceFile));

  let html = TEMPLATE;
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

  writeFileSync(outPath, html);
  console.log(`  ${relPath} → ${outPath}`);
}

  // ── Copy static assets ──────────────────────────────────────────────────────

  // Where content source/media is mirrored under outDir (matches the mount path).
  const contentOutSub = mountPath.replace(/^\/+|\/+$/g, '') || '_rvmark';

  // Reserved engine namespace in the dist root (underscore-prefixed so they can
  // never collide with user content): _engine/ (engine JS), _vendor/ (third-party
  // libs), _assets/ (user static assets). Content/media goes under contentOutSub
  // (_rvmark/). styles.css is the single stylesheet and lives in the dist root.
  const ENGINE_DIR = join(DIST_DIR, '_engine');
  const VENDOR_DIR = join(DIST_DIR, '_vendor');
  mkdirSync(ENGINE_DIR, { recursive: true });
  mkdirSync(VENDOR_DIR, { recursive: true });

  // Engine-authored JS → _engine/, bundled per entry point rather than copied
  // as a tree. Two entries, because two realms load engine code independently:
  // client/main.js (the page) and envoy/envoy-guest.js (the sandboxed iframe).
  // Each is served as one request instead of the ~43 the module graph would
  // otherwise fan out to — modules resolve at build time, so a reader pays one
  // round trip rather than one per wave of the import graph.
  //
  // envoy-guest keeps its `registerTransform` export: the generated envoy.html
  // imports it, and _custom-types/ stay separate unbundled modules that import
  // from it. Bundling the engine must not swallow author files.
  //
  // iframe-guest is an entry because framed pages load it by URL rather than
  // importing it — exhibit.ts writes that <script src> itself, and an author's
  // own exhibit page (euclid's viewer.html) does the same. Anything the engine
  // hands out as a URL is a served entry point, not an internal module.
  //
  // out/ itself stays unbundled — the CLI and package.json's ./parser,
  // ./stringify and ./builder exports import from it directly.
  // build/ is deliberately not served: server-side utilities.
  {
    const esbuild = await import('esbuild');
    for (const [entry, outfile] of [
      ['out/client/main.js',         join(ENGINE_DIR, 'client/main.js')],
      ['out/client/iframe-guest.js', join(ENGINE_DIR, 'client/iframe-guest.js')],
      ['out/envoy/envoy-guest.js',   join(ENGINE_DIR, 'envoy/envoy-guest.js')],
    ]) {
      if (!existsSync(enginePath(entry))) continue;
      await esbuild.build({
        entryPoints: [enginePath(entry)],
        outfile,
        bundle: true,
        format: 'esm',
        minify: true,
        target: 'es2022',
      });
    }
  }

  // Single stylesheet: engine styles.css (type CSS is merged into it) + user theme
  // (appended so theme wins) → dist root.
  {
    let css = readFileSync(enginePath('src/styles.css'), 'utf8');
    if (theme && existsSync(theme)) {
      css += '\n' + readFileSync(theme, 'utf8');
    }
    writeFileSync(join(DIST_DIR, 'styles.css'), css);
  }

  // Third-party vendored libs → _vendor/
  cpSync(requireFromEngine.resolve('marked/marked.min.js'), join(VENDOR_DIR, 'marked.min.js'));
  cpSync(requireFromEngine.resolve('dompurify/dist/purify.min.js'), join(VENDOR_DIR, 'purify.min.js'));

  // Default favicons → _assets/. Written before the user assets copy below, so
  // a site shipping its own _assets/favicon.svg (or -expanded) simply
  // overwrites these. The engine ships defaults because template.html always
  // emits the <link> and the visibility swap — without a file behind them,
  // every site would start with a broken icon reference.
  {
    const ASSETS_DIR = join(DIST_DIR, '_assets');
    mkdirSync(ASSETS_DIR, { recursive: true });
    for (const f of ['favicon.svg', 'favicon-expanded.svg']) {
      cpSync(enginePath('src', f), join(ASSETS_DIR, f));
    }
  }

  // User assets dir (e.g. ./assets) → dist/_assets/ (contents copied in).
  if (assetsDir && existsSync(assetsDir)) cpSync(assetsDir, join(DIST_DIR, '_assets'), { recursive: true });

  // Custom node types → _custom-types/ + generated envoy.html (dist root).
  // Author files default-export a CustomType descriptor (see envoy-guest.ts);
  // each is transpiled (types-only imports erase) into _custom-types/, and the
  // generated envoy.html imports envoy-guest.js + every descriptor and registers
  // them. envoy.html loads into the sandboxed per-origin OriginEnvoy iframe.
  if (customTypesDir && existsSync(customTypesDir)) {
    await emitEnvoy(customTypesDir, DIST_DIR);
  }

  // Copy rvmark source files, stripping draft nodes and skipping draft files.
  // Iterate allRvmarkFiles (not the shadow-filtered rvmarkFiles) so the dist
  // source tree mirrors the rvmark dir: a file shadowed for *page* generation
  // is still copied here. Shadowing governs which HTML page wins, not which
  // source bytes are emitted. Draft handling is unchanged.
  for (const relPath of allRvmarkFiles) {
    const src = readFileSync(join(RVMARK_DIR, relPath), 'utf8');
    // Skip draft files. Can't use rawFiles membership here — shadowed files are
    // absent from rawFiles regardless of draft status — so check the source.
    if (!INCLUDE_DRAFTS && parse(src).head.meta?.has('draft')) continue;
    const stripped = INCLUDE_DRAFTS ? src : stripDraftLines(src);
    const outPath = join(DIST_DIR, contentOutSub, relPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, stripped);
  }

  // Copy non-.rvmark files in the rvmark dir (e.g. docs.md, images).
  function copyNonRvmark(dir, relBase) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel  = relBase ? `${relBase}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        copyNonRvmark(full, rel);
      } else if (!entry.endsWith('.rvmark') && !entry.endsWith('.mjs')) {
        const outPath = join(DIST_DIR, contentOutSub, rel);
        mkdirSync(dirname(outPath), { recursive: true });
        cpSync(full, outPath);
      }
    }
  }
  copyNonRvmark(RVMARK_DIR, '');

  console.log('\nBuild complete.');
}
