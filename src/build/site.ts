/**
 * site.ts — rvmark static site generator (library form)
 *
 * Exposes `buildSite(config)`: for each .rvmark file under the content dir,
 * generates an HTML page with a flat static rendering (no-JS fallback) and
 * embeds page metadata for JS hydration. The rendering is render-site.ts; this
 * is its Node host — the filesystem, the engine bundles, and the envoy.
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
 *   head,                  // optional — HTML fragment file injected at the end of <head>
 *   template,              // optional — HTML template PATH (defaults to engine's)
 *   templateHtml,          // optional — HTML template CONTENTS (wins over template)
 *   assetsDir,             // optional — dir copied into outDir preserving its name (e.g. ./assets → dist/assets/)
 *   includeDrafts,         // optional — keep {draft} nodes/files
 *   mountPath,             // optional — URL prefix for content (default '/_rvmark/')
 * }
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, rmSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { isRvFile } from '../shared/shared.js';

// Engine package root — this file emits to <ENGINE_ROOT>/out/build/site.js.
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const enginePath = (...p: string[]) => join(ENGINE_ROOT, ...p);
const requireFromEngine = createRequire(join(ENGINE_ROOT, 'package.json'));

// ── Inject marked into globalThis before importing type files ─────────────────
// markdown.js accesses marked via globalThis.marked (works in both browser and
// Node build contexts). Load the CJS bundle by file path — marked's package
// "exports" map does not expose lib/marked.cjs as a subpath, so we resolve the
// package root then reach the bundle relative to it.

const markedRoot = dirname(requireFromEngine.resolve('marked/package.json'));
(globalThis as any).marked = requireFromEngine(join(markedRoot, 'lib/marked.cjs'));

// ── Stub browser globals used by type files at module init ────────────────────
// Type files are now real ESM modules — they run in the actual Node environment.
// Globals that exist in the browser but not Node need stubs so module init
// doesn't throw. These stubs only need to be present; they are never called
// during build-time static rendering.

if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = { addEventListener() {} };
}
if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = { createElement() { return {}; }, querySelector() { return null; }, addEventListener() {} };
}
if (typeof (globalThis as any).DOMPurify === 'undefined') {
  (globalThis as any).DOMPurify = { sanitize: (s: string) => s };
}

// Dynamic, so the stubs above are in place before the type modules evaluate.
const { renderSite, contentOutDir } = await import('./render-site.js');

// ── Custom-type / envoy emission ──────────────────────────────────────────────
// Transpile every author custom-type module in `customTypesDir` into
// `<dist>/_custom-types/` and generate `<dist>/envoy.html` to load them. Author
// files are TypeScript that default-export a CustomType descriptor and import
// only types from 'rvmark/envoy' (erased by transpile). We transpile (strip
// types) rather than typecheck — fast, and isolatedModules-safe.
async function emitEnvoy(customTypesDir: string | null, DIST_DIR: string) {
  const typesDir = customTypesDir && existsSync(customTypesDir) ? customTypesDir : null;
  const srcFiles = typesDir ? readdirSync(typesDir).filter(f => f.endsWith('.ts')) : [];
  const modules = []; // emitted module basenames (e.g. 'mytype.js')

  // Only minted when there is something to put in it: a site with no custom
  // types still gets an envoy, but not an empty directory beside it.
  if (srcFiles.length) mkdirSync(join(DIST_DIR, '_custom-types'), { recursive: true });

  const ts = srcFiles.length
    ? (await import(pathToFileURL(requireFromEngine.resolve('typescript')).href)).default
    : null;

  const outDir = join(DIST_DIR, '_custom-types');
  for (const f of srcFiles) {
    const src = readFileSync(join(typesDir!, f), 'utf8');
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
  //
  // With no descriptors the import is still there, as a bare side-effecting one:
  // importing envoy-guest is what installs the message listener, and that is the
  // envoy. A site with no custom types needs it exactly as much as one with them.
  const lines = modules.length
    ? [
        `import { registerTransform } from './_engine/envoy/envoy-guest.js';`,
        ...modules.map((m, i) => `import d${i} from './_custom-types/${m}';`),
        ...modules.map((_, i) => `registerTransform(d${i});`),
      ]
    : [`import './_engine/envoy/envoy-guest.js';`];

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>rvmark envoy</title></head>
<body>
  <script type="module">
    ${lines.join('\n    ')}
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
export interface BuildSiteConfig {
  contentDir: string;
  outDir: string;
  theme?: string | null;
  head?: string | null;
  template?: string | null;
  templateHtml?: string | null;
  assetsDir?: string | null;
  customTypesDir?: string | null;
  includeDrafts?: boolean;
  mountPath?: string;
}

export async function buildSite(config: BuildSiteConfig) {
  const {
    contentDir,
    outDir,
    theme = null,
    head = null,
    template = null,
    templateHtml = null,
    assetsDir = null,
    customTypesDir = null,
    includeDrafts = false,
    mountPath = '/_rvmark/',
  } = config;

  if (!contentDir) throw new Error('buildSite: config.contentDir is required');
  if (!outDir)     throw new Error('buildSite: config.outDir is required');

  const RVMARK_DIR = contentDir;
  const DIST_DIR   = outDir;

  // `templateHtml` (raw contents) wins over `template` (path); both default to
  // the engine's template. Lets callers patch the template in-memory (e.g. the
  // --test build relaxing the CSP for the http peer) without forking the file.
  const TEMPLATE = templateHtml ?? readFileSync(template ?? enginePath('src/template.html'), 'utf8');

  // Site-supplied <head> fragment. Missing file is fatal rather than ignored:
  // silently dropping it leaves the author with a page that is merely missing
  // whatever the fragment was for, and nothing to grep for.
  let SITE_HEAD = '';
  if (head) {
    if (!existsSync(head)) throw new Error(`buildSite: head fragment not found: ${head}`);
    SITE_HEAD = readFileSync(head, 'utf8');
    // These duplicate what the template already sets; the browser resolves the
    // clash on its own terms and the author gets no signal. Warn, don't block —
    // overriding may be deliberate.
    for (const [re, what] of [[/<title[\s>]/i, '<title>'], [/<base[\s>]/i, '<base>'], [/http-equiv=/i, 'http-equiv meta']] as const)
      if (re.test(SITE_HEAD)) console.warn(`  warning: head fragment contains ${what}; the template already sets one`);
  }

  function walk(dir: string, base: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = base ? `${base}/${entry}` : entry;
      if (statSync(full).isDirectory()) results.push(...walk(full, rel));
      else results.push(rel);
    }
    return results;
  }
  const paths = walk(RVMARK_DIR, '');

  const rendered = renderSite({
    paths,
    read(path) {
      try { return readFileSync(join(RVMARK_DIR, path), 'utf8'); }
      catch { return null; }
    },
    lastModified: (path) => statSync(join(RVMARK_DIR, path)).mtime,
    template: TEMPLATE,
    siteHead: SITE_HEAD,
    includeDrafts,
    mountPath,
  });

  if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
  for (const [rel, text] of rendered) {
    const outPath = join(DIST_DIR, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
  }

  // ── Copy static assets ──────────────────────────────────────────────────────

  // Reserved engine namespace in the dist root (underscore-prefixed so they can
  // never collide with user content): _engine/ (engine JS), _vendor/ (third-party
  // libs), _assets/ (user static assets). Content/media goes under contentOutDir
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
  // importing it — sidepanel.ts writes that <script src> itself, and an author's
  // own sidepanel page (euclid's viewer.html) does the same. Anything the engine
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

  // Generated envoy.html (dist root), plus any custom node types → _custom-types/.
  // Author files default-export a CustomType descriptor (see envoy-guest.ts);
  // each is transpiled (types-only imports erase) into _custom-types/, and the
  // generated envoy.html imports envoy-guest.js + every descriptor and registers
  // them. envoy.html loads into the sandboxed per-origin OriginEnvoy iframe.
  //
  // Unconditional: the envoy is the only route to content, so a site without one
  // renders nothing at all. It is site infrastructure that happens to be where
  // custom types get registered, not an artifact of having declared any.
  await emitEnvoy(customTypesDir, DIST_DIR);

  // Non-rvmark files in the rvmark dir (e.g. docs.md, images).
  for (const rel of paths) {
    if (isRvFile(rel) || rel.endsWith('.mjs')) continue;
    const outPath = join(DIST_DIR, contentOutDir(mountPath), rel);
    mkdirSync(dirname(outPath), { recursive: true });
    cpSync(join(RVMARK_DIR, rel), outPath);
  }

  console.log('\nBuild complete.');
}
