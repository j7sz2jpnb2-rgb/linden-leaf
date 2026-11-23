// scripts/preview-server.mjs
// Lightweight, zero-dependency HTTP server for real-time local preview of Linden Leaf.
// Allows running the latest ES module frontend in Chrome/Edge without CORS issues,
// without requiring full Rust / Cargo compilation.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 18420;
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`
]);
const BLOCKED_EXTENSIONS = new Set(['.jks', '.keystore', '.p12', '.pfx', '.key', '.pem', '.db', '.sqlite', '.sqlite3', '.exe']);
const BLOCKED_BASENAMES = new Set(['keystore.properties', 'key.properties', 'credentials.json']);

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const server = http.createServer((req, res) => {
  // Restrict CORS strictly to same-origin local preview origins
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(origin && !ALLOWED_ORIGINS.has(origin) ? 403 : 204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  let pathname;
  try {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    pathname = decodeURIComponent(parsedUrl.pathname).replace(/\\/g, '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const filePath = path.resolve(rootDir, pathname.replace(/^\/+/, ''));
  const rel = path.relative(rootDir, filePath);

  // Path traversal, dotfile/dotdir (.git, .env, .local, etc.), and secret file guard
  const segments = rel.split(/[\\/]/).filter(Boolean);
  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (
    rel.startsWith('..') ||
    path.isAbsolute(rel) ||
    segments.some(seg => seg.startsWith('.')) ||
    BLOCKED_BASENAMES.has(basename) ||
    BLOCKED_EXTENSIONS.has(ext)
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: Invalid file path');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[PreviewServer] Linden Leaf real-time preview server running at:`);
  console.log(`  http://127.0.0.1:${PORT}/index.html`);
});
