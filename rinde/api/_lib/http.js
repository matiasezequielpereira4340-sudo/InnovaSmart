// Utilidades HTTP para las funciones serverless (Vercel, Node).

export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

export function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  const secure = process.env.NODE_ENV === 'development' || process.env.RINDE_INSECURE_COOKIES ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
}

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; }
    }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

export function query(req) {
  if (req.query) return req.query;
  const u = new URL(req.url, 'http://x');
  return Object.fromEntries(u.searchParams.entries());
}

export function appUrl(req) {
  if (process.env.RINDE_APP_URL) return process.env.RINDE_APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new AppError(503, `Rinde todavía no está configurado en este servidor (faltan: ${missing.join(', ')}). Probá el modo demo mientras tanto.`, 'not_configured');
}

/** Envuelve un handler: errores siempre en JSON y en castellano, nunca pantallas en blanco. */
export function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[rinde]', e);
      const message = e instanceof AppError || e.name === 'MeliError'
        ? e.message
        : 'Algo falló de nuestro lado. Reintentá en unos minutos.';
      if (!res.headersSent) json(res, status, { error: message, code: e.code || 'error' });
      else res.end();
    }
  };
}

export function method(req, ...allowed) {
  if (!allowed.includes(req.method)) throw new AppError(405, 'Método no permitido.', 'method');
}
