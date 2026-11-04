// Planes y reglas de cobro de Rinde. Código puro (sin red) para poder probarlo.

export const DEFAULT_BILLING = {
  monthly_price: 15000,
  annual_price: 150000,
  annual_valid_until: '2026-12-31',
  trial_days: 3,
  grace_days: 5,
  remind_days_before: 5,
  bank: { holder: '', cuit: '', bank: '', cbu: '', alias: '' },
  whatsapp: '5491160374306',
};

export const INTERVAL_LABEL = { monthly: 'Mensual', annual: 'Anual' };
const DAY = 86400000;

export function mergeBilling(saved) {
  const s = saved || {};
  return { ...DEFAULT_BILLING, ...s, bank: { ...DEFAULT_BILLING.bank, ...(s.bank || {}) } };
}

export function priceOf(cfg, interval) {
  return interval === 'annual' ? Number(cfg.annual_price) : Number(cfg.monthly_price);
}

/** Suma 1 mes o 12 meses a una fecha (respeta fin de mes). */
export function addInterval(dateIso, interval) {
  const d = new Date(dateIso);
  const months = interval === 'annual' ? 12 : 1;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

export const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * DAY).toISOString();
export const daysBetween = (a, b) => Math.ceil((new Date(b).getTime() - new Date(a).getTime()) / DAY);

/** Referencia que viaja a Mercado Pago para saber de quién es cada suscripción. */
export const makeRef = (userId, interval) => `rinde:${userId}:${interval}`;
export function parseRef(ref) {
  const m = /^rinde:([0-9a-zA-Z-]+):(monthly|annual)$/.exec(String(ref || ''));
  return m ? { userId: m[1], interval: m[2] } : null;
}

// ─────────────────────────── Transiciones de estado ─────────────────────────
// Cada función devuelve el "patch" a guardar en rinde_users. Nunca borra datos.

/** Suscripción con tarjeta autorizada: arranca la prueba gratis. */
export function onSubscriptionAuthorized(u, { interval, preapprovalId, trialDays, now, nextPaymentDate }) {
  const alreadyPaid = u.billing_status === 'active' && u.plan_expires_at && new Date(u.plan_expires_at) > new Date(now);
  if (alreadyPaid) return { mp_preapproval_id: preapprovalId, payment_method: 'mp', plan_interval: interval };
  const trialEnd = nextPaymentDate || addDays(now, trialDays);
  return {
    plan: 'rinde', plan_interval: interval, payment_method: 'mp', mp_preapproval_id: preapprovalId,
    billing_status: 'trial', plan_expires_at: addDays(trialEnd, 1), grace_until: null,
    plan_activated_at: u.plan_activated_at || now,
  };
}

/** Cobro aprobado (tarjeta o transferencia): activa o reactiva y extiende el vencimiento. */
export function onPaymentApproved(u, { interval, paidAt, method, until }) {
  const base = u.plan_expires_at && new Date(u.plan_expires_at) > new Date(paidAt) && u.billing_status === 'active' ? u.plan_expires_at : paidAt;
  return {
    plan: 'rinde', plan_interval: interval, payment_method: method, billing_status: method === 'transfer' ? 'manual' : 'active',
    plan_expires_at: until || addInterval(base, interval), grace_until: null, plan_activated_at: u.plan_activated_at || paidAt,
  };
}

/** Cobro rechazado: 5 días de gracia (si ya estaba en gracia, no la estira). */
export function onPaymentFailed(u, { now, graceDays }) {
  if (u.billing_status === 'past_due' && u.grace_until) return {};
  return { billing_status: 'past_due', grace_until: addDays(now, graceDays) };
}

/** Suscripción cancelada o pausada en MP: sigue hasta que vence lo pagado. */
export function onSubscriptionCanceled() {
  return { billing_status: 'canceled' };
}

/**
 * Pasada diaria. Devuelve { patch, notices } con los avisos a mandar por email.
 * notices: 'expiring_soon' | 'expires_today' | 'grace_started' | 'lapsed'
 */
export function dailyBillingCheck(u, { now, cfg }) {
  const notices = [];
  if (u.plan !== 'rinde' || !u.plan_expires_at) return { patch: {}, notices };
  const nowMs = new Date(now).getTime();
  const exp = new Date(u.plan_expires_at).getTime();
  // Fechas en hora de Argentina (UTC-3) para que "vence hoy" sea el día correcto
  const arDay = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
  const today = arDay(nowMs);
  const expDay = arDay(exp);

  // Período de gracia vencido → plan gratis (sin borrar nada)
  if (u.billing_status === 'past_due' && u.grace_until && new Date(u.grace_until).getTime() <= nowMs) {
    return { patch: { plan: 'free', billing_status: 'lapsed', grace_until: null }, notices: ['lapsed'] };
  }
  // Transferencia: avisos 5 días antes y el día que vence
  if (u.payment_method === 'transfer' && u.billing_status === 'manual') {
    const left = daysBetween(today, expDay);
    if (left === cfg.remind_days_before) notices.push('expiring_soon');
    if (left === 0) notices.push('expires_today');
  }
  // Vencido sin pago nuevo → arranca la gracia (con tarjeta damos 2 días de margen a que llegue el aviso de MP)
  const limit = u.payment_method === 'mp' ? exp + 2 * DAY : exp;
  if (limit <= nowMs && ['manual', 'active', 'trial', 'canceled'].includes(u.billing_status)) {
    if (u.billing_status === 'canceled') return { patch: { plan: 'free', billing_status: 'lapsed', grace_until: null }, notices: ['lapsed'] };
    return { patch: { billing_status: 'past_due', grace_until: addDays(now, cfg.grace_days) }, notices: [...notices, 'grace_started'] };
  }
  return { patch: {}, notices };
}

/** Lo que ve el usuario en la app. */
export function billingSummary(u) {
  return {
    plan: u.plan,
    interval: u.plan_interval || null,
    status: u.billing_status || null,
    method: u.payment_method || null,
    expires_at: u.plan_expires_at || null,
    grace_until: u.grace_until || null,
  };
}


/**
 * Qué puede hacer el usuario con el diagnóstico según el plan que manda el servidor.
 * Con Plan Rinde NUNCA se muestra "Ya usaste tu diagnóstico gratis".
 */
export function regenState({ demo = false, paid = false, user = null } = {}) {
  const rinde = !!paid || user?.plan === 'rinde';
  const canRegen = !!demo || rinde || !!user?.can_regenerate;
  return { rinde, canRegen, showFreeUsed: !canRegen && !rinde };
}

/** ¿Cambió el plan respecto de lo que tiene cargado la página? (para releer sin esperar a que recargue). */
export function planChanged(currentPaid, me) {
  if (!me?.user) return false;
  return (me.user.plan === 'rinde') !== !!currentPaid;
}
