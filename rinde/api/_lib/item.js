// Se sirve desde /api/profit (rewrite /api/item → /api/profit?scope=item) para no sumar una función más en Vercel.
// GET  /api/item?id=MLA…  — detalle de una publicación: ventas de los últimos 90 días con sus cargos
//                            y la última sugerencia guardada (si hay).
// POST /api/item           — { id, again } genera una sugerencia de título/descripción (solo a pedido).
// Solo lectura en Mercado Libre: Rinde nunca cambia la publicación.
import { json, method, readBody, query, AppError } from './http.js';
import { isPaid } from './users.js';
import { db } from './db.js';
import { sha256 } from './crypto.js';
import * as meli from './meli.js';
import { NOT_SOLD } from './sync.js';
import { generateSuggestion } from './ai.js';
import { loadAccount } from './sync.js';
import { readFees } from './campaigns-meli.js';
import { feeKey } from '../../shared/campaigns.js';
import { costKey } from '../../shared/model.js';
import { accountConversion } from '../../shared/score.js';
import { sourceOf, titleRule, finalize, ruleSuggestion, SUGGEST_LIMITS } from '../../shared/suggest.js';

const DAY = 86400000;
const ID = /^MLA\d{6,14}$/;

/** Inicio del día de hoy en hora argentina (UTC-3), en ms. */
export function startOfDayAR(now = Date.now()) {
  const ar = new Date(now - 3 * 3600000);
  return Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()) + 3 * 3600000;
}

/** Cuántas sugerencias generó la cuenta hoy y si puede generar para esta publicación. */
export function usageOf(rows, { paid, itemId, now = Date.now() }) {
  const today = rows.filter((r) => new Date(r.created_at).getTime() >= startOfDayAR(now)).length;
  const items = [...new Set(rows.map((r) => r.item_id))];
  if (paid) return { paid, today, limit: SUGGEST_LIMITS.PAID_PER_DAY, left: Math.max(0, SUGGEST_LIMITS.PAID_PER_DAY - today), allowed: today < SUGGEST_LIMITS.PAID_PER_DAY };
  const trialItem = items[0] || null;
  const otherItem = trialItem && trialItem !== itemId;
  const left = otherItem ? 0 : Math.max(0, SUGGEST_LIMITS.FREE_GENERATIONS - rows.length);
  return { paid, today, trialItem, limit: SUGGEST_LIMITS.FREE_GENERATIONS, left, allowed: !otherItem && left > 0, reason: otherItem ? 'otra_publicacion' : left ? null : 'agotado' };
}

async function salesOf(userId, itemId) {
  const orders = await db.selectAll('rinde_orders', { user_id: userId }, { columns: 'order_id,date_created,data,fees,fees_source,taxes_unknown', order: 'date_created.desc' });
  const cutoff = Date.now() - 90 * DAY;
  const out = [];
  for (const o of orders) {
    if (new Date(o.date_created).getTime() < cutoff) break;
    if (NOT_SOLD.has(o.data?.status)) continue;
    const ls = o.data?.lines || [];
    const total = ls.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0) || 1;
    for (const l of ls) {
      if (l.item_id !== itemId) continue;
      const share = ((l.qty || 0) * (l.unit_price || 0)) / total;
      const billed = !!o.fees && o.fees_source === 'facturación';
      const f = o.fees
        ? Object.fromEntries(Object.entries(o.fees).filter(([k]) => k !== 'v').map(([k, v]) => [k, (Number(v) || 0) * share]))
        : { commission: (Number(l.sale_fee) || 0) * (l.qty || 1), shipping: 0, financing: 0, taxes: (Number(o.data?.taxes_amount) || 0) * share, other: 0 };
      out.push({ order_id: o.order_id, date: o.date_created, qty: l.qty, unit_price: l.unit_price, fees: f, source: billed ? 'facturación' : o.fees ? 'orden' : 'orden_sola', shipping_unknown: !o.fees });
    }
  }
  return out;
}

