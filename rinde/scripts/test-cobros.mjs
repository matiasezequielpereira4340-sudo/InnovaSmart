// Prueba del circuito de cobro con Mercado Pago SIMULADO (no llama a MP ni a la base real).
// Suscripción → aviso firmado → prueba gratis → cobro aprobado → registro en Pagos → cobro rechazado → aviso duplicado → firma inválida.
// Uso: node scripts/test-cobros.mjs
import crypto from 'node:crypto';

process.env.SUPABASE_URL = 'http://base-falsa.local';
process.env.SUPABASE_SERVICE_KEY = 'prueba';
process.env.MP_ACCESS_TOKEN = 'TEST-123';
process.env.MP_WEBHOOK_SECRET = 'secreto-webhook-prueba';
delete process.env.RESEND_API_KEY; // sin emails en la prueba

// ── Base falsa en memoria (imita PostgREST) ──
const T = { rinde_users: [{ id: 'u1', nickname: 'TIENDA.PRUEBA', plan: 'free', alert_email: 'a@b.c' }], rinde_settings: [], rinde_payments: [], rinde_billing_events: [] };
const match = (row, search) => {
  for (const [k, v] of new URLSearchParams(search)) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.') && String(row[k]) !== decodeURIComponent(v.slice(3))) return false;
    if (v.startsWith('in.(') && !v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(row[k]))) return false;
    if (v === 'is.null' && row[k] != null) return false;
  }
  return true;
};
// ── Mercado Pago falso ──
const MP = {
  preapproval: { id: 'pre_1', status: 'pending', external_reference: null, init_point: 'https://mp.test/checkout/pre_1', next_payment_date: '2026-11-08T12:00:00Z' },
  authorized: {},
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  const res = (status, data) => new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'base-falsa.local') {
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = (T[table] ||= []);
    if (method === 'GET') return res(200, rows.filter((r) => match(r, u.search)));
    if (method === 'PATCH') { const hit = rows.filter((r) => match(r, u.search)); hit.forEach((r) => Object.assign(r, body)); return res(200, hit); }
    if (method === 'DELETE') { T[table] = rows.filter((r) => !match(r, u.search)); return res(204, null); }
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const conflict = u.searchParams.get('on_conflict');
      const out = [];
      for (const b of list) {
        const ex = conflict ? rows.find((r) => conflict.split(',').every((k) => String(r[k]) === String(b[k]))) : null;
        if (ex) { Object.assign(ex, b); out.push(ex); } else { const n = { id: b.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...b }; rows.push(n); out.push(n); }
      }
      return res(201, out);
    }
  }
  if (u.host === 'api.mercadopago.com') {
    if (u.pathname === '/preapproval' && method === 'POST') { Object.assign(MP.preapproval, { external_reference: body.external_reference, auto_recurring: body.auto_recurring, payer_email: body.payer_email }); return res(201, MP.preapproval); }
    if (u.pathname.startsWith('/preapproval/')) return res(200, MP.preapproval);
    if (u.pathname.startsWith('/authorized_payments/')) return res(200, MP.authorized[u.pathname.split('/').pop()]);
    if (u.pathname.startsWith('/v1/payments/')) return res(200, { id: u.pathname.split('/').pop(), status: 'approved', transaction_amount: 15000, payer: { email: 'comprador@test.com', first_name: 'Test', last_name: 'User', identification: { type: 'DNI', number: '12345678' } } });
    return res(404, { message: 'no simulado' });
  }
  return realFetch(url, opts);
};

const { createSubscription, processNotification, verifySignature } = await import('../api/_lib/mp.js');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const user = () => T.rinde_users[0];
const sign = (dataId, requestId = 'req-1', ts = String(Date.now())) => {
  const v1 = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return { signature: `ts=${ts},v1=${v1}`, requestId };
};

// 1) Suscribirse (checkout)
const sub = await createSubscription(user(), { interval: 'monthly', email: 'comprador@test.com', appUrl: 'https://rinde.test' });
ok(sub.init_point === 'https://mp.test/checkout/pre_1', 'Checkout: devuelve el link de pago de Mercado Pago');
ok(MP.preapproval.auto_recurring?.free_trial?.frequency === 3, `Checkout: pide prueba gratis de ${MP.preapproval.auto_recurring?.free_trial?.frequency} días`);
ok(user().mp_preapproval_id === 'pre_1', 'Checkout: guarda la suscripción en el usuario');

// 2) Firma del webhook
const s1 = sign('pre_1');
ok(verifySignature({ signature: s1.signature, requestId: s1.requestId, dataId: 'pre_1', secret: process.env.MP_WEBHOOK_SECRET }), 'Webhook: firma válida se acepta');
ok(!verifySignature({ signature: s1.signature.replace(/v1=./, 'v1=0'), requestId: s1.requestId, dataId: 'pre_1', secret: process.env.MP_WEBHOOK_SECRET }), 'Webhook: firma inválida se rechaza');

// 3) Suscripción autorizada → prueba gratis
MP.preapproval.status = 'authorized';
const r1 = await processNotification({ topic: 'subscription_preapproval', id: 'pre_1' });
ok(user().plan === 'rinde' && user().billing_status === 'trial', `Suscripción autorizada → Plan Rinde en prueba gratis (${r1})`);

// 4) Primer cobro aprobado → activo + pago registrado
MP.authorized.ap_1 = { id: 'ap_1', preapproval_id: 'pre_1', external_reference: MP.preapproval.external_reference, status: 'processed', payment: { id: 'pay_1', status: 'approved' }, transaction_amount: 15000, date_created: new Date().toISOString() };
const r2 = await processNotification({ topic: 'subscription_authorized_payment', id: 'ap_1' });
ok(user().billing_status === 'active', `Cobro aprobado → plan activo (${r2})`);
ok(T.rinde_payments.length === 1 && T.rinde_payments[0].amount === 15000 && !T.rinde_payments[0].invoiced_at, 'Cobro aprobado → aparece en Pagos por facturar ($15.000, sin facturar)');

// 5) Mismo aviso dos veces → no duplica el pago
const r3 = await processNotification({ topic: 'subscription_authorized_payment', id: 'ap_1' });
ok(T.rinde_payments.length === 1, `Aviso repetido → no duplica el pago (${r3})`);

// 6) Cobro rechazado → período de gracia, sin cortar el plan
MP.authorized.ap_2 = { id: 'ap_2', preapproval_id: 'pre_1', external_reference: MP.preapproval.external_reference, status: 'recycling', payment: { id: 'pay_2', status: 'rejected' }, transaction_amount: 15000 };
const r4 = await processNotification({ topic: 'subscription_authorized_payment', id: 'ap_2' });
ok(user().billing_status === 'past_due' && user().plan === 'rinde' && !!user().grace_until, `Cobro rechazado → gracia hasta ${String(user().grace_until).slice(0, 10)}, plan sigue activo (${r4})`);

// 7) Cancelación
MP.preapproval.status = 'cancelled';
const r5 = await processNotification({ topic: 'subscription_preapproval', id: 'pre_1' });
ok(user().billing_status === 'canceled' || /cancel/.test(r5), `Suscripción cancelada (${r5})`);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
