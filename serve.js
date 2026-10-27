// serve.js — BeamSketch lokal starten: node serve.js [port]   (Node.js 18 oder neuer, keine Pakete)
// Liefert nur die Dateien dieses Ordners aus. Web Serial (USB zum Laser) braucht eine sichere
// Herkunft: http://localhost zählt dazu, für andere Rechner im Netz braucht es HTTPS.
const http = require('http'), fs = require('fs'), path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const DIRS = ['js', 'css', 'fonts', 'devices', 'vendor'];

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { p = ''; }
  if (p === '/' || p === '/app') p = '/index.html';
  const parts = p.split('/').filter(Boolean);
  const ok = parts.length && !parts.some(x => x.startsWith('.') || x.includes('\\') || x.includes('\0'))
    && (p === '/index.html' || DIRS.includes(parts[0]));
  const file = path.join(root, ...parts);
  if (!ok || !file.startsWith(root + path.sep)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}).listen(port, host, () => console.log(`BeamSketch: http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`));
