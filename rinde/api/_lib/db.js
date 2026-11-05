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

// Tablas con datos de un usuario: cualquier cambio o borrado tiene que llevar su user_id (o id en rinde_users).
const USER_SCOPED = new Set(['rinde_connections', 'rinde_sync_jobs', 'rinde_items', 'rinde_orders', 'rinde_costs', 'rinde_ai_plans', 'rinde_diagnoses', 'rinde_alerts', 'rinde_validation_runs', 'rinde_suggestions']);

/**
 * Protección: nunca se ejecuta un UPDATE o DELETE sin filtro. Si el filtro viene vacío, con valores vacíos
 * o (en tablas de usuario) sin el usuario, tira error y no toca nada.
 */
export function assertSafeFilter(table, match, op) {
  const entries = Object.entries(match || {});
  const bad = (v) => v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v)) || (Array.isArray(v) && (!v.length || v.some((x) => x === undefined || x === null || x === '')));
  if (!entries.length) throw new AppError(500, `Bloqueado: ${op} en ${table} sin filtro.`, 'unsafe_write');
  const empty = entries.filter(([, v]) => bad(v)).map(([k]) => k);
  if (empty.length) throw new AppError(500, `Bloqueado: ${op} en ${table} con filtro vacío (${empty.join(', ')}).`, 'unsafe_write');
  if (!entries.some(([, v]) => v !== null)) throw new AppError(500, `Bloqueado: ${op} en ${table} solo con filtros nulos.`, 'unsafe_write');
  const owner = table === 'rinde_users' ? 'id' : 'user_id';
  if ((USER_SCOPED.has(table) || table === 'rinde_users') && (match[owner] == null || Array.isArray(match[owner]))) {
    throw new AppError(500, `Bloqueado: ${op} en ${table} sin un ${owner} único.`, 'unsafe_write');
  }
}
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
  /** Igual que select pero trae TODO, de a 1000 (Supabase corta en 1000 filas por consulta). */
  async selectAll(table, match = {}, { columns = '*', order, max = 50000 } = {}) {
    const out = [];
    for (let offset = 0; offset < max; offset += 1000) {
      let q = `${table}?select=${columns}`;
      const f = filters(match);
      if (f) q += `&${f}`;
      q += `&order=${order || 'id.asc'}&limit=1000&offset=${offset}`;
      const rows = (await call(q)) || [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
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
    assertSafeFilter(table, match, 'UPDATE');
    return call(`${table}?${filters(match)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  },
  async remove(table, match) {
    assertSafeFilter(table, match, 'DELETE');
    return call(`${table}?${filters(match)}`, { method: 'DELETE' });
  },
};
