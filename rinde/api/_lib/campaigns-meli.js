// Lectura (SOLO LECTURA) de campañas/promociones y Product Ads desde Mercado Libre.
// Rinde nunca activa, cambia ni da de baja nada: solo GET.
// Límites: pedidos de a lotes chicos, concurrencia baja y reintento con espera ante 429 (meliRaw lo hace).
import { meliRaw, pool } from './meli.js';
import { feeParts, compareFee } from '../../shared/campaigns.js';

const PROMO_V = 'app_version=v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET crudo con un reintento extra si MeLi responde 429 (rate limit). */
async function getRaw(t, path, headers = {}) {
  let r = await meliRaw(t, path, headers);
  if (r.status === 429) { await sleep(3000); r = await meliRaw(t, path, headers); }
  return r;
}

const keysOf = (b) => (b && typeof b === 'object' ? (Array.isArray(b) ? ['(lista)'] : Object.keys(b).slice(0, 12)) : []);
const countOf = (b) => (Array.isArray(b) ? b.length : Array.isArray(b?.results) ? b.results.length : Array.isArray(b?.data) ? b.data.length : null);
const probeRow = (name, path, r, extra = {}) => ({
  name, path, status: r.status, ms: r.ms, count: countOf(r.body), keys: keysOf(r.body),
  message: r.status >= 400 ? String(r.body?.message || r.body?.error || '').slice(0, 160) : null, ...extra,
});

/**
 * Prueba de acceso: qué devuelve MeLi para cada lectura que necesita la función de Campañas.
 * No guarda datos del vendedor: solo estado, cantidad y nombres de campos.
 */
export async function probeCampaignsAccess(t, sellerId, sampleItem) {
  const rows = [];
  const promos = await getRaw(t, `/seller-promotions/users/${sellerId}?${PROMO_V}`);
  const list = Array.isArray(promos.body?.results) ? promos.body.results : [];
  const types = [...new Set(list.map((p) => p.type))];
  rows.push(probeRow('Campañas del vendedor (todas)', `/seller-promotions/users/{id}`, promos, { types, boost: list.some((p) => p.benefits || p.meli_percentage != null) }));
  const first = list[0];
  if (first) {
    const it = await getRaw(t, `/seller-promotions/promotions/${first.id}/items?promotion_type=${first.type}&${PROMO_V}&limit=5`);
    const ex = it.body?.results?.[0];
    rows.push(probeRow(`Publicaciones de una campaña (${first.type})`, `/seller-promotions/promotions/{id}/items`, it, { fields: ex ? Object.keys(ex).slice(0, 20) : [] }));
  } else {
    rows.push({ name: 'Publicaciones de una campaña', path: '/seller-promotions/promotions/{id}/items', status: null, message: 'Sin campañas para probar (la lista vino vacía).' });
  }
  if (sampleItem) {
    const ip = await getRaw(t, `/seller-promotions/items/${sampleItem.id}?${PROMO_V}`);
    rows.push(probeRow('Promociones de una publicación', `/seller-promotions/items/{item_id}`, ip, { fields: Array.isArray(ip.body) && ip.body[0] ? Object.keys(ip.body[0]).slice(0, 20) : [] }));
    const lp = await getRaw(t, `/sites/MLA/listing_prices?price=${Math.round(sampleItem.price || 10000)}&listing_type_id=${sampleItem.listing_type || 'gold_special'}${sampleItem.category_id ? `&category_id=${sampleItem.category_id}` : ''}`);
    rows.push(probeRow('Cargos de MeLi a un precio (listing_prices)', `/sites/MLA/listing_prices`, lp));
  }
  const adv = await getRaw(t, `/advertising/advertisers?product_id=PADS`, { 'Api-Version': '1' });
  const a = adv.body?.advertisers?.find((x) => x.site_id === 'MLA') || adv.body?.advertisers?.[0];
  rows.push(probeRow('Product Ads: anunciante', `/advertising/advertisers?product_id=PADS`, adv, { advertiser: !!a }));
  if (a) {
    const mx = await readAdsMetrics(t, a.advertiser_id);
    for (const x of mx.tried) rows.push({ name: `Product Ads: métricas por ${x.what}`, path: '', status: x.status, count: x.rows, message: x.status === 200 ? (x.withMetrics ? `${x.withMetrics} con métricas` : 'respondió SIN métricas') : null });
    const sample = Object.values(mx.byItem)[0] || mx.campaigns.find((c) => c.metrics)?.metrics || null;
    rows.push({ name: 'Product Ads: resultado', path: '', status: mx.source ? 200 : null,
      message: mx.source ? `métricas por ${mx.source} (${mx.period.from} a ${mx.period.to})${sample?.missing?.length ? ` · faltan: ${sample.missing.join(', ')}` : ' · completas'}` : 'Mercado Libre no devolvió métricas por ninguna vía' });
  }
  return { rows, at: new Date().toISOString() };
}

