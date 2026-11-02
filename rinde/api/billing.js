// /api/billing — planes públicos, checkout con Mercado Pago y cancelación.
import { handler, json, readBody, appUrl, AppError, method } from './_lib/http.js';
import { getSession } from './_lib/session.js';
import { currentUser } from './_lib/users.js';
import { db } from './_lib/db.js';
import { getBillingConfig, createSubscription, cancelSubscription, mpConfigured, mpIsTest } from './_lib/mp.js';
import { billingSummary } from '../shared/plans.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const cfg = await getBillingConfig();
    let me = null;
    const s = getSession(req);
    if (s) {
      try {
        const u = await db.one('rinde_users', { id: s.userId });
        if (u) me = { nickname: u.nickname, email: u.billing_email || u.alert_email || u.email || '', ...billingSummary(u) };
      } catch {}
    }
    return json(res, 200, {
      monthly_price: cfg.monthly_price,
      annual_price: cfg.annual_price,
      annual_valid_until: cfg.annual_valid_until,
      trial_days: cfg.trial_days,
      grace_days: cfg.grace_days,
      bank: cfg.bank,
      whatsapp: cfg.whatsapp,
      mp_enabled: mpConfigured(),
      mp_test: mpConfigured() && mpIsTest(),
      me,
    });
  }

  method(req, 'POST');
  const u = await currentUser(req);
  const body = await readBody(req);

  if (body.action === 'checkout') {
    const interval = body.interval === 'annual' ? 'annual' : 'monthly';
    const email = String(body.email || '').trim();
    if (!EMAIL_RE.test(email)) throw new AppError(400, 'Poné el email de tu cuenta de Mercado Pago.');
    if (u.plan === 'rinde' && ['active', 'trial'].includes(u.billing_status) && u.payment_method === 'mp') {
      throw new AppError(409, 'Ya tenés el Plan Rinde activo con tarjeta.');
    }
    const out = await createSubscription(u, { interval, email, appUrl: appUrl(req) });
    return json(res, 200, out);
  }

  if (body.action === 'cancel') {
    if (!u.mp_preapproval_id) throw new AppError(400, 'No tenés una suscripción con tarjeta.');
    await cancelSubscription(u.mp_preapproval_id);
    await db.update('rinde_users', { id: u.id }, { billing_status: 'canceled' });
    return json(res, 200, { ok: true });
  }

  throw new AppError(400, 'Pedido inválido.');
});
