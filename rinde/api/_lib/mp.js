// Mercado Pago: suscripciones (preapproval), firma del webhook y aplicación de los cobros.
import crypto from 'node:crypto';
import { db } from './db.js';
import { AppError } from './http.js';
import { sendEmail, billingEmail } from './email.js';
import { EMAIL_ENABLED } from '../../shared/config.js';
import {
  mergeBilling, priceOf, makeRef, parseRef, INTERVAL_LABEL,
  onSubscriptionAuthorized, onPaymentApproved, onPaymentFailed, onSubscriptionCanceled,
} from '../../shared/plans.js';

const API = 'https://api.mercadopago.com';

export const mpConfigured = () => !!(process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.trim());
export const mpIsTest = () => /^TEST-/.test(process.env.MP_ACCESS_TOKEN || '') || process.env.MP_MODE === 'test';

async function mp(path, { method = 'GET', body } = {}) {
  if (!mpConfigured()) throw new AppError(503, 'El cobro con tarjeta todavía no está habilitado. Podés pagar por transferencia.', 'mp_not_configured');
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(method === 'POST' ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[rinde][mp]', method, path, r.status, data?.message || data?.error);
    const e = new AppError(r.status >= 500 ? 503 : 502, 'Mercado Pago no respondió bien. Reintentá en unos minutos o pagá por transferencia.', 'mp');
    e.mpStatus = r.status;
    e.mpBody = data;
    throw e;
  }
  return data;
}

// ─────────────────────────────── Configuración ─────────────────────────────
export async function getBillingConfig() {
  try {
    const row = await db.one('rinde_settings', { key: 'billing' });
    return mergeBilling(row?.value);
  } catch {
    return mergeBilling(null);
  }
}

export async function saveBillingConfig(cfg) {
  await db.upsert('rinde_settings', [{ key: 'billing', value: cfg, updated_at: new Date().toISOString() }], 'key');
}

// ─────────────────────────────── Checkout ──────────────────────────────────
/** Crea la suscripción con prueba gratis y devuelve el link de pago de MP. */
export async function createSubscription(user, { interval, email, appUrl }) {
  const cfg = await getBillingConfig();
  const amount = priceOf(cfg, interval);
  const body = {
    reason: `Rinde · Plan ${INTERVAL_LABEL[interval]}`,
    external_reference: makeRef(user.id, interval),
    payer_email: email,
    back_url: `${appUrl}/suscribirme?estado=listo`,
    status: 'pending',
    auto_recurring: {
      frequency: interval === 'annual' ? 12 : 1,
      frequency_type: 'months',
      transaction_amount: amount,
      currency_id: 'ARS',
      free_trial: { frequency: Number(cfg.trial_days) || 3, frequency_type: 'days' },
    },
  };
  const sub = await mp('/preapproval', { method: 'POST', body });
  await db.update('rinde_users', { id: user.id }, { billing_email: email, mp_preapproval_id: sub.id, plan_interval: interval });
  return { init_point: sub.init_point || sub.sandbox_init_point, id: sub.id };
}

export async function cancelSubscription(preapprovalId) {
  return mp(`/preapproval/${preapprovalId}`, { method: 'PUT', body: { status: 'cancelled' } });
}

// ─────────────────────────────── Webhook ───────────────────────────────────
/**
 * Verifica la firma de MP (header x-signature: "ts=...,v1=...").
 * Plantilla oficial: "id:{data.id};request-id:{x-request-id};ts:{ts};" con HMAC-SHA256 y la clave secreta del webhook.
 */
