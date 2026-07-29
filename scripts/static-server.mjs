/**
 * static-server.mjs — minimal zero-dependency static file server.
 *
 * Replaces the `http-server` devDependency so `rvmark serve` works from a global
 * CLI install with no per-site node_modules. Pure Node core (http/fs/path), so it
 * is OS-agnostic: paths are normalized through path.posix/sep rather than assuming
 * a separator, and there is no shell-out.
 *
 * Serves `root` on `port`. Directory requests resolve to index.html. Caching is
 * disabled (Cache-Control: no-store) so a dev rebuild is always picked up.
 */

import { createServer } from 'http';
import { createReadStream, promises as fsp } from 'fs';
import { join, normalize, extname, sep } from 'path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  // Served as plain text so "view source" opens in a tab instead of downloading.
  '.rvmark': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function startServer(root, port = 8000) {
  const server = createServer(async (req, res) => {
    try {
      // Decode + strip query/hash, then normalize. Reject path traversal: after
      // normalization the resolved path must stay within root.
      const urlPath = decodeURIComponent((req.url || '/').split(/[?#]/)[0]);
      let filePath = normalize(join(root, urlPath));
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      let stat = await fsp.stat(filePath).catch(() => null);
      if (stat && stat.isDirectory()) {
        filePath = join(filePath, 'index.html');
        stat = await fsp.stat(filePath).catch(() => null);
      }
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolvePromise(server));
  });
}
