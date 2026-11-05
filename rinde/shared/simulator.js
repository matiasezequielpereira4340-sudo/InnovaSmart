// Rinde — Simulador de campaña de publicidad (Product Ads) para UNA publicación. Solo Plan Rinde.
// Cuentas: clics = gasto / costo por clic; ventas = clics × conversión; facturación = ventas × precio;
// cargos de MeLi por venta = chargesAt (listing_prices y lo que pagó antes, SIEMPRE el más caro);
// ACOS = gasto / facturación; te queda = facturación − cargos − gasto − costo del producto.
// Mercado Libre no informa a cuántas personas vas a llegar: no se estima alcance. "Visitas estimadas" = clics.
import { perSale } from './campaigns.js';

export const SIM_NOTE = 'Es una simulación con tus números: el resultado real depende de Mercado Libre.';
export const MIN_CLICKS = 30;   // clics mínimos para usar el costo por clic / conversión de tu propia publicidad
export const MIN_VISITS = 30;   // visitas mínimas para usar la conversión de la publicación
export const TARGET_CUSHION = 0.8; // ACOS objetivo = 80 % del máximo: deja un colchón por si los cargos o el clic suben
export const TRIAL_CLICKS = 100;   // para medir tu conversión real hacen falta ~100 clics

// Supuestos SOLO cuando no hay ningún dato propio. Se muestran como supuestos y se pueden cambiar.
export const ASSUMED_CPC = { pesimista: 300, medio: 150, optimista: 80 };      // $ por clic
export const ASSUMED_CONV = { pesimista: 0.005, medio: 0.01, optimista: 0.02 }; // 0,5 % · 1 % · 2 %
export const CONV_SPREAD = { pesimista: 0.5, medio: 1, optimista: 1.5 };        // alrededor del promedio de tu cuenta

const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const pctTxt = (n) => (Math.round(n * 1000) / 10).toString().replace('.', ',') + ' %';
const unitsOf = (a) => (a?.direct_units != null || a?.indirect_units != null ? (a.direct_units || 0) + (a.indirect_units || 0) : a?.units ?? null);

/**
 * De dónde sale cada número. Prioridad: publicidad de esta publicación → resto de tu publicidad → historial de la publicación
 * → promedio de la cuenta. Si no hay dato, null (se arman escenarios con supuestos).
 * @param o { adsItem: {cost, clicks, direct_units, indirect_units}, adsAccount: {cost, clicks, units}, item: {visits30, sales30}, avgConv }
 */
export function simSources({ adsItem = null, adsAccount = null, item = {}, avgConv = null } = {}) {
  let cpc = null;
  if (adsItem?.clicks >= MIN_CLICKS && adsItem.cost > 0) cpc = { value: adsItem.cost / adsItem.clicks, source: 'tu publicidad de esta publicación', detail: `${fmt(adsItem.cost)} en ${adsItem.clicks} clics, últimos 30 días` };
  else if (adsAccount?.clicks >= MIN_CLICKS && adsAccount.cost > 0) cpc = { value: adsAccount.cost / adsAccount.clicks, source: 'el promedio de toda tu publicidad', detail: `${fmt(adsAccount.cost)} en ${adsAccount.clicks} clics, últimos 30 días` };

  let conv = null;
  const u = unitsOf(adsItem);
  if (adsItem?.clicks >= MIN_CLICKS && u != null) conv = { value: u / adsItem.clicks, source: 'tu publicidad de esta publicación', detail: `${u} venta${u === 1 ? '' : 's'} en ${adsItem.clicks} clics` };
  else if ((item.visits30 || 0) >= MIN_VISITS) conv = { value: (item.sales30 || 0) / item.visits30, source: 'el historial de esta publicación', detail: `${item.sales30 || 0} venta${item.sales30 === 1 ? '' : 's'} en ${item.visits30} visitas, últimos 30 días` };
  if (conv && conv.value === 0) conv = { ...conv, zero: true };
  return { cpc, conv, avgConv: avgConv > 0 ? avgConv : null };
}

/**
 * Escenarios: uno solo ("con tus datos") si hay costo por clic y conversión propios; si falta alguno, tres
 * (pesimista, medio, optimista) y se explica de dónde sale cada rango. Lo que el usuario escribe a mano manda.
 */
export function scenarios(src, manual = {}) {
  const cpcM = manual.cpc > 0 ? { value: manual.cpc, source: 'lo que cargaste', detail: 'dato tuyo' } : null;
  const convM = manual.conv > 0 ? { value: manual.conv, source: 'lo que cargaste', detail: 'dato tuyo' } : null;
  const cpc = cpcM || src.cpc;
  const conv = convM || (src.conv && !src.conv.zero ? src.conv : null);
  if (cpc && conv) return { single: true, list: [{ key: 'tus_datos', label: 'Con tus datos', cpc: cpc.value, conv: conv.value }], cpc, conv, explain: [] };
  const explain = [];
  if (!cpc) explain.push(`Costo por clic: no tenemos el tuyo (todavía no hiciste publicidad con ${MIN_CLICKS} clics o más). Usamos supuestos de ${fmt(ASSUMED_CPC.optimista)} a ${fmt(ASSUMED_CPC.pesimista)}: no son datos de Mercado Libre. Cambialo por el que te muestra Mercado Libre al armar la campaña.`);
  if (!conv) {
    if (src.conv?.zero) explain.push(`Conversión: ${src.conv.detail}, así que con tus datos daría 0 ventas. Para ver qué pasaría si empieza a vender usamos ${src.avgConv ? 'la mitad, el promedio y 1,5 veces la conversión promedio de tu cuenta' : 'supuestos de 0,5 %, 1 % y 2 %'}.`);
    else if (src.avgConv) explain.push(`Conversión: esta publicación no tiene ${MIN_VISITS} visitas en 30 días. Usamos la mitad, el promedio y 1,5 veces la conversión promedio de tu cuenta (${pctTxt(src.avgConv)}).`);
    else explain.push('Conversión: no hay visitas suficientes en tu cuenta para calcularla. Usamos supuestos de 0,5 %, 1 % y 2 % (no son datos de Mercado Libre).');
  }
  const list = ['pesimista', 'medio', 'optimista'].map((k) => ({
    key: k, label: k.charAt(0).toUpperCase() + k.slice(1),
    cpc: cpc ? cpc.value : ASSUMED_CPC[k],
    conv: conv ? conv.value : src.avgConv ? src.avgConv * CONV_SPREAD[k] : ASSUMED_CONV[k],
  }));
  return { single: false, list, cpc, conv, explain };
}

