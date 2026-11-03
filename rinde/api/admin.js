// /api/admin — usuarios, activar/desactivar plan y Validación contra Mercado Libre real.
// Protegido con ADMIN_KEY (header x-admin-key).
import { handler, json, readBody, query, AppError, requireEnv } from './_lib/http.js';
import { safeEqual } from './_lib/crypto.js';
import { db } from './_lib/db.js';
import { getAccessToken, meliRaw, getBillingRaw, getSettlementRaw, pool } from './_lib/meli.js';
import { buildValidationReport, attachSettlements, scrub } from '../shared/validation.js';
import { loadAccount, getJob, startJob, step, progressOf } from './_lib/sync.js';
import { buildModel, buildRuleSummary } from '../shared/model.js';
import { runHealth } from './_lib/health.js';
import { sha256 } from './_lib/crypto.js';
import { getBillingConfig, saveBillingConfig, activateTransfer } from './_lib/mp.js';
import { mergeBilling } from '../shared/plans.js';

const yearStartAR = () => new Date(`${new Date(Date.now() - 3 * 3600000).getUTCFullYear()}-01-01T00:00:00-03:00`).toISOString();
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

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
    // Liquidación real de cada pago de la venta (solo lectura).
    const settlements = [];
    for (const p of (o.payments || []).filter((x) => x?.id)) settlements.push({ payment_id: p.id, raw: await getSettlementRaw(token, p.id) });
    calls[o.id] = { billing, shipment, settlements };
  });
  const items = (await db.select('rinde_items', { user_id: user.id }, { columns: 'data' })).map((r) => r.data);
  const report = buildValidationReport({ orders, calls, items, ordersCall });
  // "Te quedó" que muestra Rinde (lo guardado en la sincronización) vs lo que liquidó Mercado Pago.
  const stored = orders.length ? await db.select('rinde_orders', { user_id: user.id, order_id: orders.map((o) => String(o.id)) }, { columns: 'order_id,fees,fees_source' }) : [];
  const storedBy = Object.fromEntries(stored.map((r) => [r.order_id, r]));
  attachSettlements(report, calls, storedBy);
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

  if (req.method === 'GET' && q.view === 'billing') return json(res, 200, { config: await getBillingConfig() });

  if (req.method === 'GET' && q.view === 'payments') {
    const all = await db.select('rinde_payments', {}, { order: 'paid_at.desc', limit: 5000 });
    const ys = yearStartAR();
    const year = all.filter((p) => p.status === 'approved' && p.paid_at >= ys);
    const yearTotal = year.reduce((t, p) => t + Number(p.amount || 0), 0);
    const list = q.filter === 'todos' ? all : all.filter((p) => !p.invoiced_at);
    if (q.format === 'csv') {
      const rows = [['cliente', 'email', 'documento', 'monto', 'fecha', 'medio', 'plan', 'facturado'].join(';'),
        ...list.map((p) => [p.customer_name, p.customer_email, p.customer_doc, String(p.amount).replace('.', ','), new Date(p.paid_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }), p.source === 'mp' ? 'Mercado Pago' : 'Transferencia', p.plan_interval === 'annual' ? 'Anual' : 'Mensual', p.invoiced_at ? 'sí' : 'no'].map(csvCell).join(';'))];
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="rinde-pagos.csv"');
      return res.end('\uFEFF' + rows.join('\n'));
    }
    return json(res, 200, { payments: list, yearTotal, yearCount: year.length, pending: all.filter((p) => !p.invoiced_at).length });
  }

  if (req.method === 'GET' && q.view === 'account') {
    // Facturación real y control del estimado de una cuenta (solo lectura, con lo ya sincronizado).
    if (!q.user_id) throw new AppError(400, 'Falta elegir el usuario.');
    const { data, job } = await loadAccount(q.user_id);
    if (!job || job.status !== 'done') return json(res, 200, { ready: false, sync: job ? progressOf(job) : null });
    const m = buildModel(data);
    const rule = buildRuleSummary(m);
    return json(res, 200, {
      ready: true,
      syncedAt: job.finished_at,
      has180: !!data.revenue,
      revenue: m.revenue,
      lostTotal: m.lostTotal,
      sanity: m.sanity,
      counts: m.counts,
      headline: rule.headline,
      problems: rule.problems.map((p) => ({ label: p.label, detail: p.detail })),
      abandoned: m.abandoned?.count || 0,
    });
  }

  if (req.method === 'GET' && q.view === 'validation') {
    if (!q.user_id) throw new AppError(400, 'Falta elegir el usuario.');
    const last = await db.one('rinde_validation_runs', { user_id: q.user_id }, { order: 'created_at.desc' });
    return json(res, 200, { run: last || null });
  }

  if (req.method === 'GET') {
    const [users, conns] = await Promise.all([
      db.select('rinde_users', {}, { columns: 'id,meli_user_id,nickname,plan,created_at,plan_activated_at,free_diagnosis_used_at,last_login_at,alert_email,billing_email,plan_interval,plan_expires_at,billing_status,grace_until,payment_method', order: 'created_at.desc', limit: 1000 }),
      db.select('rinde_connections', {}, { columns: 'user_id,updated_at' }),
    ]);
    const connected = new Set(conns.map((c) => c.user_id));
    return json(res, 200, { users: users.map((u) => ({ ...u, connected: connected.has(u.id) })) });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'billing_config') {
      const c = mergeBilling(body.config);
      const n = (v) => Math.round(Number(String(v).replace(/[^0-9.]/g, '')));
      c.monthly_price = n(c.monthly_price);
      c.annual_price = n(c.annual_price);
      c.trial_days = Math.max(0, Math.min(30, n(c.trial_days)));
      if (!(c.monthly_price > 0) || !(c.annual_price > 0)) throw new AppError(400, 'Los precios tienen que ser mayores a cero.');
      if (c.annual_valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(c.annual_valid_until)) throw new AppError(400, 'La fecha tiene que ser AAAA-MM-DD.');
      await saveBillingConfig(c);
      return json(res, 200, { ok: true, config: c });
    }
    if (body.action === 'transfer') {
      const user = await db.one('rinde_users', { id: body.user_id });
      if (!user) throw new AppError(404, 'No existe ese usuario.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.until || '')) throw new AppError(400, 'Elegí la fecha de vencimiento.');
      const u2 = await activateTransfer(user, { interval: body.interval === 'annual' ? 'annual' : 'monthly', until: body.until, amount: body.amount, note: body.note });
      return json(res, 200, { ok: true, user: u2 });
    }
    if (body.action === 'invoiced') {
      const [p] = await db.update('rinde_payments', { id: body.payment_id }, { invoiced_at: body.value === false ? null : new Date().toISOString() });
      return json(res, 200, { ok: true, payment: p });
    }
    if (body.action === 'resync') {
      // Vuelve a leer la cuenta desde MeLi (solo lectura) y regenera el diagnóstico SIN gastar el gratis.
      const user = await db.one('rinde_users', { id: body.user_id });
      if (!user) throw new AppError(404, 'No existe ese usuario.');
      let job = body.start ? await startJob(user.id) : await getJob(user.id);
      if (!job) job = await startJob(user.id);
      const t0 = Date.now();
      while (job.status !== 'done' && Date.now() - t0 < 45000) {
        job = await step(user.id, user.meli_user_id);
        if (job.status === 'error') break;
      }
      if (job.status !== 'done') return json(res, 200, { done: false, sync: progressOf(job) });
      const { data } = await loadAccount(user.id);
      const m = buildModel(data);
      const summary = { ...buildRuleSummary(m), regenerated_by_admin: true };
      await db.insert('rinde_diagnoses', [{ user_id: user.id, input_hash: 'admin-' + Date.now(), summary, tokens_used: 0, sync_finished_at: job.finished_at, counts: m.counts }]);
      return json(res, 200, { done: true, sync: progressOf(job), headline: summary.headline, revenue: m.revenue, lostTotal: m.lostTotal, sanity: m.sanity });
    }
    if (body.action === 'validate') {
      const user = await db.one('rinde_users', { id: body.user_id });
      if (!user) throw new AppError(404, 'No existe ese usuario.');
      const out = await runValidation(user);
      return json(res, 200, { run: { report: out.report, raw: out.raw, created_at: out.created_at } });
    }
    const { user_id, plan } = body;
    if (!user_id || !['free', 'rinde'].includes(plan)) throw new AppError(400, 'Pedido inválido.');
    const [u] = await db.update('rinde_users', { id: user_id }, plan === 'rinde'
      ? { plan, plan_activated_at: new Date().toISOString() }
      : { plan, billing_status: 'canceled', grace_until: null });
    return json(res, 200, { ok: true, user: u });
  }
  throw new AppError(405, 'Método no permitido.');
});
