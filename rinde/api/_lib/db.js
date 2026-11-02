// Acceso a Supabase vía PostgREST con la service key (solo desde el servidor).
import { AppError } from './http.js';

function base() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new AppError(503, 'La base de datos no está configurada (SUPABASE_URL / SUPABASE_SERVICE_KEY).', 'not_configured');
  return { url: url.replace(/\/$/, '') + '/rest/v1', key };
}

async function call(path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const { url, key } = base();
  const r = await fetch(`${url}/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('[rinde][db]', method, path, r.status, t.slice(0, 300));
    throw new AppError(502, 'No pudimos guardar o leer tus datos. Reintentá en unos minutos.', 'db');
  }
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const enc = (v) => encodeURIComponent(v);
function filters(match = {}) {
  return Object.entries(match).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}=in.(${v.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',')})`;
    if (v === null) return `${k}=is.null`;
    return `${k}=eq.${enc(v)}`;
  }).join('&');
}

export const db = {
  async select(table, match = {}, { columns = '*', order, limit } = {}) {
    let q = `${table}?select=${columns}`;
    const f = filters(match);
    if (f) q += `&${f}`;
    if (order) q += `&order=${order}`;
    if (limit) q += `&limit=${limit}`;
    return (await call(q)) || [];
  },
  async one(table, match, opts) {
    const rows = await db.select(table, match, { ...opts, limit: 1 });
    return rows[0] || null;
  },
  async insert(table, rows) {
    return call(table, { method: 'POST', body: rows, prefer: 'return=representation' });
  },
  async upsert(table, rows, onConflict) {
    if (Array.isArray(rows) && !rows.length) return [];
    return call(`${table}?on_conflict=${onConflict}`, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation' });
  },
  async update(table, match, patch) {
    return call(`${table}?${filters(match)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  },
  async remove(table, match) {
    return call(`${table}?${filters(match)}`, { method: 'DELETE' });
  },
};
