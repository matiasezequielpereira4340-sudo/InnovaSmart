// GET /api/me — estado de la sesión, plan y progreso de la última sincronización.
import { handler, json } from './_lib/http.js';
import { currentUser, publicUser } from './_lib/users.js';
import { getJob, progressOf } from './_lib/sync.js';
import { db } from './_lib/db.js';
import { connectionStatus } from './_lib/meli.js';

export default handler(async (req, res) => {
  const u = await currentUser(req);
  const [job, diag, conn] = await Promise.all([
    getJob(u.id),
    db.one('rinde_diagnoses', { user_id: u.id }, { columns: 'id,created_at', order: 'created_at.desc' }),
    db.one('rinde_connections', { user_id: u.id }, { columns: 'expires_at,refresh_token_enc' }),
  ]);
  json(res, 200, { user: { ...publicUser(u), connection: connectionStatus(conn) }, sync: job ? progressOf(job) : null, diagnosis: diag ? { created_at: diag.created_at } : null });
});
