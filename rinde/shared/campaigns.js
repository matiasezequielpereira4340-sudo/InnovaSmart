// Rinde — Campañas y publicidad: ¿conviene o no? Cálculos puros (servidor, navegador, demo y pruebas).
// Rinde solo recomienda: nunca activa ni cambia nada en Mercado Libre.
import { THRESHOLDS as T } from './config.js';

const round = (n) => Math.round(n);
const fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-AR');
const pct = (n) => Math.round(n * 100) + ' %';

export const NO_FEES = 'No pudimos calcular los cargos de MeLi para este precio.';

/**
 * Cargo real de MeLi a un precio a partir de lo que ESA publicación pagó antes (facturación de una venta).
 * Solo si el precio nuevo queda del mismo lado del mínimo de envío gratis; y si hay cargo fijo por unidad,
 * solo si el precio está a menos de 10 % del de esa venta (el cargo fijo cambia por tramo de precio).
 * @param h { price, pct, fixed, financingPct }  pct y financingPct como fracción (0,145 = 14,5 %)
 */
export function feeFromHistory(h, price) {
  if (!h || !(h.price > 0) || h.pct == null) return null;
  const min = T.FREE_SHIPPING_MIN_PRICE;
  if ((price >= min) !== (h.price >= min)) return null;
  if (h.fixed > 0 && Math.abs(price - h.price) / h.price > 0.1) return null;
  return { percentage: h.pct * 100, fixed: price < min ? h.fixed || 0 : 0, financing: price * (h.financingPct || 0), source: 'historial' };
}

/**
 * Cargos de Mercado Libre para UNA venta a un precio dado. SIN tablas inventadas:
 * 1) el cargo exacto de MeLi para ese precio, categoría y tipo (listing_prices), 2) el % real que esa publicación
 * pagó antes (feeFromHistory). Si no hay ninguno, devuelve null (no se calcula ni se da veredicto).
 * @param ctx { feeAt: (price) => {percentage, fixed, financing, total?, source} | null, shipCost, offersFreeShipping, taxRate }
 */
export function chargesAt(price, ctx = {}) {
  const f = ctx.feeAt ? ctx.feeAt(price) : null;
  if (!f || f.percentage == null || !Number.isFinite(Number(f.percentage))) return null;
  const fixed = Number(f.fixed || 0);
  const financing = Number(f.financing || 0);
  // Si MeLi da el total de su cargo (sale_fee_amount), manda ese número; si no, porcentaje sobre el precio.
  const commission = f.total != null ? Math.max(0, Number(f.total) - fixed - financing) : price * (Number(f.percentage) / 100);
  // Envío: desde el mínimo MeLi obliga envío gratis (lo paga el vendedor). Debajo, solo si el vendedor lo ofrece.
  const freeMandatory = price >= T.FREE_SHIPPING_MIN_PRICE;
  const shipping = freeMandatory || ctx.offersFreeShipping ? (ctx.shipCost || 0) : 0;
  const taxes = price * (ctx.taxRate || 0);
  return { commission, fixed, financing, shipping, taxes, total: commission + fixed + financing + shipping + taxes, freeMandatory, source: f.source || 'meli' };
}

/**
 * Lo que le queda al vendedor por venta (antes del costo del producto, y después si hay costo). null si no hay cargos.
 * @param contribution aporte de Mercado Libre por unidad (co-fondeo o boost), en $
 */
export function perSale(price, ctx = {}, { contribution = 0, cost = null } = {}) {
  const ch = chargesAt(price, ctx);
  if (!ch) return null;
  const beforeCost = price + contribution - ch.total;
  return { price, contribution, charges: ch, beforeCost, profit: cost != null ? beforeCost - cost : null };
}

/** Aporte de MeLi por unidad para una oferta (co-fondeada o con boost). */
export function meliContribution(offer) {
  const base = offer.original_price || offer.price_today || 0;
  const p = offer.meli_percentage ?? offer.meli_percent ?? offer.benefits?.meli_percent ?? null;
  if (p != null) return base * (Number(p) / 100);
  return Number(offer.meli_amount || 0);
}

