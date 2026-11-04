// Relectura de DATOS PÚBLICOS de publicaciones para una cuenta desconectada, sin pedirle que reconecte.
// Usa el token de OTRA cuenta conectada de la app SOLO para endpoints públicos de lectura:
//   /items?ids= (multiget), /items/{id}/description, /categories/{id}, /categories/{id}/attributes.
// Nunca pide órdenes, visitas, facturación, preguntas ni nada privado de la cuenta.
// Solo actualiza campos públicos de la publicación (atributos, descripción, fotos, video, máximo de título);
// no toca ventas, facturación ni nada más de lo guardado.
import { db } from './db.js';
import * as meli from './meli.js';
import { audit } from './audit.js';
import { AppError } from './http.js';

const KEY = (userId) => `public_refresh:${userId}`;
const BATCH = 20;

async function pickDonor(targetId, preferId = null) {
  // Cualquier conexión de la app con token vigente (o renovable). Primero la que ya se venía usando.
  const conns = await db.select('rinde_connections', {}, { columns: 'user_id,updated_at,expires_at,refresh_token_enc', order: 'updated_at.desc', limit: 50 });
  const usable = conns.filter((x) => meli.connectionUsable(x, 2 * 60000));
  const c = usable.find((x) => x.user_id === preferId) || usable.find((x) => x.user_id !== targetId) || usable[0];
  if (!c) {
    const soon = conns.map((x) => x.expires_at).sort().pop();
    throw new AppError(409, `No hay ninguna cuenta con conexión vigente en la app para leer los datos públicos${soon ? ` (la última venció el ${new Date(soon).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })})` : ''}. Conectá cualquier cuenta de Mercado Libre (por ejemplo la tuya) y volvé a tocar el botón.`, 'no_donor');
  }
  return db.one('rinde_users', { id: c.user_id }, { columns: 'id,nickname,meli_user_id' });
}

/**
 * Avanza la relectura hasta ~budgetMs. @returns { done, cursor, total, donor, withAttrs }
 */
export async function publicRefreshStep(targetId, { start = false, req = null, budgetMs = 40000 } = {}) {
  const t0 = Date.now();
  const target = await db.one('rinde_users', { id: targetId }, { columns: 'id,nickname,meli_user_id' });
  if (!target) throw new AppError(404, 'No existe ese usuario.');
  let st = (await db.one('rinde_settings', { key: KEY(targetId) }))?.value || null;
  if (start || !st || st.done) {
    const items = await db.selectAll('rinde_items', { user_id: targetId }, { columns: 'item_id', order: 'item_id.asc' });
    const donor = await pickDonor(targetId);
    st = { ids: items.map((r) => r.item_id), cursor: 0, done: false, donor_id: donor.id, donor_nickname: donor.nickname, started_at: new Date().toISOString(), with_attrs: 0 };
    await audit(req, { event: 'public_refresh', user: target, reason: `inicio · token de ${donor.nickname}`,
      detail: { donor_user_id: donor.id, donor_nickname: donor.nickname, endpoints: ['/items?ids=', '/items/{id}/description', '/categories/{id}', '/categories/{id}/attributes'], items: st.ids.length } });
  }
  // Si la cuenta que prestaba el token venció, se cambia por otra vigente (queda registrado).
  const donorNow = await pickDonor(targetId, st.donor_id);
  if (donorNow.id !== st.donor_id) {
    await audit(req, { event: 'public_refresh', user: target, reason: `cambio de token: ${st.donor_nickname} → ${donorNow.nickname}`, detail: { from: st.donor_id, to: donorNow.id } });
    Object.assign(st, { donor_id: donorNow.id, donor_nickname: donorNow.nickname });
  }
  const token = await meli.getAccessToken(st.donor_id);

  while (st.cursor < st.ids.length && Date.now() - t0 < budgetMs) {
    const ids = st.ids.slice(st.cursor, st.cursor + BATCH);
    const raw = await meli.getItems(token, ids); // público: multiget de a 20
    const cats = await meli.getCategoryAttrs(token, raw.map((b) => b.category_id)).catch(() => ({}));
    const descs = await meli.pool(raw, 3, (b) => meli.getDescriptionLength(token, b.id));
    const byId = Object.fromEntries(raw.map((b, i) => [b.id, { b, desc: descs[i]?.__error ? null : descs[i] }]));
    const rows = await db.select('rinde_items', { user_id: targetId, item_id: ids }, { columns: 'item_id,data,fetched_at' });
    const upd = [];
    for (const r of rows) {
      const x = byId[r.item_id];
      if (!x) continue;
      const n = meli.normalizeItem(x.b);
      const attrs = meli.missingAttrs(x.b, cats[x.b.category_id]);
      if (attrs) st.with_attrs++;
      // Solo campos públicos de la publicación; el resto (ventas, visitas, estado de stock, etc.) queda igual.
      upd.push({ user_id: targetId, item_id: r.item_id, fetched_at: r.fetched_at, data: {
        ...r.data,
        attrs, title_max: cats[x.b.category_id]?.max_title ?? null, desc_len: x.desc,
        pics: n.pics, video: n.video, pictures_count: n.pictures_count,
        public_refreshed_at: new Date().toISOString(), public_refreshed_with: st.donor_nickname,
      } });
    }
    if (upd.length) await db.upsert('rinde_items', upd, 'user_id,item_id');
    st.cursor += ids.length;
    await db.upsert('rinde_settings', [{ key: KEY(targetId), value: st, updated_at: new Date().toISOString() }], 'key');
  }
  if (st.cursor >= st.ids.length && !st.done) {
    st.done = true;
    st.finished_at = new Date().toISOString();
    await db.upsert('rinde_settings', [{ key: KEY(targetId), value: st, updated_at: new Date().toISOString() }], 'key');
    await audit(req, { event: 'public_refresh', user: target, reason: `fin · token de ${st.donor_nickname}`,
      detail: { donor_user_id: st.donor_id, donor_nickname: st.donor_nickname, items: st.ids.length, with_attrs: st.with_attrs } });
  }
  return { done: st.done, cursor: st.cursor, total: st.ids.length, donor: st.donor_nickname, withAttrs: st.with_attrs };
}