/**
 * Verifica listing_prices contra cargos reales ya facturados, COMPONENTE POR COMPONENTE
 * (comisión, cargo fijo y cuotas), así se compara lo mismo con lo mismo.
 * @param samples [{ key, price, listing_type, category_id, installments, billed: {commission, fixed, financing} }]
 */
export async function checkFeesAgainstBilling(t, samples) {
  const fees = await readFees(t, samples.map((x) => ({ key: x.key, price: x.price, listing_type: x.listing_type, category_id: x.category_id })));
  return samples.map((x) => {
    const f = fees[x.key];
    const real = x.billed.commission + x.billed.fixed + x.billed.financing;
    if (!f) return { price: x.price, listing_type: x.listing_type, category_id: x.category_id, real, meli: null, diffPct: null, cause: 'MeLi no devolvió el cargo para este precio' };
    const m = feeParts(f, x.price);
    const cmp = compareFee(m, x.billed, x);
    const noFin = (m.commission + m.fixed) - (x.billed.commission + x.billed.fixed);
    return {
      price: x.price, listing_type: x.listing_type, category_id: x.category_id, installments: x.installments ?? null,
      real, meli: m.total, diffPct: real ? (m.total - real) / real : null,
      // Sin cuotas (comisión + cargo fijo), que es lo que se puede comparar siempre.
      diffNoFinancingPct: x.billed.commission + x.billed.fixed ? noFin / (x.billed.commission + x.billed.fixed) : null,
      parts: cmp.parts, same: cmp.same, cause: cmp.cause,
    };
  });
}

// ── Métricas de Product Ads ──
// Pedimos las métricas con fechas y lista explícita (api-version 2). Según un reporte de desarrolladores, MeLi
// sacó las métricas por aviso (ads/search) el 30/05/2026 y ahora vienen por grupo de anuncios (ad_groups/search).
// Probamos en orden y usamos la primera que devuelva métricas; si ninguna, decimos cuáles faltan.
const METRICS_FULL = 'clicks,prints,cost,cpc,acos,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,units_quantity';
const METRICS_MIN = 'clicks,prints,cost,total_amount,units_quantity';
const ymd = (d) => d.toISOString().slice(0, 10);
const range30 = () => ({ from: ymd(new Date(Date.now() - 30 * 86400000)), to: ymd(new Date(Date.now() - 86400000)) });
const num0 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Normaliza las métricas de MeLi. Los nombres que no vienen quedan en null (nunca en 0). */
export function normMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {
    cost: num0(m.cost), clicks: num0(m.clicks), prints: num0(m.prints),
    direct_amount: num0(m.direct_amount), indirect_amount: num0(m.indirect_amount), total_amount: num0(m.total_amount),
    direct_units: num0(m.direct_units_quantity ?? m.direct_items_quantity), indirect_units: num0(m.indirect_units_quantity ?? m.indirect_items_quantity),
    units: num0(m.units_quantity ?? m.advertising_items_quantity), acos_meli: num0(m.acos),
  };
  if (out.total_amount == null && out.direct_amount != null && out.indirect_amount != null) out.total_amount = out.direct_amount + out.indirect_amount;
  out.missing = ['cost', 'clicks', 'prints', 'total_amount', 'direct_amount', 'indirect_amount'].filter((k) => out[k] == null);
  return out.cost == null && out.total_amount == null && out.clicks == null ? null : out;
}
const metricsIn = (x) => normMetrics(x?.metrics || x?.metrics_summary || null);
const sumMetrics = (a, b) => {
  if (!a) return b; if (!b) return a;
  const o = { ...a };
  for (const k of ['cost', 'clicks', 'prints', 'direct_amount', 'indirect_amount', 'total_amount', 'direct_units', 'indirect_units', 'units']) o[k] = a[k] == null && b[k] == null ? null : (a[k] || 0) + (b[k] || 0);
  o.missing = a.missing.filter((k) => b.missing.includes(k));
  return o;
};