/**
 * Evalúa entrar a una promoción con una publicación.
 * @param offer { price_today, promo_price, original_price?, meli_percentage?, type, name }
 * @param ctx   ver chargesAt; además { cost, outOfSeason, seasonName }
 */
export function evaluatePromo(offer, ctx = {}) {
  const cost = ctx.cost != null && ctx.cost !== '' ? Number(ctx.cost) : null;
  const today = perSale(offer.price_today, ctx, { cost });
  const contribution = meliContribution(offer);
  const promo = perSale(offer.promo_price, ctx, { contribution, cost });
  if (!today || !promo) {
    return { offer, today, promo, contribution, crossings: [], cost, moreSales: null, verdict: null, label: null, noFees: true, note: NO_FEES };
  }
  const crossings = [];
  if (today.charges.freeMandatory && !promo.charges.freeMandatory) crossings.push('Con el precio de la promo deja de ser obligatorio el envío gratis.');
  if (!today.charges.freeMandatory && promo.charges.freeMandatory) crossings.push('Con el precio de la promo pasa a ser obligatorio el envío gratis (lo pagás vos).');
  if (promo.charges.fixed > today.charges.fixed) crossings.push(`Con el precio de la promo se suma un cargo fijo por unidad de ${fmt(promo.charges.fixed)}.`);

  const base = cost != null ? { t: today.profit, p: promo.profit } : { t: today.beforeCost, p: promo.beforeCost };
  // Sin costo no se calcula cuánto más hay que vender (sería engañoso sobre la cuenta antes del costo).
  const moreSales = cost == null ? null : base.p > 0 && base.t > base.p ? base.t / base.p - 1 : base.p > 0 ? 0 : null;

  let verdict = null; // solo con costo
  let label = null;
  if (ctx.outOfSeason) {
    verdict = 'no_ahora';
    label = `No ahora: es de ${ctx.seasonName || 'otra temporada'} y está fuera de temporada`;
  } else if (cost != null) {
    if (promo.profit < 0) { verdict = 'no_conviene'; label = `No conviene: perdés ${fmt(-promo.profit)} por venta`; }
    else if (promo.profit >= today.profit) { verdict = 'conviene'; label = contribution > 0 ? 'Conviene: el aporte de Mercado Libre cubre el descuento' : 'Conviene: ganás lo mismo o más por venta'; }
    else { verdict = 'conviene_si'; label = `Conviene solo si vendés ${pct(moreSales)} más`; }
  }
  return {
    offer, today, promo, contribution, crossings, cost,
    moreSales, verdict, label,
    note: cost == null ? 'Cuenta antes del costo del producto. Cargá el costo para saber si te conviene.' : null,
  };
}

/**
 * Publicidad (Product Ads) de una publicación.
 * @param ads { cost, direct_amount, indirect_amount, direct_units, indirect_units }
 * @param ctx { price, cost, ...ctx de chargesAt }
 */
export function evaluateAds(ads, ctx = {}) {
  const sales = ads.total_amount != null ? ads.total_amount : (ads.direct_amount || 0) + (ads.indirect_amount || 0);
  const acos = sales > 0 ? (ads.cost || 0) / sales : null;
  const cost = ctx.cost != null && ctx.cost !== '' ? Number(ctx.cost) : null;
  const unit = perSale(ctx.price, ctx, { cost });
  const marginBeforeAds = unit && ctx.price > 0 ? (cost != null ? unit.profit : unit.beforeCost) / ctx.price : null;
  let verdict = null; let label = null;
  if (cost != null && sales === 0 && (ads.cost || 0) > 0 && (ads.total_amount != null || ads.direct_amount != null)) {
    verdict = 'apagar'; label = 'Apagala: gastó y no vendió nada'; // pérdida segura, no depende de los cargos
  } else if (cost != null && marginBeforeAds != null) {
    if (acos == null) { verdict = (ads.cost || 0) > 0 ? 'apagar' : null; label = verdict ? 'Apagala: gastó y no vendió nada' : null; }
    else if (marginBeforeAds <= 0) { verdict = 'apagar'; label = 'Apagala: el producto ya pierde plata sin publicidad'; }
    else if (acos > marginBeforeAds * 1.5) { verdict = 'apagar'; label = 'Apagala'; }
    else if (acos > marginBeforeAds) { verdict = 'bajar'; label = 'Bajá el presupuesto'; }
    else if (acos < marginBeforeAds * 0.5) { verdict = 'subir'; label = 'Podés subir'; }
    else { verdict = 'ok'; label = 'Está bien'; }
  }
  return {
    ads, sales, acos, marginBeforeAds, maxAcos: marginBeforeAds == null ? null : marginBeforeAds > 0 ? marginBeforeAds : 0,
    losing: acos != null && marginBeforeAds != null && cost != null && acos > marginBeforeAds,
    verdict, label, cost,
    noFees: !unit,
    note: !unit ? NO_FEES : cost == null ? 'ACOS máximo calculado antes del costo del producto. Cargá el costo para saber si la publicidad te deja plata.' : null,
  };
}

