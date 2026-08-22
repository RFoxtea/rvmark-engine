#!/usr/bin/env node
/**
 * rvmark — CLI for the rvmark static site generator.
 *
 * Usage:
 *   rvmark [build] [opts]    # build the site once (default subcommand)
 *   rvmark serve [opts]      # build, watch for changes, and preview-serve
 *   rvmark --test            # build the engine's own test fixtures
 *
 *   opts: [--config <file>] [--content <dir>] [--out <dir>] [--theme <file>]
 *         [--head <file>] [--template <file>] [--assets <dir>] [--custom-types <dir>]
 *         [--mount <path>] [--include-drafts]
 *         (serve also: [--port <n>] [--dev])
 *
 *   --dev (serve only): when running from a linked engine source checkout,
 *     also watch engine src/ and recompile the engine on changes.
 *
 * With no path flags, looks for rvmark.config.json in the current directory.
 * Explicit flags override values from the config file.
 *
 * Defaults: --content rvmark  --out dist  --port 8000
 */

import { buildSite } from '../build/build-rvmark.mjs';
import { watchPaths, serializeBuilds } from '../scripts/watch.mjs';
import { startServer } from '../scripts/static-server.mjs';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The federation specs fetch from an http peer on localhost:8003, but the
// production CSP allows only 'self' + https:. Derive a test-only template from
// the real one by adding that peer to connect-src/frame-src — keeping a single
// source template rather than a forked copy. Production CSP is untouched.
function testTemplateHtml() {
  const html = readFileSync(join(ENGINE_ROOT, 'src/template.html'), 'utf8');
  const PEER = 'http://localhost:8003';
  return html
    .replace(/(connect-src[^;]*)(;)/, `$1 ${PEER}$2`)
    .replace(/(frame-src[^;]*)(;)/, `$1 ${PEER}$2`);
}

function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include-drafts') { flags.add('includeDrafts'); continue; }
    if (a === '--test')           { flags.add('test'); continue; }
    if (a === '--dev')            { flags.add('dev'); continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      opts[key] = val;
      i++;
    }
  }
  return { opts, flags };
}

