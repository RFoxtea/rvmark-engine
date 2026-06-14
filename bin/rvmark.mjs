#!/usr/bin/env node
/**
 * rvmark-build — CLI for the rvmark static site generator.
 *
 * Usage:
 *   rvmark-build --content <dir> --out <dir> [--theme <file>] [--template <file>]
 *                [--assets <dir>] [--custom-types <dir>] [--mount <path>] [--include-drafts]
 *   rvmark-build --test            # build the engine's own test fixtures
 *
 * Defaults: --content rvmark  --out dist
 */

import { buildSite } from '../build/build-rvmark.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
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

const { opts, flags } = parseArgs(process.argv.slice(2));

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
  config = {
    contentDir: opts.content  ?? 'rvmark',
    outDir:     opts.out      ?? 'dist',
    theme:      opts.theme    ?? null,
    template:   opts.template ?? null,
    assetsDir:  opts.assets   ?? null,
    customTypesDir: opts['custom-types'] ?? null,
    mountPath:  opts.mount    ?? '/_rvmark/',
    includeDrafts: flags.has('includeDrafts'),
  };
}

await buildSite(config);
