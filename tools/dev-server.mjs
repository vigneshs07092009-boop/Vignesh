/* ============================================================
 * Aevion dev server — zero dependencies, works on every OS.
 *
 *   node tools/dev-server.mjs [port]
 *
 * Serves `aevion/` on http://localhost:8787 (default) AND
 * http://127.0.0.1:8787 — the two names people actually type. Handy for
 * testing the PWA, the service worker and the UI on any OS; on Windows
 * `aevion/serve.ps1` does the same thing and opens a browser.
 *
 * Deliberately minimal: no directory listing, no writes, no cache, and
 * it refuses to serve anything outside `aevion/`.
 * ============================================================ */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'aevion');
const PORT = Number(process.argv[2]) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

// Browsers treat http://localhost and http://127.0.0.1 as two different
// origins — separate storage, separate service worker — even though both
// names are this same machine. Serving on both keeps every door someone
// might open pointed at the one app.
createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const target = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      // no-store so a refresh always shows the file you just edited
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`Aevion serving ${ROOT}`);
  console.log(`  http://127.0.0.1:${PORT}        (canonical - the installed app and the desktop launcher open this)`);
  console.log(`  http://localhost:${PORT}        (same app; its service worker warms its cache from the canonical one)`);
});