async function searchPaged(t, path, headers, max = 500) {
  const rows = [];
  let status = null;
  for (let offset = 0; offset < max; offset += 50) {
    const r = await getRaw(t, `${path}${path.includes('?') ? '&' : '?'}limit=50&offset=${offset}`, headers);
    status = r.status;
    if (r.status !== 200) return { status, rows, body: r.body };
    const list = r.body?.results || [];
    rows.push(...list);
    if (list.length < 50) break;
  }
  return { status, rows };
}

/**
 * Métricas de los últimos 30 días por publicación (o por campaña si MeLi no da más detalle).
 * @returns { byItem: {item_id: metrics}, campaigns: [{id, name, metrics}], source, tried: [{what, status, withMetrics}] }
 */
export async function readAdsMetrics(t, advertiserId) {
  const H = { 'api-version': '2' };
  const { from, to } = range30();
  const tried = [];
  const byItem = {};
  const base = `/advertising/MLA/advertisers/${advertiserId}/product_ads`;
  // 1) Por aviso
  for (const metrics of [METRICS_FULL, METRICS_MIN]) {
    const r = await searchPaged(t, `${base}/ads/search?date_from=${from}&date_to=${to}&metrics=${metrics}&metrics_summary=true`, H);
    const withM = r.rows.filter((x) => metricsIn(x)).length;
    tried.push({ what: `avisos (ads/search${metrics === METRICS_MIN ? ', métricas mínimas' : ''})`, status: r.status, rows: r.rows.length, withMetrics: withM });
    if (withM) { for (const x of r.rows) { const m = metricsIn(x); if (m) byItem[x.item_id || x.id] = m; } break; }
    if (r.status === 200) break; // respondió bien pero sin métricas: no insistir con la lista mínima
  }
  // 2) Por grupo de anuncios (ITEM → publicación)
  if (!Object.keys(byItem).length) {
    let r = await searchPaged(t, `${base}/ad_groups/search?date_from=${from}&date_to=${to}&metrics=${METRICS_FULL}`, H);
    tried.push({ what: 'grupos de anuncios (ad_groups/search, 30 días)', status: r.status, rows: r.rows.length, withMetrics: r.rows.filter((x) => metricsIn(x)).length });
    if (r.status === 400 || (r.status === 200 && !r.rows.some((x) => metricsIn(x)))) {
      // Algunas versiones solo aceptan un día: sumamos día por día (30 pedidos, de a uno).
      let any = 0;
      for (let d = 1; d <= 30; d++) {
        const day = ymd(new Date(Date.now() - d * 86400000));
        const rd = await searchPaged(t, `${base}/ad_groups/search?date_from=${day}&date_to=${day}&metrics=${METRICS_FULL}`, H, 200);
        if (rd.status !== 200) { tried.push({ what: 'grupos de anuncios por día', status: rd.status, rows: 0, withMetrics: 0 }); break; }
        for (const x of rd.rows) {
          const m = metricsIn(x);
          const id = x.item_id || (String(x.ad_group_type || x.type || '').toUpperCase() === 'ITEM' ? x.ad_group_external_id : null);
          if (m && id) { byItem[id] = sumMetrics(byItem[id], m); any++; }
        }
      }
      if (any) tried.push({ what: 'grupos de anuncios por día (sumados)', status: 200, rows: any, withMetrics: any });
    } else {
      for (const x of r.rows) {
        const m = metricsIn(x);
        const id = x.item_id || (String(x.ad_group_type || x.type || '').toUpperCase() === 'ITEM' ? x.ad_group_external_id : null);
        if (m && id) byItem[id] = m;
      }
    }
  }
  // 3) Por campaña (resumen)
  const rc = await searchPaged(t, `${base}/campaigns/search?date_from=${from}&date_to=${to}&metrics=${METRICS_FULL}`, H, 100);
  const campaigns = rc.rows.map((c) => ({ id: c.id || c.campaign_id, name: c.name || c.campaign_name || `Campaña ${c.id}`, metrics: metricsIn(c) }));
  tried.push({ what: 'campañas (campaigns/search)', status: rc.status, rows: rc.rows.length, withMetrics: campaigns.filter((c) => c.metrics).length });
  const source = Object.keys(byItem).length ? 'publicación' : campaigns.some((c) => c.metrics) ? 'campaña' : null;
  return { byItem, campaigns, source, tried, period: { from, to } };
}

