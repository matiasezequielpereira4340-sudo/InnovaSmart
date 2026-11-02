// /api/admin — usuarios, activar/desactivar plan y Validación contra Mercado Libre real.
// Protegido con ADMIN_KEY (header x-admin-key).
import { handler, json, readBody, query, AppError, requireEnv } from './_lib/http.js';
import { safeEqual } from './_lib/crypto.js';
import { db } from './_lib/db.js';
import { getAccessToken, meliRaw, getBillingRaw, pool } from './_lib/meli.js';
import { buildValidationReport, scrub } from '../shared/validation.js';
import { runHealth } from './_lib/health.js';
import { sha256 } from './_lib/crypto.js';

// ── Límite de intentos: 5 fallidos en 15 min bloquean esa IP por 15 min. ──
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60000;
const mem = new Map(); // respaldo si la base no está configurada
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
const dbReady = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

async function getAttempt(h) {
  if (!dbReady()) return mem.get(h) || null;
  try { return await db.one('rinde_admin_attempts', { ip_hash: h }); } catch { return mem.get(h) || null; }
}
async function saveAttempt(row) {
  mem.set(row.ip_hash, row);
  if (dbReady()) { try { await db.upsert('rinde_admin_attempts', [row], 'ip_hash'); } catch {} }
}
async function clearAttempt(h) {
  mem.delete(h);
  if (dbReady()) { try { await db.remove('rinde_admin_attempts', { ip_hash: h }); } catch {} }
}

async function checkKey(req) {
  const h = sha256('rinde-admin|' + ipOf(req)).slice(0, 40);
  const now = Date.now();
  let a = await getAttempt(h);
  if (a?.locked_until && new Date(a.locked_until).getTime() > now) {
    const min = Math.ceil((new Date(a.locked_until).getTime() - now) / 60000);
    throw new AppError(429, `Demasiados intentos fallidos. Probá de nuevo en ${min} minuto(s).`, 'locked');
  }
  if (safeEqual(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    if (a) await clearAttempt(h);
    return;
  }
  if (!a || now - new Date(a.window_start).getTime() > WINDOW_MS) a = { ip_hash: h, fails: 0, window_start: new Date(now).toISOString(), locked_until: null };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.locked_until = new Date(now + WINDOW_MS).toISOString();
  await saveAttempt(a);
  await new Promise((r) => setTimeout(r, 600));
  const left = MAX_FAILS - a.fails;
  throw new AppError(401, left > 0 ? `Clave incorrecta. Te quedan ${left} intento(s).` : 'Clave incorrecta. Bloqueamos el acceso por 15 minutos.', 'bad_key');
}

export const config = { maxDuration: 60 };

async function runValidation(user) {
  const token = await getAccessToken(user.id);
  const ordersCall = await meliRaw(token, `/orders/search?seller=${user.meli_user_id}&order.status=paid&sort=date_desc&limit=10`);
  const orders = ordersCall.status === 200 && Array.isArray(ordersCall.body?.results) ? ordersCall.body.results.slice(0, 10) : [];
  const calls = {};
  await pool(orders, 3, async (o) => {
    const billing = await getBillingRaw(token, o.id);
    const shipment = o.shipping?.id ? await meliRaw(token, `/shipments/${o.shipping.id}/costs`, { 'x-format-new': 'true' }) : { status: null, body: null };
    calls[o.id] = { billing, shipment };
  });
  const items = (await db.select('rinde_items', { user_id: user.id }, { columns: 'data' })).map((r) => r.data);
  const report = buildValidationReport({ orders, calls, items, ordersCall });
  if (ordersCall.status !== 200) report.summary.ordersError = `Mercado Libre respondió ${ordersCall.status} al pedir las ventas.`;
  const raw = scrub({ orders_search: { status: ordersCall.status, body: ordersCall.body }, por_venta: calls });
  const [run] = await db.insert('rinde_validation_runs', [{ user_id: user.id, report, raw }]);
  return { report, raw, id: run?.id, created_at: run?.created_at };
}

export default handler(async (req, res) => {
  requireEnv('ADMIN_KEY');
  await checkKey(req);
  const q = query(req);

  if (req.method === 'GET' && q.view === 'health') return json(res, 200, await runHealth());

  if (req.method === 'GET' && q.view === 'validation') {
    if (!q.user_id) throw new AppError(400, 'Falta elegir el usuario.');
    const last = await db.one('rinde_validation_runs', { user_id: q.user_id }, { order: 'created_at.desc' });
    return json(res, 200, { run: last || null });
  }

  if (req.method === 'GET') {
    const [users, conns] = await Promise.all([
      db.select('rinde_users', {}, { columns: 'id,meli_user_id,nickname,plan,created_at,plan_activated_at,free_diagnosis_used_at,last_login_at,alert_email', order: 'created_at.desc', limit: 1000 }),
      db.select('rinde_connections', {}, { columns: 'user_id,updated_at' }),
    ]);
    const connected = new Set(conns.map((c) => c.user_id));
    return json(res, 200, { users: users.map((u) => ({ ...u, connected: connected.has(u.id) })) });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'validate') {
      const user = await db.one('rinde_users', { id: body.user_id });
      if (!user) throw new AppError(404, 'No existe ese usuario.');
      const out = await runValidation(user);
      return json(res, 200, { run: { report: out.report, raw: out.raw, created_at: out.created_at } });
    }
    const { user_id, plan } = body;
    if (!user_id || !['free', 'rinde'].includes(plan)) throw new AppError(400, 'Pedido inválido.');
    const [u] = await db.update('rinde_users', { id: user_id }, { plan, plan_activated_at: plan === 'rinde' ? new Date().toISOString() : null });
    return json(res, 200, { ok: true, user: u });
  }
  throw new AppError(405, 'Método no permitido.');
});