/** Resumen para el encabezado de la pestaña. */
export function summarize(promos, ads) {
  const conv = promos.filter((x) => x.verdict === 'conviene').length;
  const loseP = promos.filter((x) => x.verdict === 'no_conviene').length;
  const loseA = ads.filter((x) => x.losing).length;
  const parts = [];
  if (conv) parts.push(`${conv} campaña${conv === 1 ? '' : 's'} te conviene${conv === 1 ? '' : 'n'}`);
  if (loseP) parts.push(`${loseP} te hace${loseP === 1 ? '' : 'n'} perder plata`);
  if (loseA) parts.push(`la publicidad de ${loseA} ${loseA === 1 ? 'publicación' : 'publicaciones'} pierde plata`);
  return { conv, loseP, loseA, text: parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' y $1') : null };
}

export const feeKey = (lt, cat, price) => `${lt}|${cat || ''}|${Math.round(price)}`;

/** Arma las evaluaciones (para el resumen del diagnóstico y el plan de acción de cada publicación). */
export function evaluateAll(data) {
  const ctxOf = (it) => ({ listingType: it.listing_type, offersFreeShipping: it.offersFreeShipping, shipCost: it.shipCost, taxRate: data.taxRate, cost: it.cost,
    outOfSeason: it.outOfSeason, seasonName: it.seasonName, feeAt: (p) => data.fees?.[feeKey(it.listing_type, it.category_id, p)] || feeFromHistory(it.feeHistory, p) });
  const promos = data.offers.filter((o) => o.item && o.price_today && o.promo_price).map((o) => ({ o, e: evaluatePromo(o, ctxOf(o.item)) }));
  const ads = data.ads.filter((a) => a.item?.price && !a.noMetrics).map((a) => ({ a, e: evaluateAds(a, { ...ctxOf(a.item), price: a.item.price }) }));
  return { promos, ads, summary: summarize(promos.map((x) => x.e), ads.map((x) => x.e)) };
}

/** Acciones cortas por publicación para sumar al plan de acción. */
export function actionsByItem(ev) {
  const out = {};
  const add = (id, a) => { (out[id] ||= []).push(a); };
  for (const { o, e } of ev.promos) {
    if (e.verdict === 'conviene') add(o.item_id, { title: `Entrá a "${o.name}"`, detail: `${e.label}. Con la promo te quedan ${fmt(e.promo.profit)} por venta (hoy ${fmt(e.today.profit)}).`, impact: 'alto' });
    else if (e.verdict === 'no_conviene') add(o.item_id, { title: `No entres a "${o.name}"`, detail: e.label + '.', impact: 'alto' });
    else if (e.verdict === 'conviene_si') add(o.item_id, { title: `"${o.name}": solo si vendés más`, detail: `${e.label} para ganar lo mismo que hoy.`, impact: 'medio' });
  }
  for (const { a, e } of ev.ads) {
    if (e.verdict === 'apagar' || e.verdict === 'bajar') add(a.item_id, { title: `Publicidad: ${e.label}`, detail: `ACOS ${Math.round((e.acos || 0) * 100)} %; lo máximo que aguanta es ${Math.round(e.maxAcos * 100)} %.`, impact: 'alto' });
  }
  return out;
}


export { fmt as fmtCampaignMoney };