/** Normaliza una oferta (publicación dentro de una campaña). */
function normOffer(promo, it) {
  const promoPrice = Number(it.price || it.deal_price || it.suggested_discounted_price || it.max_discounted_price || 0) || null;
  return {
    item_id: it.id || it.item_id, promotion_id: promo.id, type: promo.type, name: promo.name || promo.type,
    status: it.status || promo.status, start: promo.start_date || null, finish: promo.finish_date || null,
    price_today: Number(it.original_price || 0) || null, promo_price: promoPrice,
    original_price: Number(it.original_price || 0) || null,
    meli_percentage: it.meli_percentage ?? it.benefits?.meli_percent ?? null,
    seller_percentage: it.seller_percentage ?? it.benefits?.seller_percent ?? null,
    suggested: Number(it.suggested_discounted_price || 0) || null, max_price: Number(it.max_discounted_price || 0) || null,
  };
}

/**
 * Lee campañas (activas y ofrecidas) con sus publicaciones, y Product Ads de los últimos 30 días.
 * @returns { offers, ads, errors }
 */
export async function readCampaigns(t, sellerId, { maxPromos = 20, maxItemsPerPromo = 100 } = {}) {
  const errors = [];
  const offers = [];
  const promos = await getRaw(t, `/seller-promotions/users/${sellerId}?${PROMO_V}`);
  if (promos.status !== 200) errors.push({ what: 'campañas', status: promos.status, message: promos.body?.message || null });
  const list = (Array.isArray(promos.body?.results) ? promos.body.results : []).filter((p) => !['finished', 'canceled'].includes(p.status)).slice(0, maxPromos);
  await pool(list, 2, async (p) => {
    let searchAfter = null;
    let n = 0;
    for (let page = 0; page < 5 && n < maxItemsPerPromo; page++) {
      const r = await getRaw(t, `/seller-promotions/promotions/${p.id}/items?promotion_type=${p.type}&${PROMO_V}&limit=50${searchAfter ? `&search_after=${searchAfter}` : ''}`);
      if (r.status !== 200) { errors.push({ what: `publicaciones de ${p.type}`, status: r.status, message: r.body?.message || null }); break; }
      const rows = r.body?.results || [];
      for (const it of rows) { offers.push(normOffer(p, it)); n++; }
      searchAfter = r.body?.paging?.searchAfter || r.body?.paging?.search_after || null;
      if (!rows.length || !searchAfter) break;
    }
  });

  const ads = [];
  let adsInfo = null;
  const adv = await getRaw(t, `/advertising/advertisers?product_id=PADS`, { 'Api-Version': '1' });
  const a = adv.body?.advertisers?.find((x) => x.site_id === 'MLA') || adv.body?.advertisers?.[0];
  if (adv.status !== 200 && adv.status !== 404) errors.push({ what: 'publicidad', status: adv.status, message: adv.body?.message || null });
  if (a) {
    const list = await searchPaged(t, `/advertising/MLA/advertisers/${a.advertiser_id}/product_ads/ads/search`, { 'api-version': '2' });
    if (list.status !== 200) errors.push({ what: 'avisos de publicidad', status: list.status, message: list.body?.message || null });
    const mx = await readAdsMetrics(t, a.advertiser_id);
    const campName = Object.fromEntries(mx.campaigns.map((c) => [String(c.id), c.name]));
    for (const x of list.rows) {
      const id = x.item_id || x.id;
      const m = mx.byItem[id] || null;
      ads.push({
        item_id: id, campaign_id: x.campaign_id || null, campaign: campName[String(x.campaign_id)] || (x.campaign_id ? `Campaña ${x.campaign_id}` : 'Sin campaña'),
        status: x.status || null, title: x.title || null, price: Number(x.price || 0) || null, permalink: x.permalink || null,
        listing_type_id: x.listing_type_id || null, category_id: x.category_id || null,
        noMetrics: !m, metricsMissing: m ? m.missing : ['cost', 'clicks', 'prints', 'total_amount', 'direct_amount', 'indirect_amount'],
        cost: m?.cost ?? null, clicks: m?.clicks ?? null, prints: m?.prints ?? null,
        direct_amount: m?.direct_amount ?? null, indirect_amount: m?.indirect_amount ?? null, total_amount: m?.total_amount ?? null,
        direct_units: m?.direct_units ?? null, indirect_units: m?.indirect_units ?? null, units: m?.units ?? null, acos_meli: m?.acos_meli ?? null,
      });
    }
    adsInfo = { source: mx.source, tried: mx.tried, period: mx.period, campaigns: mx.campaigns };
  }
  return { offers, ads, adsInfo, errors, hasAdvertiser: !!a };
}

