// Import and export page. From impExp-web: node serve.js
// Serves this folder on all interfaces, port 5501. Leave the admin page on port 5500 alone.
// API_BASE is read from impExp-web/.env and injected into index.html.
// An empty or missing value falls back to http://localhost:3000.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5501;
const ROOT = __dirname;
const DEFAULT_API = 'http://localhost:3000';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readApiBase() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch (err) {
    return DEFAULT_API;
  }
  let value = '';
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'API_BASE') continue;
    value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return value || DEFAULT_API;
}

function injectApiBase(html) {
  const script = `<script>window.PLANITVIBE_API_BASE = ${JSON.stringify(readApiBase())};</script>`;
  const marker = '<script src="app.js"></script>';
  if (html.includes(marker)) return html.replace(marker, `${script}\n  ${marker}`);
  return `${html}\n${script}`;
}

function fileFor(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  if (!rel || rel.split(/[/\\]/).some((part) => !part || part.startsWith('.'))) return null;
  const full = path.resolve(ROOT, ...rel.split(/[/\\]/));
  const relative = path.relative(ROOT, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const file = fileFor(decodeURIComponent(url.pathname));
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad path');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      const missing = err.code === 'ENOENT' || err.code === 'EISDIR';
      res.writeHead(missing ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(missing ? 'Not found' : 'Server error');
      return;
    }
    let payload = body;
    if (path.basename(file).toLowerCase() === 'index.html') {
      payload = Buffer.from(injectApiBase(body.toString('utf8')), 'utf8');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': payload.length });
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`impExp-web listening on port ${PORT}`);
});
