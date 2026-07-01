/**
 * watch.mjs — watch paths for changes, then run a debounced callback.
 *
 * Generic across consumers. Importable as a library (`watchPaths`) so the rvmark
 * CLI can drive an in-process rebuild, and runnable directly as a CLI that spawns
 * an external rebuild command.
 *
 * Library:
 *   import { watchPaths } from './watch.mjs';
 *   watchPaths(['rvmark', 'theme.css'], () => rebuild());
 *
 * CLI:
 *   node watch.mjs --watch <path> [--watch <path> ...] -- <build cmd...>
 *
 * Each watch path may be a file or a directory (watched recursively — recursive
 * fs.watch requires Node >= 20 on Linux; supported on macOS/Windows throughout).
 * Everything after `--` is the rebuild command (argv-style).
 */

import { watch } from 'fs';
import { spawn } from 'child_process';

/**
 * Watch `targets`, calling `onChange` (debounced) when any of them changes.
 * Returns an array of FSWatcher handles so the caller can close them.
 */
export function watchPaths(targets, onChange, { debounceMs = 100 } = {}) {
  let timer = null;
  const handler = (_eventType, filename) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`  change detected: ${filename || '(unknown)'}`);
      onChange(filename);
    }, debounceMs);
  };
  const watchers = [];
  for (const target of targets) {
    try { watchers.push(watch(target, { recursive: true }, handler)); } catch (_) {}
  }
  return watchers;
}

/**
 * Serialize calls to `run` (an async/callback build): never run two at once,
 * coalesce overlapping requests into a single trailing run. `run(done)` must
 * call `done()` when finished.
 */
export function serializeBuilds(run) {
  let building = false;
  let queued   = false;
  function trigger() {
    if (building) { queued = true; return; }
    building = true;
    run(() => {
      building = false;
      if (queued) { queued = false; trigger(); }
    });
  }
  return trigger;
}

// ---- CLI mode: only when executed directly, not when imported. ----
if (import.meta.url === `file://${process.argv[1]}`) {
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

  const build = serializeBuilds((done) => {
    const start = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    child.on('close', (code) => {
      const ms = Date.now() - start;
      if (code === 0) console.log(`  rebuilt in ${ms}ms\n`);
      else            console.error(`  build failed (exit ${code}) in ${ms}ms\n`);
      done();
    });
  });

  watchPaths(watchTargets, build);
  console.log('Watching for changes...\n');
}