/** Cargos reales de MeLi a un precio (listing_prices), de a pocos pedidos. @returns { key: {percentage, fixed, financing} } */
export async function readFees(t, combos) {
  const out = {};
  await pool(combos.slice(0, 60), 2, async (c) => {
    const r = await getRaw(t, `/sites/MLA/listing_prices?price=${Math.round(c.price)}&listing_type_id=${c.listing_type}${c.category_id ? `&category_id=${c.category_id}` : ''}`);
    if (r.status !== 200) return;
    const b = Array.isArray(r.body) ? r.body.find((x) => x.listing_type_id === c.listing_type) || r.body[0] : r.body;
    const d = b?.sale_fee_details || {};
    if (!b || (b.sale_fee_amount == null && d.percentage_fee == null)) return;
    // La comisión sola es meli_percentage_fee; percentage_fee a veces ya trae sumadas las cuotas.
    const pctFee = Number(d.meli_percentage_fee ?? d.percentage_fee);
    const pctAll = Number(d.percentage_fee);
    const fixed = Number(d.fixed_fee || 0);
    const total = b.sale_fee_amount != null ? Number(b.sale_fee_amount) : null;
    let financing;
    if (d.financing_add_on_fee != null) financing = (Number(d.financing_add_on_fee) * c.price) / 100;
    else if (Number.isFinite(pctAll) && Number.isFinite(pctFee) && pctAll > pctFee) financing = ((pctAll - pctFee) * c.price) / 100;
    else if (total != null && Number.isFinite(pctFee)) financing = Math.max(0, total - (c.price * pctFee) / 100 - fixed); // lo que sobra del total
    else financing = 0;
    if (financing < 1) financing = 0;
    out[c.key] = {
      percentage: Number.isFinite(pctFee) ? pctFee : total != null ? ((total - fixed - financing) / c.price) * 100 : null,
      fixed, financing, total: total != null && total >= fixed + financing ? total : null, source: 'meli',
    };
  });
  return out;
}
