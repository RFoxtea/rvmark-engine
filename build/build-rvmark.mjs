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
import { fileToUrlStem, relativeUrl, resolveAddress, resolveMediaAddress, addressToFile, addressToSlug, addressToHref } from '../out/shared.js';

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

const { parse, resolveFile } = await import('../out/parser.js');
const { Multimap } = await import('../out/multimap.js');

const { factoryGet } = await import('../out/render-node.js');
const { SourceFile } = await import('../out/source-file.js');

// Import type files for their side effects (they call RvmarkRegistry.register).
await import('../out/types/text.js');
const { staticMdInline, staticMdToHtml } = await import('../out/markdown.js');
await import('../out/types/markdown.js');
await import('../out/types/video.js');
await import('../out/types/iframe.js');
await import('../out/types/image.js');
await import('../out/types/tr.js');
await import('../out/types/table.js');
await import('../out/types/hr.js');
await import('../out/types/gap.js');
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
    import { registerTransform } from './_engine/envoy-guest.js';
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
  const buildCtx = {
    readFile(relPath) {
      try { return readFileSync(join(RVMARK_DIR, relPath), 'utf8'); }
      catch { return null; }
    },
  };
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

function buildStaticTagChips(tags, sourceFile) {
  return tags
    .map(({ name, props }) => {
      const def = resolveTag(name, sourceFile, props);
      if (def.has('internal')) return '';
      const color = def.get('color');
      const tip   = def.get('tip');
      const cls   = def.getAll('class').join(' ');
      const href  = def.get('href');
      const label = def.get('label');
      const style = color ? ` style="--tag-color:${escHtml(color)}"` : '';
      const title = tip   ? ` title="${escHtml(tip)}"` : '';
      const extraClass = cls ? ' ' + escHtml(cls) : '';
      const displayName = staticMdInline(label ?? name);
      if (href) {
        return `<a class="static-tag static-tag--link${extraClass}" href="${escHtml(href)}"${style}${title}>${displayName}</a> `;
      }
      return `<span class="static-tag${extraClass}"${style}${title}>${displayName}</span> `;
    })
    .join('');
}

function renderStaticNode(node, sourceFile) {
  const attrs = node.attrs;
  const isHidden = attrs.has('hidden');

  const transcludeRaw = attrs.get('transclude') ?? null;
  const embedList  = transcludeRaw ? transcludeRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
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

  const liClasses = [
    isHidden ? 'static-hidden' : '',
    ...node.tags.flatMap(({ name, props }) => {
      const def = resolveTag(name, sourceFile, props);
      return def.getAll('class').flatMap(c => c.split(/\s+/).filter(Boolean));
    }),
    ...attrs.getAll('class').flatMap(c => c.split(/\s+/).filter(Boolean)),
  ].filter(Boolean);
  const liClassAttr = liClasses.length ? ` class="${escHtml(liClasses.join(' '))}"` : '';

  const exhibitVal = attrs.get('exhibit') ?? null;
  let exhibitLinkHtml = '';
  if (exhibitVal) {
    const mediaAddr = resolveMediaAddress(exhibitVal, sourceFile.pageAddress);
    const href = mediaAddr ? addressToHref(mediaAddr) : null;
    if (href) {
      exhibitLinkHtml = ` <a class="static-exhibit-link" href="${escHtml(href)}" title="Open exhibit (requires JavaScript for interactive view)">◧</a>`;
    }
  }

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
        return `<li${liClassAttr}>${tags}${targetTags}<a class="${refClass}" href="${escHtml(href)}">${staticMdInline(linkLabel)}</a></li>\n`;
      }
    }
    if (href) {
      return `<li${liClassAttr}>${tags}<a class="${refClass}" href="${escHtml(href)}">${staticMdInline(linkLabel || transcludeVal)}</a></li>\n`;
    }
  }

  // For typed nodes, render body directly via factory.
  const typeName = attrs.get('type');
  if (typeName) {
    const factory = factoryGet(typeName);
    const bodyHtml = (!factory?.isComposite ? factory?.staticRenderBody?.(node, buildCtx) : null) ?? null;
    let html = `<li${idAttr}${liClassAttr}>`;
    if (bodyHtml) html += bodyHtml;
    if (node.children.length > 0) {
      html += renderStaticNodes(node.children, sourceFile);
    }
    html += '</li>\n';
    return html;
  }

  // Text node: label + children
  let html = `<li${idAttr}${liClassAttr}>`;
  html += `${tags}${staticMdInline(node.label || '')}${exhibitLinkHtml}`;

  if (node.children.length > 0) {
    html += renderStaticNodes(node.children, sourceFile);
  }

  html += '</li>\n';
  return html;
}

