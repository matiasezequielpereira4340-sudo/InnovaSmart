// GET /api/campaigns — Campañas y publicidad: ¿conviene o no? (solo Plan Rinde, SOLO LECTURA).
// Lee de MeLi las campañas ofrecidas/activas y Product Ads, les suma el contexto de cada publicación
// (costo, envío, retenciones, temporada) y devuelve todo listo para calcular. Caché de 6 h (?refresh=1 fuerza).
import { handler, json, query, AppError } from './_lib/http.js';
import { currentUser, isPaid } from './_lib/users.js';
import { db } from './_lib/db.js';
import { getAccessToken, meliRaw } from './_lib/meli.js';
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

  // Lo que pagó cada publicación en su última venta facturada (se compara con listing_prices y se usa el peor).
  // Cuotas: el % más caro que se vio en sus ventas; en Premium, además, el más caro de toda la cuenta en Premium
  // (las cuotas dependen de las que elige el comprador, así que contamos el caso más caro).
  const feeHist = {};
  const finMax = {};
  let premiumFinMax = 0;
  for (const l of [...lines].sort((x, y) => String(y.date).localeCompare(String(x.date)))) {
    if (l.source !== 'facturación' || !l.qty || !l.unit_price) continue;
    const gross = l.qty * l.unit_price;
    const fin = (l.fees?.financing || 0) / gross;
    finMax[l.item_id] = Math.max(finMax[l.item_id] || 0, fin);
    if (items[l.item_id]?.listing_type === 'gold_pro') premiumFinMax = Math.max(premiumFinMax, fin);
    if (feeHist[l.item_id]) continue;
    const fixed = l.fees?.fixed_fee || 0;
    feeHist[l.item_id] = { price: l.unit_price, pct: ((l.fees?.commission || 0) - fixed) / gross, fixed: fixed / l.qty, financingPct: fin };
  }
  for (const id of Object.keys(feeHist)) feeHist[id].financingPct = finMax[id];

  // Avisos de publicidad de publicaciones que no están en lo leído (pausadas o cerradas): leemos tipo y
  // categoría de MeLi (son del propio vendedor, solo lectura) para poder pedir sus cargos.
  const missing = [...new Set(raw.ads.map((a) => a.item_id).filter((id) => id && !items[id]))];
  const extra = {};
  for (let i = 0; i < missing.length; i += 20) {
    const r = await meliRaw(token, `/items?ids=${missing.slice(i, i + 20).join(',')}&attributes=id,title,price,listing_type_id,category_id,permalink,seller_custom_field,status`);
    if (r.status !== 200 || !Array.isArray(r.body)) continue;
    for (const x of r.body) if (x?.code === 200 && x.body?.id) extra[x.body.id] = x.body;
  }

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
      feeHistory: feeHist[id] || null,
      maxFinancingPct: it.listing_type === 'gold_pro' ? Math.max(finMax[id] || 0, premiumFinMax) : 0,
    };
  };
  const offers = raw.offers.map((o) => {
    const item = ctxItem(o.item_id);
    return { ...o, price_today: o.price_today || item?.price || null, item };
  }).filter((o) => o.item);
  // Si la publicación del aviso no está en lo leído (por ejemplo, pausada), usamos lo que dé MeLi de esa publicación
  // o, si no, título y precio de Product Ads. El costo cargado se busca por el mismo código (SKU o número).
  const fallback = (a) => {
    const x = extra[a.item_id] || {};
    const title = x.title || a.title;
    if (!title) return null;
    const sku = (x.seller_custom_field && String(x.seller_custom_field).trim()) || a.item_id;
    const c = data.costs[sku] || data.costs[a.item_id];
    const lt = x.listing_type_id || a.listing_type_id || null;
    return { title, price: Number(x.price || 0) || a.price, permalink: x.permalink || a.permalink, sku, listing_type: lt, category_id: x.category_id || a.category_id || null,
      cost: c?.purchase != null && c.purchase !== '' ? Number(c.purchase) : null, feeHistory: null, offersFreeShipping: false, shipCost: avgShip ?? 0, shipEstimated: true,
      maxFinancingPct: lt === 'gold_pro' ? premiumFinMax : 0 };
  };
  const ads = raw.ads.map((a) => ({ ...a, item: ctxItem(a.item_id) || fallback(a) })).filter((a) => a.item);

  // Cargos reales de MeLi a cada precio (hoy y con promo).
  const combos = new Map();
  const addCombo = (it, p) => { if (p && it.listing_type) { const k = keyFee(it.listing_type, it.category_id, p); combos.set(k, { key: k, price: p, listing_type: it.listing_type, category_id: it.category_id }); } };
  for (const o of offers) { addCombo(o.item, o.price_today); addCombo(o.item, o.promo_price); }
  for (const a of ads) if (!a.noMetrics) addCombo(a.item, a.item.price);
  const fees = await readFees(token, [...combos.values()]);

  const out = { offers, ads, taxRate, fees, errors: raw.errors, hasAdvertiser: raw.hasAdvertiser, adsInfo: raw.adsInfo, fetched_at: new Date().toISOString() };
  const ev = evaluateAll(out);
  out.summary = ev.summary;
  out.actions = actionsByItem(ev);
  await db.upsert('rinde_settings', [{ key: cacheKey, value: out, updated_at: out.fetched_at }], 'key');
  json(res, 200, out);
});
