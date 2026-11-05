// Servidor local que imita a Vercel: archivos estáticos (cleanUrls), rewrites de vercel.json y /api/*.
// Uso: node scripts/dev-server.mjs   (puerto 3000 o PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const PORT = Number(process.env.PORT || 3000);
process.env.NODE_ENV ||= 'development';

// .env.local opcional
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.csv': 'text/csv', '.ico': 'image/x-icon', '.txt': 'text/plain' };

function rewrite(pathname) {
  for (const r of cfg.rewrites || []) {
    const keys = [];
    const re = new RegExp('^' + r.source.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = pathname.match(re);
    if (m) {
      let dest = r.destination;
      keys.forEach((k, i) => { dest = dest.replace(`:${k}`, m[i + 1]); });
      return dest;
    }
  }
  return pathname;
}

function addVercelHelpers(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return res; };
  res.send = (b) => { res.end(b); return res; };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Igual que Vercel: con cleanUrls, un rewrite (o un pedido) a .html no se sirve.
  const rewritten = rewrite(url.pathname);
  if (cfg.cleanUrls && /\.html$/.test(rewritten) && !url.pathname.startsWith('/api/')) {
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('NOT_FOUND (como Vercel: con cleanUrls el destino no puede terminar en .html)');
  }
  const dest = new URL(rewritten, url);
  const query = Object.fromEntries([...url.searchParams, ...dest.searchParams]);
  const p = dest.pathname;
  try {
    if (p.startsWith('/api/')) {
      const file = path.join(root, p.replace(/\/$/, '') + '.js');
      if (!file.startsWith(path.join(root, 'api')) || path.basename(file).startsWith('_') || !fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"No existe"}'); }
      const mod = await import(pathToFileURL(file).href + `?t=${fs.statSync(file).mtimeMs}`);
      req.query = query;
      addVercelHelpers(res);
      return await mod.default(req, res);
    }
    let file = path.join(root, decodeURIComponent(p));
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    const rel = path.relative(root, file);
    if (!fs.existsSync(file) || /^(api|scripts|supabase|node_modules)\b|^\./.test(rel) || rel.endsWith('.md') || rel === 'package.json' || rel === 'vercel.json') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><meta charset="utf-8"><title>No encontrado</title><p style="font-family:sans-serif">Página no encontrada. <a href="/">Volver a Rinde</a></p>');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end('{"error":"Error del servidor local"}'); }
  }
});
server.listen(PORT, () => console.log(`Rinde local → http://localhost:${PORT}  (demo: /demo · admin: /admin?demo=1)`));
