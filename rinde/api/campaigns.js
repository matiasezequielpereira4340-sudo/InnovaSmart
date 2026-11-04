// GET /api/campaigns — Campañas y publicidad: ¿conviene o no? (solo Plan Rinde, SOLO LECTURA).
// Lee de MeLi las campañas ofrecidas/activas y Product Ads, les suma el contexto de cada publicación
// (costo, envío, retenciones, temporada) y devuelve todo listo para calcular. Caché de 6 h (?refresh=1 fuerza).
import { handler, json, query, AppError } from './_lib/http.js';
import { currentUser, isPaid } from './_lib/users.js';
import { db } from './_lib/db.js';
import { getAccessToken } from './_lib/meli.js';
import { loadAccount } from './_lib/sync.js';
import { readCampaigns, readFees } from './_lib/campaigns-meli.js';
import { costKey } from '../shared/model.js';
import { seasonInfo } from '../shared/rules.js';
import { evaluateAll, actionsByItem, feeKey as keyFee } from '../shared/campaigns.js';

export const config = { maxDuration: 60 };
const TTL = 6 * 3600000;

export default handler(async (req, res) => {
  const u = await currentUser(req);
  if (!isPaid(u)) throw new AppError(402, 'Disponible en Plan Rinde.', 'plan_required');
  const q = query(req);
  const cacheKey = `campaigns:${u.id}`;
  const cached = (await db.one('rinde_settings', { key: cacheKey }))?.value;
  if (cached && !q.refresh && Date.now() - new Date(cached.fetched_at).getTime() < TTL) return json(res, 200, cached);

  const token = await getAccessToken(u.id, req);
  const raw = await readCampaigns(token, u.meli_user_id);
  const { data } = await loadAccount(u.id);
  const items = Object.fromEntries(data.items.map((it) => [it.id, it]));

  // Retenciones y costo de envío por venta, desde las ventas reales (facturación).
  const lines = data.lines || [];
  const rev = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const tax = lines.reduce((s, l) => s + (l.fees?.taxes || 0), 0);
  const taxRate = rev > 0 ? tax / rev : 0;
  const shipBy = {};
  for (const l of lines) if (l.fees?.shipping > 0) { const x = (shipBy[l.item_id] ||= { s: 0, q: 0 }); x.s += l.fees.shipping; x.q += l.qty; }
  const allShip = Object.values(shipBy).reduce((a, x) => ({ s: a.s + x.s, q: a.q + x.q }), { s: 0, q: 0 });
  const avgShip = allShip.q ? allShip.s / allShip.q : null;

  const ctxItem = (id, priceHint) => {
    const it = items[id];
    if (!it) return null;
    const c = data.costs[costKey(it)];
    const season = seasonInfo(it);
    return {
      title: it.title, permalink: it.permalink || null, sku: costKey(it), price: priceHint || it.price, listing_type: it.listing_type, category_id: it.category_id,
      offersFreeShipping: !!it.shipping?.free_shipping, shipCost: shipBy[id] ? shipBy[id].s / shipBy[id].q : avgShip ?? 0, shipEstimated: !shipBy[id],
      cost: c?.purchase != null && c.purchase !== '' ? Number(c.purchase) : null,
      outOfSeason: !!season, seasonName: season?.season || null,
    };
  };
  const offers = raw.offers.map((o) => {
    const item = ctxItem(o.item_id);
    return { ...o, price_today: o.price_today || item?.price || null, item };
  }).filter((o) => o.item);
  const ads = raw.ads.map((a) => ({ ...a, item: ctxItem(a.item_id) })).filter((a) => a.item);

  // Cargos reales de MeLi a cada precio (hoy y con promo).
  const combos = new Map();
  const addCombo = (it, p) => { if (p) { const k = keyFee(it.listing_type, it.category_id, p); combos.set(k, { key: k, price: p, listing_type: it.listing_type, category_id: it.category_id }); } };
  for (const o of offers) { addCombo(o.item, o.price_today); addCombo(o.item, o.promo_price); }
  for (const a of ads) addCombo(a.item, a.item.price);
  const fees = await readFees(token, [...combos.values()]);

  const out = { offers, ads, taxRate, fees, errors: raw.errors, hasAdvertiser: raw.hasAdvertiser, fetched_at: new Date().toISOString() };
  const ev = evaluateAll(out);
  out.summary = ev.summary;
  out.actions = actionsByItem(ev);
  await db.upsert('rinde_settings', [{ key: cacheKey, value: out, updated_at: out.fetched_at }], 'key');
  json(res, 200, out);
});
