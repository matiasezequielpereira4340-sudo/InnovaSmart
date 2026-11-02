// Cliente de la API de Mercado Libre (solo lectura) con refresh automático de token,
// reintentos con espera y lotes.
import { db } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { AppError } from './http.js';

const API = 'https://api.mercadolibre.com';
export const AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';

export class MeliError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = 'MeliError';
    this.status = status >= 500 || status === 429 ? 503 : status === 401 ? 401 : 502;
    this.meliStatus = status;
    this.path = path;
    this.code = 'meli';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: process.env.RINDE_MELI_APP_ID,
    client_secret: process.env.RINDE_MELI_SECRET,
    ...params,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[rinde][meli] token', r.status, data?.error, data?.message);
    throw new MeliError(r.status === 400 ? 401 : r.status, 'Mercado Libre no aceptó la conexión. Volvé a conectar tu cuenta.', '/oauth/token');
  }
  return data; // { access_token, refresh_token, expires_in, user_id, scope }
}

export function exchangeCode(code, verifier) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: process.env.RINDE_MELI_REDIRECT_URI, code_verifier: verifier });
}

export async function saveTokens(userId, t) {
  await db.upsert('rinde_connections', [{
    user_id: userId,
    access_token_enc: encrypt(t.access_token),
    refresh_token_enc: t.refresh_token ? encrypt(t.refresh_token) : null,
    expires_at: new Date(Date.now() + (t.expires_in || 21600) * 1000).toISOString(),
    scope: t.scope || null,
    updated_at: new Date().toISOString(),
  }], 'user_id');
}

/** Devuelve un access token válido; si vence en menos de 5 minutos, lo renueva. */
export async function getAccessToken(userId) {
  const c = await db.one('rinde_connections', { user_id: userId });
  if (!c) throw new AppError(401, 'Tu cuenta de Mercado Libre no está conectada. Conectala de nuevo.', 'no_connection');
  if (new Date(c.expires_at).getTime() - Date.now() > 5 * 60000) return decrypt(c.access_token_enc);
  if (!c.refresh_token_enc) throw new AppError(401, 'La conexión con Mercado Libre venció. Volvé a conectar tu cuenta.', 'expired');
  // El refresh token de MeLi es de un solo uso: guardamos el nuevo enseguida.
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_token_enc) });
  await saveTokens(userId, t);
  return t.access_token;
}

/** GET a la API de MeLi con reintentos (429/5xx) y espera exponencial. */
export async function meliGet(token, path, { retries = 3, allow404 = false, headers = {} } = {}) {
  let wait = 600;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } });
    } catch (e) {
      if (attempt < retries) { await sleep(wait); wait *= 2; continue; }
      throw new MeliError(503, 'Mercado Libre no respondió, reintentá en unos minutos.', path);
    }
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < retries) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra ? ra * 1000 : wait);
      wait *= 2;
      continue;
    }
    if (allow404 && (r.status === 404 || r.status === 403 || r.status === 400)) return null;
    if (r.status === 401) throw new MeliError(401, 'La conexión con Mercado Libre venció. Volvé a conectar tu cuenta.', path);
    if (r.status === 429 || r.status >= 500) throw new MeliError(r.status, 'Mercado Libre no respondió, reintentá en unos minutos.', path);
    throw new MeliError(r.status, 'Mercado Libre no devolvió los datos pedidos.', path);
  }
}