function renderStaticNodes(nodes, sourceFile) {
  if (!nodes.length) return '';
  let html = '<ul class="static-tree">\n';
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    const typeName = node.attrs.get('type') ?? 'text';
    const factory = factoryGet(typeName);

    if (factory?.isComposite) {
      const runStart = i;
      while (i < nodes.length && (nodes[i].attrs.get('type') ?? 'text') === typeName) i++;
      const run = nodes.slice(runStart, i);
      html += '<li>';
      for (const rn of run) {
        html += factory.staticRenderBody?.(rn, buildCtx) ?? '';
      }
      html += '</li>\n';
      const firstWithChildren = run.find(rn => rn.children.length > 0);
      if (firstWithChildren) {
        html += `<li>${renderStaticNodes(firstWithChildren.children, sourceFile)}</li>\n`;
      }
    } else if (typeName === 'table') {
      const tableOpen = factory?.staticRenderBody?.(node, buildCtx) ?? '<table class="static-table"><tbody>';
      html += `<li id="${escHtml(node.permalinkId ?? '')}">`;
      html += tableOpen + '\n';
      for (const child of node.children) {
        const cf = factoryGet(child.attrs.get('type') ?? 'text');
        html += cf?.staticRenderBody?.(child, buildCtx) ?? '';
        if (child.children.length > 0) {
          const cols = node.label.split(/\s*\|\s*/).length || 1;
          html += `<tr><td colspan="${cols}">${renderStaticNodes(child.children, sourceFile)}</td></tr>\n`;
        }
      }
      html += '</tbody></table></li>\n';
      i++;
    } else {
      html += renderStaticNode(node, sourceFile);
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
  const showHiddenToggle = !meta?.has('no-hidden-toggle');
  const footerLabel = meta?.get('footer-label') ?? 'rvmark';

  const staticHtml = renderStaticNodes(sourceFile.roots, sourceFile);

  let html = TEMPLATE;
  html = html.replaceAll('{{TITLE}}',         escHtml(title));
  html = html.replaceAll('{{DESCRIPTION}}',   escHtml(description));
  html = html.replaceAll('{{BASE}}',          base);
  html = html.replaceAll('{{RVMARK_FILE}}',   relPath);
  html = html.replaceAll('{{SITE_MAP_JSON}}', siteMapJson);
  {
    // The template places these four chips back-to-back with no separator of
    // its own, and any chip (including footerLabel) may be empty — so each
    // chip after the first present one needs a leading " · ".
    let seenChip = false;
    const sep = () => { const s = seenChip ? ' · ' : ''; seenChip = true; return s; };

    html = html.replaceAll('{{FOOTER_LABEL}}', footerLabel ? `${sep()}<span class="footer-section">${staticMdInline(footerLabel)}</span>` : '');
    html = html.replaceAll('{{LICENSE}}',      license ? `${sep()}<span class="footer-section">${staticMdInline(license)}</span>` : '');
    html = html.replaceAll('{{AUTHOR}}',       author  ? `${sep()}<span class="footer-section">${staticMdInline(author)}</span>` : '');
    html = html.replaceAll('{{SHOW_HIDDEN_TOGGLE}}', showHiddenToggle ? `${sep()}<label class="show-hidden-toggle footer-section"><input type="checkbox" id="show-hidden-cb"> show hidden</label>` : '');
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

  // Engine-authored JS bundles → _engine/
  const engineJs = readdirSync(enginePath('out')).filter(f => f.endsWith('.js'));
  for (const f of engineJs) {
    cpSync(enginePath('out', f), join(ENGINE_DIR, f));
  }
  if (existsSync(enginePath('out/types'))) cpSync(enginePath('out/types'), join(ENGINE_DIR, 'types'), { recursive: true });

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
