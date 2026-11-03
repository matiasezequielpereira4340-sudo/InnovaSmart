// Rinde — reglas de clasificación, rentabilidad y alertas.
// Código compartido entre el servidor y el navegador (modo demo).
// Regla de oro: si un dato no está, se informa "sin dato". Nunca se inventa.

import { THRESHOLDS as T, CATEGORIES } from './config.js';

const fmt = (n) => (n == null || Number.isNaN(n) ? 'sin dato' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-AR'));
const pct = (n) => (n == null || Number.isNaN(n) ? 'sin dato' : (n * 100).toFixed(1).replace('.', ',') + ' %');
export { fmt as fmtMoney, pct as fmtPct };

const isFull = (it) => it.shipping?.logistic === 'fulfillment';
const isFlex = (it) => !!it.shipping?.flex;

export const LISTING_LABEL = { gold_pro: 'Premium', gold_special: 'Clásica', free: 'Gratuita', gold: 'Oro', silver: 'Plata', bronze: 'Bronce' };

export function conversion(it) {
  if (!it.visits30) return null;
  return (it.sales30 || 0) / it.visits30;
}

/** Precio de referencia de la competencia (mediana si existe, si no mínimo). */
export function competitorRef(it) {
  const c = it.competition;
  if (!c) return null;
  return c.median_price ?? c.min_price ?? null;
}

export function priceGap(it) {
  const ref = competitorRef(it);
  if (!ref || !it.price) return null;
  return it.price / ref - 1;
}

/**
 * Clasifica UNA publicación en una categoría principal.
 * @param it snapshot normalizado de la publicación
 * @param profit resultado de computeProductProfit (o null si no hay costo)
 * @param seller { reputation: { level_id, power_seller_status } }
 */
export function classify(it, profit, seller = {}) {
  const reasons = [];
  const push = (code, text, weight = 1) => reasons.push({ code, text, weight });

  // 1) Errores operativos
  const sub = it.sub_status || [];
  if (it.status === 'under_review' || sub.includes('waiting_for_patch') || sub.includes('held')) {
    push('bajo_revision', 'La publicación está bajo revisión de Mercado Libre.', 3);
  }
  if (it.infraction || sub.includes('forbidden') || sub.includes('warning')) {
    push('infraccion', 'Tiene una infracción o advertencia activa.', 3);
  }
  if ((it.available_quantity ?? 1) === 0 || sub.includes('out_of_stock')) {
    push('sin_stock', 'No tiene stock disponible.', 3);
  } else if (it.status === 'paused') {
    push('pausada', 'Está pausada: no aparece en las búsquedas.', 2);
  }
  if (reasons.length) return { category: 'OPERATIVO', reasons };

  const conv = conversion(it);
  const q = it.quality;

  // 2) Sin visitas → visibilidad
  if ((it.visits30 ?? 0) < T.VISITS_MIN_30D) {
    if (q && q.score != null && q.score < T.QUALITY_MIN_SCORE) push('calidad_baja', `Calidad ${q.level_wording || ''} (${q.score}/100) según Mercado Libre.`.replace('  ', ' '), 3);
    if (q && q.pending_actions?.length) push('acciones_pendientes', `Mercado Libre marca ${q.pending_actions.length} mejora(s) pendiente(s) en la publicación.`, 2);
    if ((it.title || '').length < T.TITLE_MIN_CHARS) push('titulo_corto', `El título tiene ${(it.title || '').length} caracteres: le faltan palabras clave.`, 2);
    if (it.listing_type === 'free') push('publicacion_gratuita', 'Es una publicación gratuita: casi no tiene exposición.', 3);
    else if (it.listing_type === 'gold_special') push('publicacion_clasica', 'Es Clásica: Premium tiene más exposición y cuotas sin interés.', 1);
    if (!isFull(it) && !isFlex(it)) push('sin_full_flex', 'No usa Full ni Flex: compite contra envíos más rápidos.', 2);
    if (!it.shipping?.free_shipping) push('sin_envio_gratis', 'No ofrece envío gratis.', 1);
    if (it.catalog_product_id && !it.catalog_listing) push('fuera_catalogo', 'Hay producto de catálogo y no estás compitiendo en él.', 2);
    if ((it.pictures_count ?? 0) < T.PICTURES_MIN) push('pocas_fotos', `Tiene ${it.pictures_count ?? 0} foto(s); se recomiendan al menos ${T.PICTURES_MIN}.`, 1);
    if (!reasons.length) push('visibilidad_general', 'Recibe pocas visitas aunque la ficha está completa.', 1);
    return { category: 'SIN_VISITAS', reasons, noDemand: isNoDemand(it) };
  }

  // 3) Visitas sin ventas → conversión
  if (conv != null && conv < T.CONVERSION_MIN) {
    const gap = priceGap(it);
    if (gap != null && gap > T.PRICE_GAP_ALERT) push('precio_alto', `Tu precio está ${pct(gap)} arriba de la competencia (${fmt(competitorRef(it))}).`, 3);
    if (it.competition == null) push('competencia_sin_dato', 'Precio de la competencia: sin dato de Mercado Libre.', 0);
    if ((it.pictures_count ?? 0) < T.PICTURES_MIN) push('pocas_fotos', `Tiene ${it.pictures_count ?? 0} foto(s); se recomiendan al menos ${T.PICTURES_MIN}.`, 2);
    if (it.listing_type !== 'gold_pro') push('sin_cuotas', 'No ofrece cuotas sin interés (publicación Clásica).', 2);
    if ((it.questions_unanswered ?? 0) > 0) push('preguntas_sin_responder', `Tiene ${it.questions_unanswered} pregunta(s) sin responder.`, 3);
    const lvl = seller.reputation?.level_id || '';
    if (lvl && !/green/.test(lvl)) push('reputacion', `Tu reputación (${lvl.replace('_', ' ')}) frena la compra.`, 2);
    if (!it.shipping?.free_shipping) push('sin_envio_gratis', 'No ofrece envío gratis.', 1);
    if (q && q.score != null && q.score < T.QUALITY_MIN_SCORE) push('calidad_baja', `Calidad ${q.level_wording || ''} (${q.score}/100) según Mercado Libre.`, 1);
    if (!reasons.filter((r) => r.weight > 0).length) push('conversion_general', 'La ven, pero algo de la oferta no convence (precio, fotos o descripción).', 1);
    return { category: 'SIN_VENTAS', reasons, noDemand: isNoDemand(it) };
  }

  // 4) Vende pero pierde plata (solo con costo cargado)
  if (profit && profit.hasCost && (it.sales30 || 0) > 0) {
    if (profit.net < 0) push('margen_negativo', `Perdiste ${fmt(-profit.net)} en 30 días con este producto (margen ${pct(profit.margin)}).`, 3);
    if (profit.marginReplacement != null && profit.marginReplacement < 0) push('debajo_reposicion', 'Estás vendiendo por debajo de lo que te cuesta reponer.', 3);
    if (reasons.length) return { category: 'PIERDE_PLATA', reasons };
  }

  // 5) Sana
  const notes = [];
  if (!profit || !profit.hasCost) notes.push({ code: 'costo_sin_cargar', text: 'Costo sin cargar: no podemos confirmar que deje margen.', weight: 0 });
  else if (profit.margin < T.MARGIN_HEALTHY_MIN) notes.push({ code: 'margen_finito', text: `Vende, pero el margen es finito (${pct(profit.margin)}).`, weight: 1 });
  return { category: 'SANA', reasons: notes };
}

export function isNoDemand(it) {
  const comp = it.competition;
  const gap = priceGap(it);
  const lowVisits = (it.visits30 ?? 0) <= T.NO_DEMAND_VISITS_30D && (it.sales90 ?? 0) === 0;
  const goodListing = it.quality?.score != null && it.quality.score >= T.QUALITY_MIN_SCORE;
  const saturated = comp && comp.count >= T.NO_DEMAND_COMPETITORS && gap != null && gap > 0.25;
  return !!((lowVisits && goodListing) || saturated);
}

/**
 * Historial propio de la publicación (últimos 180 días de órdenes reales).
 * Si la sincronización es vieja y no trae 180 días, usamos 90 como piso (nunca inventamos ventas).
 */
export function itemHistory(it) {
  const units180 = it.sales180 ?? it.sales90 ?? 0;
  const revenue180 = it.revenue180 ?? units180 * (it.price || 0);
  const avgPrice = units180 > 0 ? revenue180 / units180 : it.price || 0;
  return {
    units180,
    revenue180,
    monthlyRevenue: revenue180 / 6, // promedio mensual de los últimos 6 meses
    revenue30: (it.sales30 || 0) * avgPrice,
    abandoned: units180 === 0, // nunca vendió o no vende hace más de 180 días
  };
}

// Motivos que son recomendación, no plata en juego.
const NON_MONETARY = new Set(['sin_full_flex']);

/** Problema principal de la publicación: el de más peso que sí mueve ventas. Cada publicación cuenta una sola vez. */
export function primaryReason(cls) {
  const list = (cls.reasons || []).filter((x) => x.weight > 0 && !NON_MONETARY.has(x.code));
  if (!list.length) return (cls.reasons || []).some((x) => x.code === 'sin_full_flex') ? (cls.category === 'SIN_VENTAS' ? 'conversion_general' : 'visibilidad_general') : null;
  return list.reduce((a, b) => (b.weight > a.weight ? b : a)).code;
}

/**
 * Ventas mensuales que podría estar perdiendo UNA publicación (en $). Se muestra como "estimado".
 * Sale solo de SUS ventas reales: lo que facturaba por mes en los últimos 6 meses, menos lo que factura hoy.
 * Si no vendió nada en 180 días aporta $0 (va a "Publicaciones abandonadas").
 * Por construcción, la suma nunca supera el promedio mensual facturado de la cuenta en los últimos 6 meses.
 */
export function lostSalesEstimate(it, cls) {
  const h = itemHistory(it);
  if (h.abandoned) return 0;
  switch (cls.category) {
    case 'OPERATIVO': // hoy no puede vender: se pierde lo que vendía por mes
      return h.monthlyRevenue;
    case 'SIN_VISITAS':
    case 'SIN_VENTAS': // vende menos que su propio promedio
      return Math.max(0, h.monthlyRevenue - h.revenue30);
    default:
      return 0;
  }
}

const PROBLEM_LABELS = {
  sin_stock: 'Publicaciones sin stock',
  pausada: 'Publicaciones pausadas',
  infraccion: 'Publicaciones con infracción',
  bajo_revision: 'Publicaciones bajo revisión',
  calidad_baja: 'Calidad de publicación baja',
  acciones_pendientes: 'Mejoras pendientes que marca Mercado Libre',
  titulo_corto: 'Títulos sin palabras clave',
  publicacion_gratuita: 'Publicaciones gratuitas sin exposición',
  publicacion_clasica: 'Publicaciones Clásicas (sin cuotas)',
  sin_full_flex: 'Sin Full ni Flex',
  sin_envio_gratis: 'Sin envío gratis',
  fuera_catalogo: 'Fuera del catálogo',
  pocas_fotos: 'Pocas fotos',
  precio_alto: 'Precio arriba de la competencia',
  sin_cuotas: 'Sin cuotas sin interés',
  preguntas_sin_responder: 'Preguntas sin responder',
  reputacion: 'Reputación que frena compras',
  margen_negativo: 'Productos que venden a pérdida',
  debajo_reposicion: 'Ventas por debajo del costo de reposición',
  visibilidad_general: 'Poca visibilidad',
  conversion_general: 'Baja conversión',
};
export { PROBLEM_LABELS };

const TOP_N = 10;
const topItems = (list) => [...list]
  .sort((a, b) => itemHistory(b.it).units180 - itemHistory(a.it).units180 || itemHistory(b.it).revenue180 - itemHistory(a.it).revenue180)
  .slice(0, TOP_N)
  .map((r) => ({ id: r.it.id, title: r.it.title, sold: itemHistory(r.it).units180, permalink: r.it.permalink || null }));

/**
 * Ranking de problemas: cada publicación entra UNA sola vez, en su problema principal, con su propio estimado.
 * Las que no vendieron en 180 días van aparte (abandoned) y "Sin Full ni Flex" es solo recomendación (tips).
 */
export function rankProblems(rows) {
  const agg = {};
  const abandoned = [];
  const fullFlex = [];
  for (const r of rows) {
    if ((r.cls.reasons || []).some((x) => x.code === 'sin_full_flex')) fullFlex.push(r);
    const code = primaryReason(r.cls);
    const loss = r.profit?.net < 0 ? -r.profit.net : 0;
    if (!code) continue;
    if (itemHistory(r.it).abandoned && !loss) { abandoned.push(r); continue; }
    const a = (agg[code] ||= { code, label: PROBLEM_LABELS[code] || code, rows: [], impact: 0 });
    a.rows.push(r);
    a.impact += (r.lost || 0) + loss;
  }
  const problems = Object.values(agg)
    .map((a) => ({ code: a.code, label: a.label, impact: a.impact, items: a.rows.map((r) => r.it.id), top: topItems(a.rows), more: Math.max(0, a.rows.length - TOP_N) }))
    .sort((a, b) => b.impact - a.impact || b.items.length - a.items.length);
  return {
    problems,
    abandoned: { count: abandoned.length, items: abandoned.map((r) => r.it.id), top: abandoned.slice(0, TOP_N).map((r) => ({ id: r.it.id, title: r.it.title, sold: 0, permalink: r.it.permalink || null })), more: Math.max(0, abandoned.length - TOP_N) },
    tips: fullFlex.length ? [{ code: 'sin_full_flex', label: PROBLEM_LABELS.sin_full_flex, count: fullFlex.length, top: topItems(fullFlex), more: Math.max(0, fullFlex.length - TOP_N) }] : [],
  };
}

// ─────────────────────────────── Plan de acción por reglas ─────────────────
// Base para la IA y respaldo si la IA no está disponible.
const ACTIONS = {
  sin_stock: (it) => ({ title: 'Reponé stock o activá la reposición', detail: `Vendía ~${Math.round((it.sales90 || 0) / 3)} u/mes. Cargá stock aunque sea 1 unidad para no perder el posicionamiento ganado.`, impact: 'alto' }),
  pausada: () => ({ title: 'Reactivá la publicación', detail: 'Pausada no suma visitas ni historial. Si la pausaste por precio o stock, corregilo y reactivala.', impact: 'alto' }),
  infraccion: () => ({ title: 'Resolvé la infracción', detail: 'Entrá a la publicación en Mercado Libre, leé el motivo y corregí el dato marcado (título, foto o atributo).', impact: 'alto' }),
  bajo_revision: () => ({ title: 'Revisá lo que pide Mercado Libre', detail: 'Está bajo revisión: completá o corregí lo que te pidan para que vuelva a mostrarse.', impact: 'alto' }),
  calidad_baja: (it) => ({ title: 'Subí la calidad de la publicación', detail: `Puntaje ${it.quality?.score ?? 'sin dato'}/100. Completá las mejoras que marca Mercado Libre: suben la exposición.`, impact: 'alto' }),
  acciones_pendientes: (it) => ({ title: 'Completá las mejoras pendientes de Mercado Libre', detail: (it.quality?.pending_actions || []).slice(0, 3).join(' · ') || 'Revisá la sección de calidad de la publicación.', impact: 'alto' }),
  titulo_corto: (it) => ({ title: 'Reescribí el título con palabras clave', detail: `Hoy tiene ${(it.title || '').length} caracteres. Usá producto + marca + modelo + atributo clave (hasta 60).`, impact: 'medio' }),
  publicacion_gratuita: () => ({ title: 'Pasala a Clásica o Premium', detail: 'Las gratuitas casi no aparecen en las búsquedas.', impact: 'alto' }),
  publicacion_clasica: () => ({ title: 'Probá Premium', detail: 'Premium suma exposición y cuotas sin interés. Revisá que el margen lo banque.', impact: 'medio' }),
  sin_full_flex: () => ({ title: 'Sumá Flex o Full', detail: 'La entrega rápida pesa en el ranking y en la decisión de compra.', impact: 'medio' }),
  sin_envio_gratis: () => ({ title: 'Ofrecé envío gratis', detail: 'Si el margen lo permite, absorbé el envío o incluilo en el precio.', impact: 'medio' }),
  fuera_catalogo: () => ({ title: 'Competí en el catálogo', detail: 'Existe la ficha de catálogo de tu producto: opta por ganar la compra ahí.', impact: 'alto' }),
  pocas_fotos: (it) => ({ title: 'Sumá fotos', detail: `Tiene ${it.pictures_count ?? 0}. Agregá fondo blanco, en uso, detalle y medidas (mínimo 6).`, impact: 'medio' }),
  precio_alto: (it) => ({ title: 'Ajustá el precio a la competencia', detail: `Tu precio ${fmt(it.price)} vs. referencia ${fmt(competitorRef(it))}. Bajalo o sumá valor (envío, cuotas, combo).`, impact: 'alto' }),
  sin_cuotas: () => ({ title: 'Ofrecé cuotas sin interés', detail: 'Pasá a Premium o activá campañas de cuotas: ayuda mucho en tickets altos.', impact: 'medio' }),
  preguntas_sin_responder: (it) => ({ title: 'Respondé las preguntas ya', detail: `Hay ${it.questions_unanswered} sin responder. Cada pregunta sin respuesta es una venta que se va a otro.`, impact: 'alto' }),
  reputacion: () => ({ title: 'Cuidá la reputación', detail: 'Despachá a tiempo y evitá cancelaciones: la reputación pesa en la conversión.', impact: 'medio' }),
  margen_negativo: (it, p) => ({ title: 'Subí el precio o dejá de venderlo', detail: `Precio mínimo sin pérdida: ${fmt(p?.minPrice)}. Sugerido: ${fmt(p?.suggestedPrice)}.`, impact: 'alto' }),
  debajo_reposicion: (it, p) => ({ title: 'Actualizá el precio al costo de reposición', detail: `Reponerlo te cuesta ${fmt(p?.replacementUnit)} por unidad. Con el precio actual, cada venta te descapitaliza.`, impact: 'alto' }),
  visibilidad_general: () => ({ title: 'Probá Product Ads con presupuesto chico', detail: 'Si la ficha está completa, un empujón de publicidad te dice si hay demanda.', impact: 'medio' }),
  conversion_general: () => ({ title: 'Mejorá la ficha', detail: 'Revisá la primera foto, la descripción y los atributos: es lo primero que mira el comprador.', impact: 'medio' }),
  margen_finito: (it, p) => ({ title: 'Revisá el margen', detail: `Margen ${pct(p?.margin)}. Precio sugerido para 20 %: ${fmt(p?.suggestedPrice)}.`, impact: 'medio' }),
  costo_sin_cargar: () => ({ title: 'Cargá el costo del producto', detail: 'Sin costo no podemos decirte si te deja plata.', impact: 'bajo' }),
};

export function buildRulePlan(it, cls, profit) {
  if (cls.noDemand) {
    return {
      verdict: 'liquidar',
      headline: 'Este producto no tiene salida: liquidalo o pausalo.',
      actions: [
        { title: 'Liquidá el stock', detail: 'Bajá el precio hasta recuperar el costo y liberá esa plata para productos que sí rotan.', impact: 'alto' },
        { title: 'O pausalo y no repongas', detail: `Visitas 30 días: ${it.visits30 ?? 'sin dato'}. Ventas 90 días: ${it.sales90 ?? 0}. Competidores: ${it.competition?.count ?? 'sin dato'}.`, impact: 'medio' },
      ],
      source: 'reglas',
    };
  }
  const sorted = [...(cls.reasons || [])].sort((a, b) => b.weight - a.weight);
  const actions = [];
  for (const r of sorted) {
    const f = ACTIONS[r.code];
    if (f) actions.push(f(it, profit));
    if (actions.length >= 5) break;
  }
  const headline = {
    OPERATIVO: 'Arreglá esto primero: hoy no puede vender.',
    SIN_VISITAS: 'El problema es que casi nadie la ve.',
    SIN_VENTAS: 'La ven, pero no la compran.',
    PIERDE_PLATA: 'Vende, pero te hace perder plata.',
    SANA: 'Está bien. Mantenela así.',
  }[cls.category];
  return { verdict: cls.category === 'SANA' ? 'mantener' : 'mejorar', headline, actions, source: 'reglas' };
}

// ─────────────────────────────── Rentabilidad ──────────────────────────────
/**
 * @param lines ventas del producto: [{qty, unit_price, fees:{commission,shipping,financing,taxes,other}, estimated:boolean}]
 * @param cost { purchase, replacement } (por unidad) o null
 * @param ads  { amount } publicidad asignada al producto en el período
 */
export function computeProductProfit(lines, cost, ads = 0) {
  const units = lines.reduce((s, l) => s + (l.qty || 0), 0);
  const revenue = lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0);
  const f = { commission: 0, shipping: 0, financing: 0, taxes: 0, other: 0 };
  let estimated = false;
  let taxesUnknown = false;
  for (const l of lines) {
    for (const k of Object.keys(f)) f[k] += l.fees?.[k] || 0;
    if (l.estimated) estimated = true;
    if (l.taxes_unknown) taxesUnknown = true;
  }
  const fees = f.commission + f.shipping + f.financing + f.taxes + f.other;
  const hasCost = !!(cost && cost.purchase != null && cost.purchase !== '' && !Number.isNaN(Number(cost.purchase)));
  const base = { units, revenue, fees: f, feesTotal: fees, ads, estimated, taxesUnknown, hasCost };
  if (!hasCost) return { ...base, net: null, margin: null, netReplacement: null, marginReplacement: null, minPrice: null, suggestedPrice: null };

  const pu = Number(cost.purchase);
  const ru = cost.replacement != null && cost.replacement !== '' ? Number(cost.replacement) : null;
  const net = revenue - fees - ads - units * pu;
  const netR = ru != null ? revenue - fees - ads - units * ru : null;

  // Precio mínimo sin pérdida: costo unitario (el mayor entre compra y reposición) + cargos fijos por unidad,
  // dividido por (1 - cargos variables %).
  const unitCost = Math.max(pu, ru ?? 0);
  const varRate = revenue > 0 ? (f.commission + f.financing + f.taxes) / revenue : 0.16; // 16 % si no hay ventas
  const fixedPerUnit = units > 0 ? (f.shipping + f.other + ads) / units : 0;
  const denom = 1 - varRate;
  const minPrice = denom > 0 ? (unitCost + fixedPerUnit) / denom : null;
  const denomS = 1 - varRate - T.TARGET_MARGIN;
  const suggestedPrice = denomS > 0 ? (unitCost + fixedPerUnit) / denomS : null;

  return {
    ...base,
    purchaseUnit: pu,
    replacementUnit: ru,
    net,
    margin: revenue > 0 ? net / revenue : null,
    netReplacement: netR,
    marginReplacement: netR != null && revenue > 0 ? netR / revenue : null,
    minPrice,
    suggestedPrice,
  };
}

