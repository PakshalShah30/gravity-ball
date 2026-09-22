/**
 * A zero-dependency static file server, so `npm start` needs nothing but Node.
 *
 * The game is pure static files, but ES modules refuse to load from file://
 * (browsers block them for CORS reasons), so *some* server is required. This
 * one exists so that "some server" is never a roadblock: no npm install, no
 * Python, no third-party package — `node tools/serve.mjs` and you're playing.
 *
 * Usage: node tools/serve.mjs [port]   (default 8080, or env PORT)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// fileURLToPath rather than import.meta.dirname: that property needs Node
// 20.11+, and package.json promises Node 18.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

/** Browsers refuse module scripts unless JS is served with a JS MIME type. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);

    if (pathname.endsWith('/')) pathname += 'index.html';

    // Containment check: the resolved path must stay inside the project root,
    // so ../ traversal can never read files outside it.
    const filePath = resolve(normalize(join(ROOT, pathname)));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store', // always serve the code you just edited
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 — not found. (Serving the Gravity Ball project root.)');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  GRAVITY BALL');
  console.log(`  -> http://localhost:${PORT}`);
  console.log('');
  console.log('  Mouse to move · click / Space to flip gravity · P pause · M mute');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