export async function itemRoute(req, res, u) {
  const paid = isPaid(u);

  if (req.method === 'GET' && query(req).sim) {
    const id = String(query(req).id || '').toUpperCase();
    if (!ID.test(id)) throw new AppError(400, 'Número de publicación inválido.', 'bad_id');
    if (!paid) throw new AppError(402, 'Disponible en Plan Rinde', 'plan_required');
    return json(res, 200, await simContext(u, id));
  }
  if (req.method === 'GET') {
    const id = String(query(req).id || '').toUpperCase();
    if (!ID.test(id)) throw new AppError(400, 'Número de publicación inválido.', 'bad_id');
    const own = await db.one('rinde_items', { user_id: u.id, item_id: id }, { columns: 'item_id' });
    if (!own) throw new AppError(404, 'Esa publicación no está en tu cuenta (o ya no está activa ni pausada).', 'not_found');
    const [sales, saved, mine] = await Promise.all([
      paid ? salesOf(u.id, id) : Promise.resolve(null),
      db.select('rinde_suggestions', { user_id: u.id, item_id: id }, { columns: 'content,source,variant,created_at', order: 'created_at.desc', limit: 1 }),
      db.select('rinde_suggestions', { user_id: u.id }, { columns: 'item_id,created_at', order: 'created_at.asc', limit: 500 }),
    ]);
    return json(res, 200, { sales, suggestion: saved[0] ? { ...saved[0].content, source: saved[0].source, variant: saved[0].variant, created_at: saved[0].created_at, cached: true } : null, usage: usageOf(mine, { paid, itemId: id }) });
  }

  method(req, 'POST');
  const body = await readBody(req);
  const id = String(body.id || '').toUpperCase();
  if (!ID.test(id)) throw new AppError(400, 'Número de publicación inválido.', 'bad_id');
  const stored = await db.one('rinde_items', { user_id: u.id, item_id: id }, { columns: 'data' });
  if (!stored) throw new AppError(404, 'Esa publicación no está en tu cuenta.', 'not_found');

  const mine = await db.select('rinde_suggestions', { user_id: u.id }, { columns: 'item_id,created_at,input_hash,variant,content,source', order: 'created_at.asc', limit: 500 });
  const usage = usageOf(mine, { paid, itemId: id });

  // Datos frescos de la publicación (solo lectura). Si no se pueden leer, se usa lo guardado de la última sincronización.
  let fresh = null;
  try { fresh = await meli.getSuggestionSource(await meli.getAccessToken(u.id), id); } catch (e) { if (e.status === 401) throw e; console.error('[rinde][sugerencia][meli]', e.message); }
  const src = sourceOf(fresh ? { ...fresh, item: { ...fresh.item, attrs: stored.data.attrs, sales180: stored.data.sales180 } } : { item: stored.data });
  const hash = sha256(JSON.stringify(src)).slice(0, 32);
  const prev = mine.filter((r) => r.item_id === id).at(-1);

  // Mismos datos y no pidió otra: se devuelve la guardada (no se gasta IA ni cupo).
  if (!body.again && prev && prev.input_hash === hash) return json(res, 200, { suggestion: { ...prev.content, source: prev.source, variant: prev.variant, created_at: prev.created_at, cached: true }, usage });
  if (!usage.allowed) {
    throw new AppError(402, paid ? `Llegaste al máximo de ${SUGGEST_LIMITS.PAID_PER_DAY} sugerencias por día. Mañana podés generar más.` : 'Disponible en Plan Rinde', paid ? 'limit' : 'plan_required');
  }
  const variant = prev ? prev.variant + (body.again ? 1 : 0) : 0;
  const rule = titleRule(src);
  const ai = await generateSuggestion(src, { titleAllowed: rule.allowed, max: rule.max, variant });
  const content = ai ? finalize(src, ai.raw, 'ia') : ruleSuggestion(src, variant);
  if (!fresh) content.notes = ['Usamos los datos de la última sincronización: Mercado Libre no respondió ahora.', ...content.notes];
  const [row] = await db.insert('rinde_suggestions', [{ user_id: u.id, item_id: id, input_hash: hash, variant, content, source: content.source, tokens: ai?.tokens || 0 }]);
  json(res, 200, { suggestion: { ...content, variant, created_at: row?.created_at || new Date().toISOString(), cached: false }, usage: usageOf([...mine, { item_id: id, created_at: new Date().toISOString() }], { paid, itemId: id }) });
}

