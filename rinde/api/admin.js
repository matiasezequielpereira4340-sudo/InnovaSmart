// /api/admin — usuarios, activar/desactivar plan y Validación contra Mercado Libre real.
// Protegido con ADMIN_KEY (header x-admin-key).
import { handler, json, readBody, query, AppError, requireEnv } from './_lib/http.js';
import { safeEqual } from './_lib/crypto.js';
import { db } from './_lib/db.js';
import { getAccessToken, meliRaw, getBillingRaw, pool } from './_lib/meli.js';
import { buildValidationReport, scrub } from '../shared/validation.js';

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
  if (!safeEqual(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    await new Promise((r) => setTimeout(r, 600));
    throw new AppError(401, 'Clave incorrecta.');
  }
  const q = query(req);

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
