// Arma el "modelo" de la cuenta a partir de los datos crudos.
// Mismo código para la cuenta real (servidor) y para el demo (navegador).
import { classify, computeProductProfit, buildRulePlan, lostSalesEstimate, rankProblems, prorate, replacementWarning, buildAlerts, groupOf, seasonInfo } from './rules.js';
import { CATEGORIES, GROUPS } from './config.js';

export function costKey(it) {
  return (it.sku && String(it.sku).trim()) || it.id;
}

/**
 * @param data {
 *   items: snapshot[], lines: venta[] (últimos 30 días),
 *   costs: { [sku]: {purchase, replacement} }, settings: { ads_manual_monthly, meta_ads_monthly },
 *   productAds: { [item_id]: amount } | null, seller, plans: { [item_id]: plan } (IA), prevReputation
 * }
 */
export function buildModel(data) {
  const { items = [], lines = [], costs = {}, settings = {}, productAds = null, seller = {}, plans = {} } = data;
  const byItem = {};
  for (const l of lines) (byItem[l.item_id] ||= []).push(l);

  const revenueByItem = {};
  for (const it of items) revenueByItem[it.id] = (byItem[it.id] || []).reduce((s, l) => s + l.qty * l.unit_price, 0);

  const metaShare = prorate(Number(settings.meta_ads_monthly) || 0, revenueByItem);
  const adsSource = productAds ? 'api' : Number(settings.ads_manual_monthly) > 0 ? 'manual' : 'ninguno';
  const manualShare = productAds ? {} : prorate(Number(settings.ads_manual_monthly) || 0, revenueByItem);

  const rows = items.map((it) => {
    const cost = costs[costKey(it)] || null;
    const ads = (productAds ? productAds[it.id] || 0 : manualShare[it.id] || 0) + (metaShare[it.id] || 0);
    const profit = computeProductProfit(byItem[it.id] || [], cost, ads);
    const cls = classify(it, profit, seller);
    const lost = lostSalesEstimate(it, cls);
    const group = groupOf(it, cls);
    const season = group === 'TEMPORADA' ? seasonInfo(it) : null;
    // De temporada: el plan de reglas manda (la IA podría decir "reponé stock" de un producto de invierno en noviembre).
    const plan = season ? buildRulePlan(it, cls, profit) : plans[it.id] || buildRulePlan(it, cls, profit);
    return { it, cost, profit, cls, lost, plan, group, season, warning: replacementWarning(profit) };
  });

  const counts = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  rows.forEach((r) => counts[r.cls.category]++);
  // Tarjetas: mismos grupos que la lista, suman el total de publicaciones.
  const groupCounts = Object.fromEntries(Object.keys(GROUPS).map((k) => [k, 0]));
  rows.forEach((r) => groupCounts[r.group]++);

  const ranked = rankProblems(rows);
  const problems = ranked.problems.slice(0, 3);

  // KPIs de rentabilidad (solo productos con costo cuentan para ganancia)
  const withSales = rows.filter((r) => r.profit.units > 0);
  const revenue = withSales.reduce((s, r) => s + r.profit.revenue, 0);
  const withCost = withSales.filter((r) => r.profit.hasCost);
  const net = withCost.reduce((s, r) => s + r.profit.net, 0);
  const revenueWithCost = withCost.reduce((s, r) => s + r.profit.revenue, 0);
  const kpis = {
    revenue,
    net: withCost.length ? net : null,
    margin: revenueWithCost > 0 ? net / revenueWithCost : null,
    losing: withCost.filter((r) => r.profit.net < 0).length,
    belowReplacement: withCost.filter((r) => r.profit.marginReplacement != null && r.profit.marginReplacement < 0).length,
    noCost: withSales.filter((r) => !r.profit.hasCost).length,
    revenueCoverage: revenue > 0 ? revenueWithCost / revenue : 0,
    estimated: withSales.some((r) => r.profit.estimated),
    taxesUnknown: withSales.some((r) => r.profit.taxesUnknown),
    adsSource,
    units: withSales.reduce((s, r) => s + r.profit.units, 0),
  };

  const alerts = buildAlerts({ rows, seller, prevReputation: data.prevReputation });
  const lostTotal = rows.reduce((s, r) => s + (r.lost || 0), 0);

  // Facturación real (órdenes pagadas). 30 días sale de las ventas cargadas; 90/180 de la sincronización.
  const rev = data.revenue || null;
  const revenue30 = rev?.d30 ?? lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0);
  const revenueReal = {
    d30: revenue30,
    d90: rev?.d90 ?? null,
    d180: rev?.d180 ?? null,
    monthlyAvg180: rev?.d180 != null ? rev.d180 / 6 : null,
    orders30: rev?.orders30 ?? new Set(lines.map((l) => l.order_id)).size,
    orders90: rev?.orders90 ?? null,
    cancelled30: rev?.cancelled30 ?? null,
    cancelled30_amount: rev?.cancelled30_amount ?? null,
    statuses30: rev?.statuses30 || null,
    months: rev?.months || null,
  };
  // Control: el estimado no debería superar lo que se factura por mes. Si pasa, se marca para revisar (no se tapa).
  const sanity = {
    exceeds30: revenue30 > 0 && lostTotal > revenue30,
    exceedsAvg: revenueReal.monthlyAvg180 != null && lostTotal > revenueReal.monthlyAvg180 + 1,
  };
  const hasAnyCost = rows.some((r) => r.profit.hasCost);
  return { rows, counts, groupCounts, problems, allProblems: ranked.problems, abandoned: ranked.abandoned, seasonal: ranked.seasonal, tips: ranked.tips, kpis, alerts, lostTotal, revenue: revenueReal, sanity, hasAnyCost, seller };
}

