// POST /api/sync — avanza un paso de la sincronización con Mercado Libre y devuelve el progreso.
import { handler, json, readBody, method, AppError } from './_lib/http.js';
import { currentUser, isPaid } from './_lib/users.js';
import { getJob, startJob, step, progressOf, isFresh } from './_lib/sync.js';
import { db } from './_lib/db.js';

export default handler(async (req, res) => {
  method(req, 'POST');
  const u = await currentUser(req);
  const body = await readBody(req);
  let job = await getJob(u.id);

  if (body.start) {
    if (!isPaid(u) && u.free_diagnosis_used_at && job?.status === 'done') {
      throw new AppError(402, 'Ya usaste tu diagnóstico gratis. Con el Plan Rinde lo regenerás cuando quieras.', 'plan_required');
    }
    if (!job || job.status !== 'running') {
      if (!(isFresh(job) && !body.force)) job = await startJob(u.id);
    }
  }
  if (!job) job = await startJob(u.id);
  if (job.status === 'running' || job.status === 'error') job = await step(u.id, u.meli_user_id);
  json(res, 200, { sync: progressOf(job) });
});