export function replacementWarning(p) {
  if (!p || p.marginReplacement == null) return null;
  if (p.marginReplacement < 0) return 'Estás vendiendo por debajo de lo que te cuesta reponer.';
  if (p.margin != null && p.margin - p.marginReplacement > T.REPLACEMENT_GAP_ALERT) return 'Estás vendiendo por debajo de lo que te cuesta reponer: tu margen real es mucho menor.';
  return null;
}

/** Reparte un gasto mensual entre productos según su facturación. */
export function prorate(total, revenueByKey) {
  const sum = Object.values(revenueByKey).reduce((s, v) => s + v, 0);
  const out = {};
  for (const [k, v] of Object.entries(revenueByKey)) out[k] = sum > 0 ? (total * v) / sum : 0;
  return out;
}

// ─────────────────────────────── Alertas ───────────────────────────────────
/** Devuelve la lista de alertas vigentes. Cada una tiene un `key` estable para no repetir emails. */
export function buildAlerts({ rows, seller, prevReputation }) {
  const out = [];
  const add = (kind, it, message, severity = 'bad') =>
    out.push({ key: `${kind}:${it?.id || 'cuenta'}`, kind, item_id: it?.id || null, title: it?.title || null, message, severity });
  for (const { it, profit } of rows) {
    if (profit?.hasCost && profit.units > 0 && profit.net < 0) add('margen_negativo', it, `Margen negativo: perdiste ${fmt(-profit.net)} en 30 días.`);
    if (profit?.hasCost && profit.units > 0 && profit.marginReplacement != null && profit.marginReplacement < 0) add('debajo_reposicion', it, 'Vendés por debajo del costo de reposición.');
    if ((it.available_quantity ?? 1) === 0 || (it.sub_status || []).includes('out_of_stock')) add('sin_stock', it, 'Se quedó sin stock.');
    else if (it.status === 'paused') add('pausada', it, 'La publicación está pausada.', 'warn');
    if (it.infraction || it.status === 'under_review' || (it.sub_status || []).some((s) => ['forbidden', 'warning', 'held'].includes(s))) add('infraccion', it, 'Tiene una infracción o está bajo revisión.');
    if ((it.oldest_question_hours ?? 0) > T.QUESTION_ALERT_HOURS) add('preguntas', it, `Tiene ${it.questions_unanswered} pregunta(s) sin responder hace más de ${T.QUESTION_ALERT_HOURS} h.`, 'warn');
  }
  const rank = (l) => ({ '5_green': 5, '4_light_green': 4, '3_yellow': 3, '2_orange': 2, '1_red': 1 }[l] || 0);
  const now = seller?.reputation?.level_id;
  if (prevReputation && now && rank(now) < rank(prevReputation)) {
    out.push({ key: `reputacion:${now}`, kind: 'reputacion', item_id: null, title: null, message: `Tu reputación bajó de ${prevReputation} a ${now}.`, severity: 'bad' });
  }
  return out;
}

export const ALERT_LABELS = {
  margen_negativo: 'Margen negativo',
  debajo_reposicion: 'Debajo del costo de reposición',
  sin_stock: 'Sin stock',
  pausada: 'Pausada',
  infraccion: 'Infracción / revisión',
  preguntas: 'Preguntas sin responder',
  reputacion: 'Reputación',
};

export { CATEGORIES };
