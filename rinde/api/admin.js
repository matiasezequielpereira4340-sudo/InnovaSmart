// /api/admin — lista de usuarios y activar/desactivar Plan Rinde. Protegido con ADMIN_KEY (header x-admin-key).
import { handler, json, readBody, AppError, requireEnv } from './_lib/http.js';
import { safeEqual } from './_lib/crypto.js';
import { db } from './_lib/db.js';

export default handler(async (req, res) => {
  requireEnv('ADMIN_KEY');
  if (!safeEqual(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
    await new Promise((r) => setTimeout(r, 600));
    throw new AppError(401, 'Clave incorrecta.');
  }
  if (req.method === 'GET') {
    const users = await db.select('rinde_users', {}, { columns: 'id,meli_user_id,nickname,plan,created_at,plan_activated_at,free_diagnosis_used_at,last_login_at,alert_email', order: 'created_at.desc', limit: 1000 });
    return json(res, 200, { users });
  }
  if (req.method === 'POST') {
    const { user_id, plan } = await readBody(req);
    if (!user_id || !['free', 'rinde'].includes(plan)) throw new AppError(400, 'Pedido inválido.');
    const [u] = await db.update('rinde_users', { id: user_id }, { plan, plan_activated_at: plan === 'rinde' ? new Date().toISOString() : null });
    return json(res, 200, { ok: true, user: u });
  }
  throw new AppError(405, 'Método no permitido.');
});
