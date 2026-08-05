/**
 * Local dev server. Serves the static site and routes /api/* to the same
 * handlers Vercel runs in production, so local behaviour matches deployed.
 *
 *   node tools/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2]) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webmanifest': 'application/manifest+json'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(url, req, res);
  }

  // Strip the leading slash and block traversal outside the project root.
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (!extname(rel)) rel += '.html';

  const filePath = join(ROOT, normalize(rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

async function handleApi(url, req, res) {
  const name = url.pathname.replace('/api/', '').replace(/\.js$/, '');
  try {
    const mod = await import(`../api/${name}.js?t=${Date.now()}`);
    req.query = Object.fromEntries(url.searchParams);
    await mod.default(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'handler_failed', message: String(err?.message || err) }));
  }
}

server.listen(PORT, () => {
  console.log(`SimBrief Briefing dev server -> http://localhost:${PORT}`);
});
