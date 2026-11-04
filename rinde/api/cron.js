// GET /api/cron — lo llama Vercel Cron una vez por día (protegido con CRON_SECRET).
// 1) Recalcula cada cuenta paga y manda email SOLO si hay alertas nuevas.
// 2) Los lunes, además, manda el resumen semanal.
import { handler, json, appUrl, AppError, query } from './_lib/http.js';
import { syncAlerts } from './_lib/alerts.js';
import { EMAIL_ENABLED } from '../shared/config.js';
import { connectionUsable } from './_lib/meli.js';
import { safeEqual } from './_lib/crypto.js';
import { db } from './_lib/db.js';
import { startJob, step, loadAccount } from './_lib/sync.js';
import { buildModel, buildRuleSummary } from '../shared/model.js';
import { dailyAlertEmail, weeklyEmail, sendEmail } from './_lib/email.js';
import { getBillingConfig, notifyBilling, patchUser } from './_lib/mp.js';
import { dailyBillingCheck } from '../shared/plans.js';

/** Vencimientos, gracia y avisos de cobro. No borra datos: como mucho pasa a plan gratis. */
async function billingPass(nowIso) {
  const cfg = await getBillingConfig();
  const users = await db.select('rinde_users', { plan: 'rinde' }, { limit: 2000 });
  const out = [];
  for (const u of users) {
    const { patch, notices } = dailyBillingCheck(u, { now: nowIso, cfg });
    let u2 = await patchUser(u, patch);
    const sent = { ...(u.settings?.billing_notices || {}) };
    const today = nowIso.slice(0, 10);
    for (const n of notices) {
      if (sent[n] === today) continue;
      if (await notifyBilling(u2, n)) sent[n] = today;
    }
    if (notices.length) u2 = await patchUser(u2, { settings: { ...(u2.settings || {}), billing_notices: sent } });
    if (Object.keys(patch).length || notices.length) out.push({ user: u.nickname, cambios: patch, avisos: notices });
  }
  return out;
}

export const config = { maxDuration: 300 };
const BUDGET_MS = 270000;

export default handler(async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || !safeEqual(auth, `Bearer ${process.env.CRON_SECRET}`)) throw new AppError(401, 'No autorizado.');
  const t0 = Date.now();
  const base = appUrl(req);
  const q = query(req);
  const isMonday = q.job === 'weekly' || new Date().getUTCDay() === 1;

  const nowIso = q.now && process.env.NODE_ENV === 'development' ? new Date(q.now).toISOString() : new Date().toISOString();
  let billing = [];
  try { billing = await billingPass(nowIso); } catch (e) { console.error('[rinde][cron] cobros', e.message); billing = [{ error: e.message }]; }
  // Solo conexiones usables: con refresh token, o con el token todavía vigente. Las vencidas sin refresh
  // token no se intentan (quedan marcadas "hay que reconectar" y la app se lo avisa al usuario).
  const conns = await db.select('rinde_connections', {}, { columns: 'user_id,expires_at,refresh_token_enc' });
  const connected = new Set(conns.filter((c) => connectionUsable(c, 15 * 60000)).map((c) => c.user_id));
  // Solo cuentas con Mercado Libre conectado (quien desconectó conserva sus datos, pero no se sincroniza).
  const users = (await db.select('rinde_users', { plan: 'rinde' }, { order: 'last_cron_at.asc.nullsfirst', limit: 200 })).filter((u) => connected.has(u.id));
  const report = [];
  for (const u of users) {
    if (Date.now() - t0 > BUDGET_MS) { report.push({ user: u.nickname, skipped: 'sin tiempo, sigue mañana' }); continue; }
    try {
      // Re-sincronizar (pasos hasta terminar o quedarnos sin tiempo)
      await startJob(u.id);
      let job;
      do { job = await step(u.id, u.meli_user_id); } while (job.status === 'running' && Date.now() - t0 < BUDGET_MS);
      if (job.status !== 'done') { report.push({ user: u.nickname, skipped: 'sync incompleta' }); continue; }

      const fresh = await db.one('rinde_users', { id: u.id });
      const { data } = await loadAccount(u.id);
      const model = buildModel(data);
      const { nuevas } = await syncAlerts(u.id, model); // quedan en el panel como no leídas
      let sent = false;
      if (EMAIL_ENABLED && nuevas.length && fresh.alerts_enabled !== false && fresh.alert_email) {
        await sendEmail({ to: fresh.alert_email, ...dailyAlertEmail({ nickname: fresh.nickname, alerts: nuevas, appUrl: base }) });
        await db.update('rinde_alerts', { user_id: u.id, key: nuevas.map((a) => a.key), resolved_at: null }, { emailed_at: new Date().toISOString() });
        sent = true;
      }
      const lastWeekly = fresh.settings?.last_weekly_at ? new Date(fresh.settings.last_weekly_at).getTime() : 0;
      if (EMAIL_ENABLED && isMonday && fresh.weekly_enabled !== false && fresh.alert_email && Date.now() - lastWeekly > 5 * 86400000) {
        const diag = await db.one('rinde_diagnoses', { user_id: u.id }, { order: 'created_at.desc' });
        await sendEmail({ to: fresh.alert_email, ...weeklyEmail({ nickname: fresh.nickname, model, summary: { ...(diag?.summary || {}), ...buildRuleSummary(model), first: diag?.summary?.first || buildRuleSummary(model).first }, appUrl: base }) });
        await db.update('rinde_users', { id: u.id }, { settings: { ...(fresh.settings || {}), last_weekly_at: new Date().toISOString() } });
      }
      await db.update('rinde_users', { id: u.id }, { last_cron_at: new Date().toISOString() });
      report.push({ user: u.nickname, nuevas: nuevas.length, sent });
    } catch (e) {
      console.error('[rinde][cron]', u.nickname, e.message);
      report.push({ user: u.nickname, error: e.message });
    }
  }
  json(res, 200, { ok: true, weekly: isMonday, billing, report });
});