/**
 * Datos del simulador de campaña para una publicación (solo lectura): cargos de MeLi a su precio (listing_prices),
 * lo que pagó en su última venta facturada (para el peor caso), envío y retenciones promedio de sus ventas,
 * su publicidad de los últimos 30 días y la de toda la cuenta (de la caché de Campañas), y su conversión.
 */
export async function simContext(u, id) {
  const { data } = await loadAccount(u.id);
  const it = data.items.find((x) => x.id === id);
  if (!it) throw new AppError(404, 'Esa publicación no está en tu cuenta.', 'not_found');
  const lines = data.lines || [];
  const mine = lines.filter((l) => l.item_id === id);
  const rev = lines.reduce((t, l) => t + l.qty * l.unit_price, 0);
  const taxRate = rev > 0 ? lines.reduce((t, l) => t + (l.fees?.taxes || 0), 0) / rev : 0;
  const ship = (ls) => { const q = ls.filter((l) => l.fees?.shipping > 0).reduce((t, l) => t + l.qty, 0); return q ? ls.reduce((t, l) => t + (l.fees?.shipping || 0), 0) / q : null; };
  const billed = mine.filter((l) => l.source === 'facturación' && l.qty && l.unit_price).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const last = billed[0];
  const finMax = Math.max(0, ...billed.map((l) => (l.fees?.financing || 0) / (l.qty * l.unit_price)));
  const feeHistory = last ? { price: last.unit_price, pct: ((last.fees?.commission || 0) - (last.fees?.fixed_fee || 0)) / (last.qty * last.unit_price), fixed: (last.fees?.fixed_fee || 0) / last.qty, financingPct: finMax } : null;
  let fees = {};
  try {
    const token = await meli.getAccessToken(u.id);
    fees = await readFees(token, [{ key: feeKey(it.listing_type, it.category_id, it.price), price: it.price, listing_type: it.listing_type, category_id: it.category_id }]);
  } catch (e) { if (e.status === 401) throw e; console.error('[rinde][simulador][fees]', e.message); }
  const camp = (await db.one('rinde_settings', { key: `campaigns:${u.id}` }).catch(() => null))?.value || null;
  const ads = (camp?.ads || []).filter((a) => !a.noMetrics);
  const adsItem = ads.find((a) => a.item_id === id) || null;
  const acc = ads.reduce((t, a) => ({ cost: t.cost + (a.cost || 0), clicks: t.clicks + (a.clicks || 0), units: t.units + (a.direct_units || 0) + (a.indirect_units || 0) }), { cost: 0, clicks: 0, units: 0 });
  const c = data.costs[costKey(it)];
  return {
    id, price: it.price, listing_type: it.listing_type, category_id: it.category_id,
    offersFreeShipping: !!it.shipping?.free_shipping, shipCost: ship(mine) ?? ship(lines) ?? 0, shipEstimated: ship(mine) == null,
    taxRate, fees, feeHistory, maxFinancingPct: it.listing_type === 'gold_pro' ? finMax : 0,
    cost: c?.purchase != null && c.purchase !== '' ? Number(c.purchase) : null,
    adsItem: adsItem ? { cost: adsItem.cost, clicks: adsItem.clicks, direct_units: adsItem.direct_units, indirect_units: adsItem.indirect_units } : null,
    adsAccount: acc.clicks ? acc : null, adsFetchedAt: camp?.fetched_at || null,
    item: { visits30: it.visits30, sales30: it.sales30 }, avgConv: accountConversion(data.items),
  };
}
