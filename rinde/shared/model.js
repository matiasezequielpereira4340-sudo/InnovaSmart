// Arma el "modelo" de la cuenta a partir de los datos crudos.
// Mismo código para la cuenta real (servidor) y para el demo (navegador).
import { classify, computeProductProfit, buildRulePlan, lostSalesEstimate, rankProblems, prorate, replacementWarning, buildAlerts } from './rules.js';
import { CATEGORIES } from './config.js';

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
    const plan = plans[it.id] || buildRulePlan(it, cls, profit);
    return { it, cost, profit, cls, lost, plan, warning: replacementWarning(profit) };
  });

  const counts = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
  rows.forEach((r) => counts[r.cls.category]++);

  const problems = rankProblems(rows).slice(0, 3);

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
  return { rows, counts, problems, kpis, alerts, lostTotal, seller };
}

import { fmtMoney } from './rules.js';
const FIX_HINT = {
  sin_stock: 'Reponé stock en las que más vendían.',
  pausada: 'Reactivá las pausadas que tenían ventas.',
  infraccion: 'Corregí la infracción desde la publicación.',
  bajo_revision: 'Completá lo que pide Mercado Libre.',
  calidad_baja: 'Completá las mejoras de calidad que marca Mercado Libre.',
  acciones_pendientes: 'Hacé las mejoras pendientes que marca Mercado Libre.',
  titulo_corto: 'Reescribí los títulos con palabras clave.',
  publicacion_gratuita: 'Pasá las gratuitas a Clásica o Premium.',
  publicacion_clasica: 'Probá Premium en las de ticket alto.',
  sin_full_flex: 'Sumá Flex o Full.',
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

/** Resumen de cuenta por reglas (respaldo de la IA y base de datos para ella). */
export function buildRuleSummary(model) {
  const p = model.problems;
  return {
    headline: p.length
      ? `Estimamos que estás dejando de vender ~${fmtMoney(model.lostTotal)} por mes. Empezá por: ${p[0].label.toLowerCase()}.`
      : 'Tu cuenta está sana. Seguí así y cargá tus costos para controlar el margen.',
    problems: p.map((x) => ({
      label: x.label,
      detail: `${x.items.length} publicación(es) · impacto estimado ${fmtMoney(x.impact)}/mes`,
      fix: FIX_HINT[x.code] || '',
      items: x.items,
    })),
    first: p[0] ? FIX_HINT[p[0].code] : null,
    source: 'reglas',
  };
}
