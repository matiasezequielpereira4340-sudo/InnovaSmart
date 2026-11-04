// Lectura (SOLO LECTURA) de campañas/promociones y Product Ads desde Mercado Libre.
// Rinde nunca activa, cambia ni da de baja nada: solo GET.
// Límites: pedidos de a lotes chicos, concurrencia baja y reintento con espera ante 429 (meliRaw lo hace).
import { meliRaw, pool } from './meli.js';

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
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metrics = 'clicks,prints,cost,acos,direct_amount,indirect_amount,direct_items_quantity,indirect_items_quantity';
    const camp = await getRaw(t, `/advertising/MLA/advertisers/${a.advertiser_id}/product_ads/campaigns/search?limit=5&date_from=${from}&date_to=${to}&metrics=${metrics}`, { 'api-version': '2' });
    rows.push(probeRow('Product Ads: campañas con métricas', `/advertising/MLA/advertisers/{id}/product_ads/campaigns/search`, camp));
    const ads = await getRaw(t, `/advertising/MLA/advertisers/${a.advertiser_id}/product_ads/ads/search?limit=5&date_from=${from}&date_to=${to}&metrics=${metrics}`, { 'api-version': '2' });
    rows.push(probeRow('Product Ads: publicaciones con métricas', `/advertising/MLA/advertisers/{id}/product_ads/ads/search`, ads, { fields: ads.body?.results?.[0] ? Object.keys(ads.body.results[0]).slice(0, 20) : [] }));
  }
  return { rows, at: new Date().toISOString() };
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
  const adv = await getRaw(t, `/advertising/advertisers?product_id=PADS`, { 'Api-Version': '1' });
  const a = adv.body?.advertisers?.find((x) => x.site_id === 'MLA') || adv.body?.advertisers?.[0];
  if (adv.status !== 200 && adv.status !== 404) errors.push({ what: 'publicidad', status: adv.status, message: adv.body?.message || null });
  if (a) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metrics = 'clicks,prints,cost,acos,direct_amount,indirect_amount,direct_items_quantity,indirect_items_quantity';
    for (let offset = 0; offset < 1000; offset += 50) {
      const r = await getRaw(t, `/advertising/MLA/advertisers/${a.advertiser_id}/product_ads/ads/search?limit=50&offset=${offset}&date_from=${from}&date_to=${to}&metrics=${metrics}`, { 'api-version': '2' });
      if (r.status !== 200) { errors.push({ what: 'métricas de publicidad', status: r.status, message: r.body?.message || null }); break; }
      const rows = r.body?.results || [];
      for (const x of rows) {
        const m = x.metrics || x;
        ads.push({ item_id: x.item_id || x.id, campaign: x.campaign_name || (x.campaign_id ? `Campaña ${x.campaign_id}` : 'Sin campaña'), campaign_id: x.campaign_id || null,
          cost: Number(m.cost || 0), direct_amount: Number(m.direct_amount || 0), indirect_amount: Number(m.indirect_amount || 0),
          direct_units: Number(m.direct_items_quantity || 0), indirect_units: Number(m.indirect_items_quantity || 0), clicks: Number(m.clicks || 0), acos_meli: m.acos ?? null });
      }
      if (rows.length < 50) break;
    }
  }
  return { offers, ads, errors, hasAdvertiser: !!a };
}

/** Cargos reales de MeLi a un precio (listing_prices), de a pocos pedidos. @returns { key: {percentage, fixed, financing} } */
export async function readFees(t, combos) {
  const out = {};
  await pool(combos.slice(0, 60), 2, async (c) => {
    const r = await getRaw(t, `/sites/MLA/listing_prices?price=${Math.round(c.price)}&listing_type_id=${c.listing_type}${c.category_id ? `&category_id=${c.category_id}` : ''}`);
    if (r.status !== 200) return;
    const b = Array.isArray(r.body) ? r.body.find((x) => x.listing_type_id === c.listing_type) || r.body[0] : r.body;
    const d = b?.sale_fee_details;
    if (!d) return;
    const pctFee = Number(d.percentage_fee ?? d.meli_percentage_fee);
    out[c.key] = {
      percentage: Number.isFinite(pctFee) ? pctFee : null,
      fixed: Number(d.fixed_fee || 0),
      financing: d.financing_add_on_fee != null ? (Number(d.financing_add_on_fee) * c.price) / 100 : 0,
    };
  });
  return out;
}
