/**
 * build.mjs — compile the engine, then (optionally) build the bundled test
 * fixtures. Consumers of the published package don't run this; they invoke the
 * `rvmark` CLI against their own content. This is the engine's own
 * dev/test build.
 *
 * Usage: node build/build.mjs [--test] [--include-drafts]
 *   (no flags) → just compile TypeScript (src → out)
 *   --test     → compile, then build tests/rvmark → tests/dist
 */

import { execSync } from 'child_process';
import { readdirSync, rmSync, existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit', cwd: ENGINE_ROOT });
execSync('npx tsc', { stdio: 'inherit', cwd: ENGINE_ROOT });
pruneOut(join(ENGINE_ROOT, 'src'), join(ENGINE_ROOT, 'out'));

if (args.includes('--test')) {
  const passthru = args.filter(a => a === '--test' || a === '--include-drafts').join(' ');
  execSync(`node ${join(ENGINE_ROOT, 'bin/rvmark.mjs')} ${passthru}`, { stdio: 'inherit', cwd: ENGINE_ROOT });
}

// tsc never deletes the output of a source file that has been removed or
// renamed, so out/ accumulates orphans that the site build then bundles into
// _engine/. A stale module can outlive its own replacement — exhibit.js survived
// the sidepanel rename this way. Drop any emitted file whose .ts is gone.
function pruneOut(srcDir, outDir) {
  if (!existsSync(outDir)) return;
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    const outPath = join(outDir, entry.name);
    if (entry.isDirectory()) {
      pruneOut(join(srcDir, entry.name), outPath);
      // A directory emptied by pruning has no source counterpart left either.
      if (readdirSync(outPath).length === 0) rmSync(outPath, { recursive: true });
      continue;
    }
    // .js/.d.ts/.js.map all derive from one .ts; strip whichever suffix applies.
    const stem = entry.name.replace(/\.(js|d\.ts|js\.map|d\.ts\.map)$/, '');
    if (stem === entry.name) continue;  // not a tsc artifact — leave it alone
    if (existsSync(join(srcDir, `${stem}.ts`))) continue;
    rmSync(outPath);
    console.log(`pruned stale ${relative(ENGINE_ROOT, outPath)}`);
  }
}
