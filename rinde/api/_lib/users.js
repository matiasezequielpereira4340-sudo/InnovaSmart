import { AppError } from './http.js';
import { db } from './db.js';
import { requireSession } from './session.js';

export const isPaid = (u) => u?.plan === 'rinde';

export async function currentUser(req) {
  const s = requireSession(req);
  const u = await db.one('rinde_users', { id: s.userId });
  if (!u) throw new AppError(401, 'No encontramos tu cuenta. Volvé a conectar Mercado Libre.', 'no_user');
  return u;
}

export function requirePaid(u, what = 'Esta función') {
  if (!isPaid(u)) throw new AppError(402, `${what} es parte del Plan Rinde ($15.000/mes).`, 'plan_required');
}

export function publicUser(u) {
  const s = u.settings || {};
  return {
    nickname: u.nickname,
    plan: u.plan,
    created_at: u.created_at,
    free_diagnosis_used: !!u.free_diagnosis_used_at,
    can_regenerate: isPaid(u) || !u.free_diagnosis_used_at,
    alert_email: u.alert_email || '',
    alerts_enabled: u.alerts_enabled !== false,
    weekly_enabled: u.weekly_enabled !== false,
    ads_manual_monthly: s.ads_manual_monthly || 0,
    meta_ads_monthly: s.meta_ads_monthly || 0,
  };
}