/** Ejecuta tareas con concurrencia limitada (para no pasarnos del rate limit). */
export async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      try { out[idx] = await fn(list[idx], idx); } catch (e) { out[idx] = { __error: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}

export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ─────────────────────────────── Endpoints usados ──────────────────────────

export const getMe = (t) => meliGet(t, '/users/me');

/** Todos los ids de publicaciones activas y pausadas (usa scan para cuentas grandes). */
export async function listItemIds(t, sellerId) {
  const ids = [];
  for (const status of ['active', 'paused', 'under_review']) {
    let scroll = null;
    for (let guard = 0; guard < 300; guard++) {
      const qs = `status=${status}&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`;
      const data = await meliGet(t, `/users/${sellerId}/items/search?${qs}`, { allow404: true });
      const batch = data?.results || [];
      ids.push(...batch);
      scroll = data?.scroll_id;
      if (!batch.length || !scroll) break;
    }
  }
  return [...new Set(ids)];
}

export async function getItems(t, ids) {
  const attrs = 'id,title,price,currency_id,status,sub_status,available_quantity,sold_quantity,listing_type_id,shipping,catalog_product_id,catalog_listing,pictures,thumbnail,permalink,category_id,attributes,seller_custom_field,tags,health,date_created';
  const out = [];
  for (const c of chunk(ids, 20)) {
    const data = await meliGet(t, `/items?ids=${c.join(',')}&attributes=${attrs}`);
    for (const row of data || []) if (row.code === 200 && row.body) out.push(row.body);
  }
  return out;
}

/** Visitas de los últimos 30 días por publicación. */
export async function getVisits30(t, ids) {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 86400000);
  const d = (x) => x.toISOString().slice(0, 10);
  const res = {};
  for (const c of chunk(ids, 50)) {
    const data = await meliGet(t, `/items/visits?ids=${c.join(',')}&date_from=${d(from)}&date_to=${d(to)}`, { allow404: true });
    if (Array.isArray(data)) for (const v of data) res[v.item_id] = v.total_visits ?? null;
  }
  // Fallback por ítem si la consulta por lote no trajo algo.
  const missing = ids.filter((id) => res[id] === undefined);
  await pool(missing, 4, async (id) => {
    const v = await meliGet(t, `/items/${id}/visits/time_window?last=30&unit=day`, { allow404: true });
    res[id] = v?.total_visits ?? null;
  });
  return res;
}

/** Calidad oficial: GET /item/{id}/performance (reemplaza al discontinuado /health). */
export async function getPerformance(t, id) {
  const p = await meliGet(t, `/item/${id}/performance`, { allow404: true });
  if (!p) return null;
  const pending = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.status === 'PENDING' && (node.wordings || node.title)) {
      const w = node.wordings || {};
      pending.push(w.title || w.label || node.title);
    }
    for (const k of ['buckets', 'variables', 'rules']) if (node[k]) walk(node[k]);
  };
  walk(p.buckets || []);
  return {
    score: p.score ?? null,
    level: p.level ?? null,
    level_wording: p.level_wording ?? null,
    pending_actions: [...new Set(pending.filter(Boolean))].slice(0, 10),
  };
}

/** Preguntas sin responder de todo el vendedor, agrupadas por publicación. */
export async function getUnansweredQuestions(t, sellerId) {
  const byItem = {};
  let offset = 0;
  for (let guard = 0; guard < 20; guard++) {
    const data = await meliGet(t, `/questions/search?seller_id=${sellerId}&status=UNANSWERED&api_version=4&limit=50&offset=${offset}`, { allow404: true });
    const qs = data?.questions || [];
    for (const q of qs) {
      const r = (byItem[q.item_id] ||= { count: 0, oldest: null });
      r.count++;
      const d = new Date(q.date_created).getTime();
      if (!r.oldest || d < r.oldest) r.oldest = d;
    }
    offset += qs.length;
    if (!qs.length || offset >= (data.total || 0)) break;
  }
  return byItem;
}

/** Precio de la competencia. Devuelve null si MeLi no da el dato (nunca se estima). */
export async function getCompetition(t, item) {
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  try {
    if (item.catalog_product_id) {
      const d = await meliGet(t, `/products/${item.catalog_product_id}/items?limit=50`, { allow404: true, retries: 1 });
      const prices = (d?.results || []).filter((x) => x.item_id !== item.id && x.price).map((x) => x.price);
      if (prices.length) return { min_price: Math.min(...prices), median_price: median(prices), count: d.paging?.total ?? prices.length, source: 'catálogo' };
    }
    const q = encodeURIComponent(String(item.title || '').split(' ').slice(0, 6).join(' '));
    const d = await meliGet(t, `/sites/MLA/search?q=${q}&category=${item.category_id}&limit=50`, { allow404: true, retries: 1 });
    const prices = (d?.results || []).filter((x) => x.id !== item.id && x.seller?.id !== item.seller_id && x.price).map((x) => x.price);
    if (prices.length >= 3) return { min_price: Math.min(...prices), median_price: median(prices), count: d.paging?.total ?? prices.length, source: 'búsqueda' };
  } catch (e) {
    console.warn('[rinde][competencia]', item.id, e.message);
  }
  return null;
}

/** Órdenes pagas de los últimos `days` días (paginado). */
export async function getOrdersPage(t, sellerId, fromIso, offset) {
  return meliGet(t, `/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${encodeURIComponent(fromIso)}&sort=date_desc&limit=50&offset=${offset}`);
}

