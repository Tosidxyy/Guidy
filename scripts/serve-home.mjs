import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'home', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path = join(path, 'index.html');
  const file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(5180, '127.0.0.1', () => console.log('Guidy home preview: http://127.0.0.1:5180/'));