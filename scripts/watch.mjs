/**
 * watch.mjs — watch paths for changes, then re-run a build command.
 *
 * Generic across consumers: pass the watch targets and the rebuild command so
 * the same watcher serves both the engine's own dev loop and a content site.
 *
 * Usage:
 *   node watch.mjs --watch <path> [--watch <path> ...] -- <build cmd...>
 *
 * Each --watch path may be a file or a directory (watched recursively).
 * Everything after `--` is the rebuild command (argv-style).
 *
 * Example (site):
 *   node watch.mjs --watch rvmark --watch theme.css -- npx rvmark-build --content rvmark --theme theme.css --out dist
 */

import { watch } from 'fs';
import { spawn } from 'child_process';

const argv = process.argv.slice(2);
const watchTargets = [];
let cmd = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--watch') { watchTargets.push(argv[++i]); continue; }
  if (argv[i] === '--') { cmd = argv.slice(i + 1); break; }
}

if (watchTargets.length === 0 || cmd.length === 0) {
  console.error('watch.mjs: need at least one --watch <path> and a `-- <build cmd>`');
  process.exit(1);
}

let building = false;
let queued   = false;

function build() {
  if (building) { queued = true; return; }
  building = true;
  const start = Date.now();
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  child.on('close', (code) => {
    const ms = Date.now() - start;
    if (code === 0) {
      console.log(`  rebuilt in ${ms}ms\n`);
    } else {
      console.error(`  build failed (exit ${code}) in ${ms}ms\n`);
    }
    building = false;
    if (queued) {
      queued = false;
      build();
    }
  });
}

// Debounce: coalesce rapid changes into a single rebuild
let timer = null;
function onChange(eventType, filename) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`  change detected: ${filename || '(unknown)'}`);
    build();
  }, 100);
}

for (const target of watchTargets) {
  try { watch(target, { recursive: true }, onChange); } catch (_) {}
}

console.log('Watching for changes...\n');
