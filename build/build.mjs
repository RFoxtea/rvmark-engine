/**
 * build.mjs — compile the engine, then (optionally) build the bundled test
 * fixtures. Consumers of the published package don't run this; they invoke the
 * `rvmark-build` CLI against their own content. This is the engine's own
 * dev/test build.
 *
 * Usage: node build/build.mjs [--test] [--include-drafts]
 *   (no flags) → just compile TypeScript (src → out)
 *   --test     → compile, then build tests/rvmark → tests/dist
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

execSync('npx tsc', { stdio: 'inherit', cwd: ENGINE_ROOT });

if (args.includes('--test')) {
  const passthru = args.filter(a => a === '--test' || a === '--include-drafts').join(' ');
  execSync(`node ${join(ENGINE_ROOT, 'bin/rvmark.mjs')} ${passthru}`, { stdio: 'inherit', cwd: ENGINE_ROOT });
}
