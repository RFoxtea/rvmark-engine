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
 * Explicit flags override values from the config file. Under `serve` the config
 * file is watched: edits reload it and re-arm the watchers ('out' and '--port'
 * excepted — the listener is already bound, so those need a restart).
 *
 * Defaults: --content rvmark  --out dist  --port 8000
 */

import { buildSite } from '../out/build/site.js';
import { watchPaths, serializeBuilds } from '../scripts/watch.mjs';
import { startServer } from '../scripts/static-server.mjs';
import { execSync } from 'child_process';
import { readFileSync, existsSync, statSync } from 'fs';
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
// Held as a path so `serve` can re-read it when it changes.
const configPath = opts.config !== undefined ? opts.config
                 : existsSync('rvmark.config.json') ? 'rvmark.config.json'
                 : null;
let fileCfg = configPath ? loadConfigFile(configPath) : {};

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
  config = resolveConfig(fileCfg);
}

// Precedence: explicit CLI flag > config file > built-in default. A function
// rather than a literal so `serve` can re-resolve after the config file changes
// — flags still win, so a reload can never override what was typed on argv.
function resolveConfig(cfg) {
  return {
    contentDir: opts.content  ?? cfg.content     ?? 'rvmark',
    outDir:     opts.out      ?? cfg.out         ?? 'dist',
    theme:      opts.theme    ?? cfg.theme       ?? null,
    head:       opts.head     ?? cfg.head        ?? null,
    template:   opts.template ?? cfg.template    ?? null,
    assetsDir:  opts.assets   ?? cfg.assets      ?? null,
    customTypesDir: opts['custom-types'] ?? cfg.customTypes ?? null,
    mountPath:  opts.mount    ?? '/_rvmark/',
    includeDrafts: flags.has('includeDrafts') || cfg.includeDrafts === true,
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
  // The config file itself is watched too, so adding or dropping an input (a
  // theme, a head partial) takes effect without a restart. Recomputed on reload
  // because existsSync filtering means a newly-configured path was never armed.
  function currentWatchTargets() {
    return [
      configPath,
      config.contentDir,
      config.theme,
      config.head,
      config.assetsDir,
      config.customTypesDir,
      config.template,
      dev ? engineSrc : null,
    ].filter((p) => p && existsSync(p));
  }
  let watchTargets = currentWatchTargets();

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

  // One build, however triggered. In dev, recompile the engine and build via a
  // fresh subprocess so out/ is fresh — the in-process buildSite() already
  // imported the engine and wouldn't see a recompiled out/.
  function runBuild() {
    const start = Date.now();
    if (dev) {
      try {
        execSync('npx tsc --incremental', { stdio: 'inherit', cwd: ENGINE_ROOT });
        execSync(`node ${JSON.stringify(fileURLToPath(import.meta.url))} ${buildArgv().map(s => JSON.stringify(s)).join(' ')}`,
                 { stdio: 'inherit' });
        console.log(`  rebuilt in ${Date.now() - start}ms\n`);
      } catch (e) {
        console.error(`  build failed (exit ${e.status ?? '?'})\n`);
      }
      return Promise.resolve();
    }
    return buildSite(config)
      .then(() => console.log(`  rebuilt in ${Date.now() - start}ms\n`))
      .catch((e) => console.error(`  build failed: ${e.message}\n`));
  }

  // ONE queue for every build, the initial one included — a second
  // serializeBuilds instance would serialize against nothing. buildSite() wipes
  // outDir before repopulating it, so two overlapping builds leave one deleting
  // the directory the other is writing into (ENOENT on lstat). Each run resolves
  // the waiters registered when it began, so the initial build can be awaited
  // without giving it a private queue.
  let waiters = [];
  const rebuild = serializeBuilds((done) => {
    const settle = waiters;
    waiters = [];
    runBuild().finally(() => {
      done();
      for (const w of settle) w();
    });
  });

  // Initial build before serving, through the shared queue: any watcher event
  // can then only queue behind it, never overlap it.
  await new Promise((resolve) => { waiters.push(resolve); rebuild(); });

  const port = Number(opts.port ?? fileCfg.port ?? 8000);
  const server = await startServer(config.outDir, port);
  // Re-read the config on change, re-resolve, and re-arm the watchers against the
  // new input set. A malformed config (mid-edit JSON) is reported and ignored:
  // the previous good config keeps serving rather than taking the server down.
  let configStamp = stampOf(configPath);
  function stampOf(f) {
    if (!f) return null;
    try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
  }
  function configTouched() {
    const next = stampOf(configPath);
    if (next === configStamp) return false;
    configStamp = next;
    return true;
  }

  let watchers = watchPaths(watchTargets, onChange);
  function onChange() {
    // Match on the file's own mtime rather than the reported filename: fs.watch
    // may report null, and on a file target reports a bare basename, so the name
    // alone cannot be trusted to tell the config apart from a like-named input.
    if (configPath && configTouched()) {
      let next;
      try {
        next = loadConfigFile(configPath);
      } catch (e) {
        console.error(`  config not reloaded: ${e.message}\n`);
        return;                      // keep the last good config; no rebuild
      }
      fileCfg = next;
      const prevOut = config.outDir;
      config = resolveConfig(fileCfg);
      // The server is already bound to a directory and a port; neither can be
      // rehomed under a live listener. Say so rather than build somewhere the
      // server isn't looking.
      if (config.outDir !== prevOut) {
        console.error(`  note: 'out' changed to ${config.outDir}; serving still from ${prevOut} — restart to apply\n`);
        config.outDir = prevOut;
      }
      const retargeted = currentWatchTargets();
      if (retargeted.join('\0') !== watchTargets.join('\0')) {
        for (const w of watchers) w.close();
        watchTargets = retargeted;
        watchers = watchPaths(watchTargets, onChange);
        console.log(`  watching: ${watchTargets.join(', ') || '(nothing)'}`);
      }
    }
    rebuild();
  }

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