import { fmtMoney } from './rules.js';
const FIX_HINT = {
  sin_stock: 'Reponé stock, empezando por las que más vendían:',
  pausada: 'Reactivá primero las que más vendían:',
  infraccion: 'Corregí la infracción desde la publicación.',
  bajo_revision: 'Completá lo que pide Mercado Libre.',
  calidad_baja: 'Completá las mejoras de calidad que marca Mercado Libre.',
  acciones_pendientes: 'Hacé las mejoras pendientes que marca Mercado Libre.',
  titulo_corto: 'Reescribí los títulos con palabras clave.',
  publicacion_gratuita: 'Pasá las gratuitas a Clásica o Premium.',
  publicacion_clasica: 'Probá Premium en las de ticket alto.',
  sin_full_flex: 'Sumá Flex o Full en las que más venden:',
  sin_envio_gratis: 'Ofrecé envío gratis donde el margen lo banque.',
  fuera_catalogo: 'Competí en el catálogo.',
  pocas_fotos: 'Sumá fotos (mínimo 6).',
  precio_alto: 'Acercá el precio a la competencia o sumá valor.',
  sin_cuotas: 'Ofrecé cuotas sin interés.',
  preguntas_sin_responder: 'Respondé las preguntas en menos de 1 hora.',
  reputacion: 'Cuidá despachos y cancelaciones.',
  margen_negativo: 'Subí precios al mínimo sin pérdida.',
  debajo_reposicion: 'Actualizá precios al costo de reposición.',
  visibilidad_general: 'Probá Product Ads con presupuesto chico.',
  conversion_general: 'Mejorá foto principal y descripción.',
};

export const LOST_EXPLAIN = 'Es una estimación, no plata que perdiste. Sale solo de tus ventas reales. Contamos únicamente las publicaciones que hoy no pueden vender (sin stock, pausadas, con infracción o en revisión): para cada una tomamos lo que vendía por mes en los 60 días antes de su última venta, es decir, justo antes de quedarse sin stock o pausarse. Cada publicación se cuenta una sola vez. No suman: los productos de temporada fuera de su época (por ejemplo, de invierno en noviembre), las que no vendieron nada en 6 meses ("abandonadas") y las activas que venden menos que antes. Clásica/cuotas y Full/Flex son solo sugerencias. Este número nunca puede ser mayor a lo que vendías en promedio por mes en los últimos 6 meses.';

const itemsLine = (top, more) => top.map((t) => ({ title: t.title, sold: t.sold, permalink: t.permalink, id: t.id })).concat(more ? [{ more }] : []);

/** Resumen de cuenta por reglas (respaldo de la IA y base de datos para ella). */
export function buildRuleSummary(model) {
  const p = model.problems;
  const rev30 = model.revenue?.d30;
  return {
    headline: model.lostTotal > 0
      ? `Ventas que podrías estar perdiendo: ~${fmtMoney(model.lostTotal)}/mes (estimado)`
      : p.length ? 'No vemos ventas perdidas importantes, pero hay cosas para mejorar.' : 'Tu cuenta está sana. Seguí así y cargá tus costos para controlar el margen.',
    revenueNote: model.revenue?.monthlyAvg180 != null && rev30 != null
      ? `En los últimos 6 meses vendías ~${fmtMoney(model.revenue.monthlyAvg180)}/mes en promedio; en los últimos 30 días, ${fmtMoney(rev30)}`
      : rev30 != null ? `Tu facturación de los últimos 30 días: ${fmtMoney(rev30)}` : null,
    explain: model.lostTotal > 0 ? LOST_EXPLAIN : null,
    problems: p.map((x) => ({
      label: x.label,
      detail: `${x.items.length} publicación(es) · ${x.impact > 0 ? (['margen_negativo', 'debajo_reposicion'].includes(x.code) ? `perdiste ~${fmtMoney(x.impact)} en los últimos 30 días (con tus costos cargados)` : `ventas estimadas en juego ~${fmtMoney(x.impact)}/mes`) : 'sin impacto estimado en ventas'}`,
      fix: FIX_HINT[x.code] || '',
      items: x.items,
      top: itemsLine(x.top || [], x.more),
    })),
    seasonal: model.seasonal?.count ? {
      label: 'De temporada: no las cuentes ahora',
      detail: `${model.seasonal.count} publicación(es) que se venden en otra época del año (por el título o porque casi todas sus ventas fueron en esa temporada). No suman al estimado.`,
      fix: 'No repongas ahora: preparalas un mes antes de su temporada.',
      top: itemsLine(model.seasonal.top, model.seasonal.more),
    } : null,
    abandoned: model.abandoned?.count ? {
      label: 'Publicaciones abandonadas',
      detail: `${model.abandoned.count} publicación(es) sin ninguna venta en los últimos 6 meses. No suman al estimado.`,
      fix: 'Decidí cuáles mejorar a fondo y cuáles cerrar: ocupan stock y atención.',
      top: itemsLine(model.abandoned.top, model.abandoned.more),
    } : null,
    tips: (model.tips || []).map((t) => ({ label: 'Sugerencia', detail: t.code === 'publicacion_clasica'
      ? `${t.count} publicación(es) son Clásicas: en Premium se ofrecen cuotas sin interés. Es una sugerencia, no la contamos como plata perdida.`
      : 'Si en algún momento querés acelerar entregas, Flex o Full ayudan a posicionar. No lo contamos como plata perdida.', small: true })),
    first: p[0] ? (FIX_HINT[p[0].code] || '').replace(/:$/, '.') : null,
    source: 'reglas',
  };
}