/**
 * Una corrida del simulador.
 * @param p { price, budget (por día), days, cpc, conv, ctx (para chargesAt), cost (por unidad o null) }
 */
export function simulate({ price, budget, days, cpc, conv, ctx = {}, cost = null }) {
  const unit = perSale(price, ctx, { cost });
  const spend = Math.max(0, budget) * Math.max(0, days);
  const clicks = cpc > 0 ? spend / cpc : 0;
  const sales = clicks * Math.max(0, conv);
  const revenue = sales * price;
  if (!unit) return { spend, clicks, visits: clicks, sales, revenue, noFees: true };
  const charges = sales * unit.charges.total;
  const beforeCost = revenue - charges - spend;
  const hasCost = cost != null && cost !== '' && Number.isFinite(Number(cost));
  const productCost = hasCost ? sales * Number(cost) : null;
  const left = hasCost ? beforeCost - productCost : null;
  const acos = revenue > 0 ? spend / revenue : null;
  // ACOS máximo que aguanta sin perder plata = lo que queda por venta antes de publicidad / precio.
  const maxAcos = hasCost ? (unit.beforeCost - Number(cost)) / price : null;
  const maxAcosBeforeCost = unit.beforeCost / price;
  return {
    spend, clicks, visits: clicks, sales, revenue, unit, charges, beforeCost, productCost, left, acos,
    maxAcos, maxAcosBeforeCost, hasCost,
    targetAcos: maxAcos != null && maxAcos > 0 ? Math.floor(maxAcos * TARGET_CUSHION * 100) / 100 : null,
    // Sin costo no hay veredicto.
    verdict: !hasCost ? null : maxAcos <= 0 ? 'pierde_sin_ads' : left > 0 ? 'gana' : 'pierde',
    acosOverMargin: hasCost && acos != null && acos > maxAcos,
  };
}

/** Presupuesto diario sugerido para una prueba de 7 días: el que junta ~100 clics con el costo por clic medio. */
export function trialBudget(cpcMedio, days = 7) {
  return Math.max(500, Math.ceil(((TRIAL_CLICKS * cpcMedio) / days) / 100) * 100);
}

export const fmtSim = { money: fmt, pct: pctTxt };

/** Ventas sin decimales: "menos de 1", "1", "unas 4". */
export function fmtSales(n) {
  if (!(n >= 1)) return n > 0 ? 'menos de 1' : '0';
  const r = Math.round(n);
  return Math.abs(n - r) < 0.05 ? String(r) : `unas ${r}`;
}

export const NOTA_MIN_ADS = 75; // por debajo, primero se arregla la publicación
/**
 * ¿Tiene sentido pagar publicidad hoy? MeLi no publicita publicaciones pausadas ni sin stock: ahí no se simula.
 * Con nota menor a 75, 0 visitas en 30 días o abandonada: primero subir la nota (el simulador queda plegado).
 * @param r fila del modelo ({ it, score, group })
 * @returns { block: true, text } | { first: true, text, reasons, improvements } | null
 */
export function adReadiness(r) {
  const it = r.it;
  const noStock = (it.available_quantity ?? 1) <= 0 || (it.sub_status || []).includes('out_of_stock');
  const paused = it.status === 'paused';
  const review = it.status === 'under_review';
  const improvements = (r.score?.improvements || []).slice(0, 3).map((x) => x.text);
  const reasons = [];
  if (r.score?.score != null && r.score.score < NOTA_MIN_ADS) reasons.push(`la nota es ${r.score.score}/100`);
  if (it.visits30 === 0) reasons.push('tuvo 0 visitas en 30 días');
  if (r.group === 'ABANDONADAS') reasons.push('no vendió nada en 6 meses');
  const first = reasons.length ? { reasons, improvements, text: 'Antes de pagar publicidad, subí la nota' } : null;
  if (noStock || paused || review) {
    const text = review ? 'Está en revisión de Mercado Libre: resolvelo antes de hacer publicidad.'
      : paused && noStock ? 'Está pausada y sin stock: reponé y reactivala antes de hacer publicidad.'
      : paused ? 'Está pausada: reactivala antes de hacer publicidad.'
      : 'Está sin stock: reponé y reactivala antes de hacer publicidad.';
    return { block: true, text, then: first };
  }
  return first ? { first: true, ...first } : null;
}
