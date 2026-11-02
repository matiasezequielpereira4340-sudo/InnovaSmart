// /api/mp-webhook — notificaciones de Mercado Pago (suscripciones y pagos). Verifica la firma.
import { handler, json, readBody, query } from './_lib/http.js';
import { db } from './_lib/db.js';
import { verifySignature, processNotification } from './_lib/mp.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 200, { ok: true });
  const q = query(req);
  const body = await readBody(req);
  const topic = q.type || q.topic || body.type || body.topic || '';
  const id = q['data.id'] || body?.data?.id || q.id || body.id;

  const ok = verifySignature({
    signature: req.headers['x-signature'],
    requestId: req.headers['x-request-id'],
    dataId: q['data.id'] ?? body?.data?.id,
    secret: process.env.MP_WEBHOOK_SECRET,
  });
  const log = async (result, error = null) => {
    try { await db.insert('rinde_billing_events', [{ topic, resource_id: id ? String(id) : null, payload: { query: q, body }, result, error }]); } catch {}
  };
  if (!ok) {
    await log('rechazado', 'firma inválida');
    return json(res, 401, { error: 'firma inválida' });
  }
  if (!id) { await log('ignorado', 'sin id'); return json(res, 200, { ok: true }); }
  try {
    const result = await processNotification({ topic, id: String(id) });
    await log(result);
    return json(res, 200, { ok: true, result });
  } catch (e) {
    await log('error', e.message);
    // 500 para que Mercado Pago reintente más tarde
    return json(res, 500, { error: 'reintentar' });
  }
});