export function verifySignature({ signature, requestId, dataId, secret }) {
  if (!secret || !signature) return false;
  const parts = Object.fromEntries(String(signature).split(',').map((p) => p.trim().split('=').map((x) => x.trim())));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const id = dataId != null && /^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : dataId;
  let manifest = '';
  if (id != null && id !== '') manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function userFor({ ref, preapprovalId }) {
  const parsed = parseRef(ref);
  if (parsed) {
    const u = await db.one('rinde_users', { id: parsed.userId });
    if (u) return { user: u, interval: parsed.interval };
  }
  if (preapprovalId) {
    const u = await db.one('rinde_users', { mp_preapproval_id: preapprovalId });
    if (u) return { user: u, interval: u.plan_interval || 'monthly' };
  }
  return { user: null, interval: null };
}

async function patchUser(u, patch) {
  if (!Object.keys(patch).length) return u;
  const [row] = await db.update('rinde_users', { id: u.id }, patch);
  return row || { ...u, ...patch };
}

async function notify(u, kind, extra = {}) {
  const to = u.billing_email || u.alert_email || u.email;
  if (!EMAIL_ENABLED || !to || !process.env.RESEND_API_KEY) return false; // sin dominio: los avisos de cobro se ven en el panel
  try {
    const cfg = await getBillingConfig();
    await sendEmail({ to, ...billingEmail(kind, { user: u, cfg, appUrl: process.env.RINDE_APP_URL || '', ...extra }) });
    return true;
  } catch (e) {
    console.error('[rinde][mp] email', kind, e.message);
    return false;
  }
}

/** Registra un pago aprobado sin duplicar (external_id único). Devuelve true si es nuevo. */
async function recordPayment(row) {
  if (row.external_id) {
    const ex = await db.one('rinde_payments', { external_id: row.external_id });
    if (ex) return false;
  }
  await db.insert('rinde_payments', [row]);
  return true;
}

async function payerOf(paymentId) {
  if (!paymentId) return {};
  try {
    const p = await mp(`/v1/payments/${paymentId}`);
    const name = [p.payer?.first_name, p.payer?.last_name].filter(Boolean).join(' ') || null;
    const doc = p.payer?.identification?.number ? `${p.payer.identification.type || ''} ${p.payer.identification.number}`.trim() : null;
    return { name, email: p.payer?.email || null, doc, status: p.status, amount: p.transaction_amount, date: p.date_approved || p.date_created, ref: p.external_reference, preapproval: p.metadata?.preapproval_id || p.point_of_interaction?.transaction_data?.subscription_id || null };
  } catch {
    return {};
  }
}

/** Aplica una notificación de MP. Siempre vuelve a consultar el recurso a MP (no confía en el cuerpo). */
export async function processNotification({ topic, id }) {
  const cfg = await getBillingConfig();
  const now = new Date().toISOString();

  if (topic === 'subscription_preapproval' || topic === 'preapproval') {
    const sub = await mp(`/preapproval/${id}`);
    const { user, interval } = await userFor({ ref: sub.external_reference, preapprovalId: sub.id });
    if (!user) return 'sin usuario';
    if (sub.status === 'authorized') {
      const was = user.billing_status;
      const u2 = await patchUser(user, onSubscriptionAuthorized(user, { interval, preapprovalId: sub.id, trialDays: cfg.trial_days, now, nextPaymentDate: sub.next_payment_date }));
      if (was !== 'trial' && u2.billing_status === 'trial') await notify(u2, 'trial_started');
      return `suscripción autorizada (${u2.billing_status})`;
    }
    if (sub.status === 'cancelled' || sub.status === 'paused') {
      await patchUser(user, onSubscriptionCanceled());
      return `suscripción ${sub.status}`;
    }
    return `suscripción ${sub.status}`;
  }

  if (topic === 'subscription_authorized_payment' || topic === 'authorized_payment') {
    const ap = await mp(`/authorized_payments/${id}`);
    const { user, interval } = await userFor({ ref: ap.external_reference, preapprovalId: ap.preapproval_id });
    if (!user) return 'sin usuario';
    const payStatus = ap.payment?.status || ap.status;
    if (payStatus === 'approved') {
      const payer = await payerOf(ap.payment?.id);
      const paidAt = ap.debit_date || ap.date_created || now;
      const isNew = await recordPayment({
        user_id: user.id, source: 'mp', external_id: `mp:${ap.payment?.id || ap.id}`, status: 'approved',
        amount: Number(ap.transaction_amount || payer.amount || priceOf(cfg, interval)), plan_interval: interval, paid_at: paidAt,
        customer_name: payer.name || user.nickname, customer_email: payer.email || user.billing_email || user.alert_email, customer_doc: payer.doc,
      });
      if (!isNew) return 'pago ya registrado';
      const wasPastDue = user.billing_status === 'past_due' || user.billing_status === 'lapsed';
      const u2 = await patchUser(user, onPaymentApproved(user, { interval, paidAt, method: 'mp' }));
      if (wasPastDue) await notify(u2, 'reactivated');
      return 'cobro aprobado';
    }
    if (['rejected', 'cancelled'].includes(payStatus) || ap.status === 'recycling') {
      if (user.billing_status === 'past_due') return 'cobro rechazado (ya en gracia)';
      const u2 = await patchUser(user, onPaymentFailed(user, { now, graceDays: cfg.grace_days }));
      await notify(u2, 'payment_failed');
      return 'cobro rechazado: empieza la gracia';
    }
    return `cobro ${payStatus}`;
  }

  if (topic === 'payment') {
    const p = await payerOf(id);
    const { user, interval } = await userFor({ ref: p.ref, preapprovalId: p.preapproval });
    if (!user) return 'pago sin usuario de Rinde';
    if (p.status === 'approved') {
      const isNew = await recordPayment({
        user_id: user.id, source: 'mp', external_id: `mp:${id}`, status: 'approved', amount: Number(p.amount || priceOf(cfg, interval)),
        plan_interval: interval, paid_at: p.date || now, customer_name: p.name || user.nickname, customer_email: p.email || user.billing_email, customer_doc: p.doc,
      });
      if (!isNew) return 'pago ya registrado';
      const wasPastDue = user.billing_status === 'past_due' || user.billing_status === 'lapsed';
      const u2 = await patchUser(user, onPaymentApproved(user, { interval, paidAt: p.date || now, method: 'mp' }));
      if (wasPastDue) await notify(u2, 'reactivated');
      return 'pago aprobado';
    }
    return `pago ${p.status || 'sin estado'}`;
  }
  return 'tema ignorado';
}

/** Activación manual por transferencia desde el admin. */
export async function activateTransfer(user, { interval, until, amount, paidAt, note }) {
  const cfg = await getBillingConfig();
  const when = paidAt || new Date().toISOString();
  await recordPayment({
    user_id: user.id, source: 'transfer', external_id: null, status: 'approved', amount: Number(amount) || priceOf(cfg, interval),
    plan_interval: interval, paid_at: when, customer_name: user.nickname, customer_email: user.billing_email || user.alert_email || user.email, note: note || null,
  });
  const wasPastDue = user.billing_status === 'past_due' || user.billing_status === 'lapsed';
  const u2 = await patchUser(user, onPaymentApproved(user, { interval, paidAt: when, method: 'transfer', until: until ? new Date(`${until}T23:59:00-03:00`).toISOString() : null }));
  if (wasPastDue) await notify(u2, 'reactivated');
  return u2;
}

export { notify as notifyBilling, patchUser };

export async function mpHealth() {
  if (!mpConfigured()) return { ok: false, detail: 'Falta MP_ACCESS_TOKEN. Sin esto solo se puede pagar por transferencia.' };
  try {
    const me = await mp('/users/me');
    const test = mpIsTest() || /^TEST/i.test(me.nickname || '') || me.tags?.includes('test_user');
    const secret = !!(process.env.MP_WEBHOOK_SECRET && process.env.MP_WEBHOOK_SECRET.trim());
    return {
      ok: secret,
      detail: `Cuenta ${me.nickname || me.id} (${me.site_id || '—'}) · ${test ? 'MODO PRUEBA' : 'modo real'}${secret ? '' : ' · falta MP_WEBHOOK_SECRET: sin esto no se activan los planes solos'}`,
    };
  } catch (e) {
    return { ok: false, detail: e.mpStatus === 401 ? 'El Access Token de Mercado Pago no es válido.' : 'Mercado Pago no respondió.' };
  }
}
