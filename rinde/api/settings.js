// GET  /api/settings — configuración de alertas + historial.
// POST /api/settings — guarda email/preferencias, o {action:'test'} manda un email de prueba.
import { handler, json, readBody, appUrl, AppError } from './_lib/http.js';
import { currentUser, requirePaid, publicUser } from './_lib/users.js';
import { db } from './_lib/db.js';
import { sendEmail, dailyAlertEmail } from './_lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default handler(async (req, res) => {
  const u = await currentUser(req);
  if (req.method === 'GET') {
    const history = await db.select('rinde_alerts', { user_id: u.id }, { order: 'created_at.desc', limit: 50 });
    return json(res, 200, { user: publicUser(u), history });
  }
  requirePaid(u, 'Las alertas por email');
  const body = await readBody(req);
  if (body.action === 'test') {
    if (!u.alert_email) throw new AppError(400, 'Primero guardá un email.');
    const mail = dailyAlertEmail({ nickname: u.nickname, appUrl: appUrl(req), alerts: [{ kind: 'preguntas', severity: 'warn', title: 'Email de prueba', message: 'Si ves esto, las alertas de Rinde te van a llegar bien.' }] });
    try { await sendEmail({ to: u.alert_email, ...mail }); } catch (e) { console.error(e); throw new AppError(502, 'No pudimos mandar el email. Revisá la dirección o reintentá más tarde.'); }
    return json(res, 200, { ok: true });
  }
  const email = String(body.alert_email || '').trim();
  if (email && !EMAIL_RE.test(email)) throw new AppError(400, 'Ese email no parece válido.');
  await db.update('rinde_users', { id: u.id }, { alert_email: email || null, alerts_enabled: !!body.alerts_enabled, weekly_enabled: !!body.weekly_enabled });
  json(res, 200, { ok: true });
});