// Load rvmark.config.json. Keys mirror the CLI flags (content/out/theme/template/
// assets/customTypes/includeDrafts/port). Paths resolve relative to the config
// file's own directory, so a site is portable regardless of where it's built from.
// Note: mount path is deliberately NOT configurable — it is baked into generated
// hrefs and the content output subdir, so changing it would break every link.
function loadConfigFile(path) {
  const file = readFileSync(path, 'utf8');
  let raw;
  try {
    raw = JSON.parse(file);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e.message}`);
  }
  const base = dirname(resolve(path));
  const asPath = (v) => (v == null ? v : isAbsolute(v) ? v : join(base, v));
  return {
    content:      asPath(raw.content),
    out:          asPath(raw.out),
    theme:        asPath(raw.theme),
    head:         asPath(raw.head),
    template:     asPath(raw.template),
    assets:       asPath(raw.assets),
    customTypes:  asPath(raw.customTypes),
    includeDrafts: raw.includeDrafts,
    port:         raw.port,
  };
}

// First non-flag arg is the subcommand (default: build).
const rawArgs = process.argv.slice(2);
const subcommand = (rawArgs[0] && !rawArgs[0].startsWith('--')) ? rawArgs.shift() : 'build';
if (!['build', 'serve'].includes(subcommand)) {
  console.error(`rvmark: unknown subcommand '${subcommand}' (expected 'build' or 'serve')`);
  process.exit(1);
}

const { opts, flags } = parseArgs(rawArgs);

// Resolve config file: explicit --config, else rvmark.config.json in cwd if present.
let fileCfg = {};
if (opts.config !== undefined) {
  fileCfg = loadConfigFile(opts.config);
} else if (existsSync('rvmark.config.json')) {
  fileCfg = loadConfigFile('rvmark.config.json');
}

let config;
if (flags.has('test')) {
  // Engine self-test: build the bundled fixtures into tests/dist.
  config = {
    contentDir: join(ENGINE_ROOT, 'tests/rvmark'),
    outDir:     join(ENGINE_ROOT, 'tests/dist'),
    customTypesDir: join(ENGINE_ROOT, 'tests/custom-types'),
    // Single source template, CSP patched in-memory to allow the http peer.
    templateHtml: testTemplateHtml(),
    includeDrafts: flags.has('includeDrafts'),
  };
} else {
  // Precedence: explicit CLI flag > config file > built-in default.
  config = {
    contentDir: opts.content  ?? fileCfg.content     ?? 'rvmark',
    outDir:     opts.out      ?? fileCfg.out         ?? 'dist',
    theme:      opts.theme    ?? fileCfg.theme       ?? null,
    head:       opts.head     ?? fileCfg.head        ?? null,
    template:   opts.template ?? fileCfg.template    ?? null,
    assetsDir:  opts.assets   ?? fileCfg.assets      ?? null,
    customTypesDir: opts['custom-types'] ?? fileCfg.customTypes ?? null,
    mountPath:  opts.mount    ?? '/_rvmark/',
    includeDrafts: flags.has('includeDrafts') || fileCfg.includeDrafts === true,
  };
}

if (subcommand === 'serve') {
  if (flags.has('test')) {
    console.error("rvmark: --test cannot be combined with 'serve'");
    process.exit(1);
  }

  // --dev: this CLI is running from live engine source (e.g. `npm link`). Recompile
  // the engine (src → out) on EVERY rebuild — `tsc --incremental` makes this nearly
  // free when src/ is unchanged, and guarantees out/ is never stale regardless of
  // whether the triggering change was content or engine source. Each site rebuild
  // runs in a FRESH subprocess so the freshly-compiled engine is actually loaded —
  // the engine modules imported into THIS process won't pick up a recompiled out/.
  const dev = flags.has('dev');
  const engineSrc = join(ENGINE_ROOT, 'src');
  if (dev && !existsSync(engineSrc)) {
    console.error('rvmark: --dev requires running from engine source (src/ not found)');
    process.exit(1);
  }

  // Watch the configured input dirs; the engine's own out/dist is excluded.
  // In --dev mode, also watch engine src/ so engine edits trigger a recompile.
  const watchTargets = [
    config.contentDir,
    config.theme,
    config.head,
    config.assetsDir,
    config.customTypesDir,
    config.template,
    dev ? engineSrc : null,
  ].filter((p) => p && existsSync(p));

  // Reproduce the resolved config as explicit CLI flags for the subprocess build,
  // so --dev rebuilds use identical inputs without re-reading the config file.
  function buildArgv() {
    const a = ['build', '--content', config.contentDir, '--out', config.outDir,
               '--mount', config.mountPath];
    if (config.theme)          a.push('--theme', config.theme);
    if (config.head)           a.push('--head', config.head);
    if (config.template)       a.push('--template', config.template);
    if (config.assetsDir)      a.push('--assets', config.assetsDir);
    if (config.customTypesDir) a.push('--custom-types', config.customTypesDir);
    if (config.includeDrafts)  a.push('--include-drafts');
    return a;
  }

  const rebuild = serializeBuilds((done) => {
    const start = Date.now();
    if (dev) {
      // Recompile engine, then build the site in a fresh process (loads new out/).
      try {
        execSync('npx tsc --incremental', { stdio: 'inherit', cwd: ENGINE_ROOT });
        execSync(`node ${JSON.stringify(fileURLToPath(import.meta.url))} ${buildArgv().map(s => JSON.stringify(s)).join(' ')}`,
                 { stdio: 'inherit' });
        console.log(`  rebuilt in ${Date.now() - start}ms\n`);
      } catch (e) {
        console.error(`  build failed (exit ${e.status ?? '?'})\n`);
      }
      done();
    } else {
      buildSite(config)
        .then(() => console.log(`  rebuilt in ${Date.now() - start}ms\n`))
        .catch((e) => console.error(`  build failed: ${e.message}\n`))
        .finally(done);
    }
  });

  // Initial build before serving. In dev, recompile the engine and build via a
  // fresh subprocess so out/ is fresh from the first serve — the in-process
  // buildSite() already imported the engine and wouldn't see a recompiled out/.
  if (dev) {
    execSync('npx tsc --incremental', { stdio: 'inherit', cwd: ENGINE_ROOT });
    execSync(`node ${JSON.stringify(fileURLToPath(import.meta.url))} ${buildArgv().map(s => JSON.stringify(s)).join(' ')}`,
             { stdio: 'inherit' });
  } else {
    await buildSite(config);
  }

  const port = Number(opts.port ?? fileCfg.port ?? 8000);
  const server = await startServer(config.outDir, port);
  watchPaths(watchTargets, rebuild);

  console.log(`\n  rvmark serving ${config.outDir} → http://localhost:${port}`);
  if (dev) console.log('  --dev: recompiling engine (incremental) on every change');
  console.log(`  watching: ${watchTargets.join(', ') || '(nothing)'}`);
  console.log('  press Ctrl-C to stop\n');

  // OS-agnostic shutdown: SIGINT/SIGTERM both close the server and exit cleanly.
  const shutdown = () => { server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  await buildSite(config);
}