/**
 * FACTURACIÓN: cargos reales por venta (comisión, envío, financiación, impuestos si los trae).
 * Endpoint de detalle por orden de Billing Reports. Devuelve null si no hay dato todavía.
 */
export async function getBillingForOrder(t, orderId) {
  const d = await meliGet(t, `/billing/integration/group/ML/order/details?order_ids=${orderId}`, { allow404: true, retries: 1 });
  const rows = d?.results || d?.data || (Array.isArray(d) ? d : []);
  if (!rows.length) return null;
  const fees = { commission: 0, shipping: 0, financing: 0, taxes: 0, other: 0 };
  let found = false;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const ci = node.charge_info || node;
    const amount = Number(ci.detail_amount ?? ci.amount ?? NaN);
    const label = `${ci.detail_sub_type || ''} ${ci.transaction_detail || ci.detail_type || ''}`.toLowerCase();
    if (!Number.isNaN(amount) && label.trim() && ci !== node.sales_info) {
      found = true;
      const isBonus = /bonus|bonif/.test(String(ci.detail_type || '').toLowerCase());
      const v = isBonus ? -Math.abs(amount) : Math.abs(amount);
      if (/env[ií]o|shipping|flete/.test(label)) fees.shipping += v;
      else if (/cuota|financ|installment/.test(label)) fees.financing += v;
      else if (/impuest|retenc|percep|iibb|iva|tax|ganancias/.test(label)) fees.taxes += v;
      else if (/venta|cv|comisi|cargo por/.test(label)) fees.commission += v;
      else fees.other += v;
      return;
    }
    for (const k of Object.keys(node)) if (typeof node[k] === 'object') walk(node[k]);
  };
  walk(rows);
  return found ? fees : null;
}

/** Costo de envío a cargo del vendedor (respaldo cuando la facturación no trae el dato). */
export async function getShippingCost(t, shipmentId) {
  if (!shipmentId) return null;
  const d = await meliGet(t, `/shipments/${shipmentId}/costs`, { allow404: true, retries: 1, headers: { 'x-format-new': 'true' } });
  const s = d?.senders?.[0];
  return s ? Number(s.cost || 0) : null;
}

/** Product Ads: gasto por publicación (últimos 30 días) si la cuenta tiene acceso. Si no, null. */
export async function getProductAdsSpend(t) {
  try {
    const adv = await meliGet(t, `/advertising/advertisers?product_id=PADS`, { allow404: true, retries: 1, headers: { 'Api-Version': '1' } });
    const a = adv?.advertisers?.find((x) => x.site_id === 'MLA') || adv?.advertisers?.[0];
    if (!a) return null;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const out = {};
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const d = await meliGet(t, `/advertising/advertisers/${a.advertiser_id}/product_ads/items?limit=100&offset=${offset}&date_from=${from}&date_to=${to}&metrics=cost`, { allow404: true, retries: 1, headers: { 'Api-Version': '2' } });
      const rows = d?.results || [];
      for (const r of rows) out[r.item_id || r.id] = Number(r.metrics?.cost ?? r.cost ?? 0);
      offset += rows.length;
      if (!rows.length || offset >= (d.paging?.total || 0)) break;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Normaliza un ítem de MeLi al snapshot que usa Rinde. */
export function normalizeItem(b) {
  const skuAttr = (b.attributes || []).find((a) => a.id === 'SELLER_SKU');
  const sub = b.sub_status || [];
  return {
    id: b.id,
    seller_id: b.seller_id,
    title: b.title,
    sku: skuAttr?.value_name || b.seller_custom_field || null,
    price: b.price,
    currency: b.currency_id,
    status: b.status,
    sub_status: sub,
    infraction: (b.tags || []).some((x) => /infraction|moderation|poor_quality_picture/.test(x)) || sub.includes('forbidden'),
    available_quantity: b.available_quantity,
    listing_type: b.listing_type_id,
    shipping: {
      logistic: b.shipping?.logistic_type || null,
      flex: (b.shipping?.tags || []).includes('self_service_in'),
      free_shipping: !!b.shipping?.free_shipping,
    },
    catalog_product_id: b.catalog_product_id || null,
    catalog_listing: !!b.catalog_listing,
    category_id: b.category_id,
    pictures_count: (b.pictures || []).length,
    thumbnail: b.thumbnail ? b.thumbnail.replace(/^http:/, 'https:') : null,
    permalink: b.permalink,
  };
}
