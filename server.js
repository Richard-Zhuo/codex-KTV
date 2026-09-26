import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/admin': ['admin.html', 'text/html'], '/admin.html': ['admin.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/rules.js': ['rules.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const port = Number(process.env.PORT || 4173);
http.createServer(async (req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(file[0], import.meta.url)));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch { res.writeHead(500); res.end('Unable to load demo'); }
}).listen(port, '0.0.0.0', () => console.log(`KTV demo: http://localhost:${port}`));
