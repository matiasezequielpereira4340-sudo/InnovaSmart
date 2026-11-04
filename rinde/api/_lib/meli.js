// Cliente de la API de Mercado Libre (solo lectura) con refresh automático de token,
// reintentos con espera y lotes.
import { db } from './db.js';
import { markNeedsReconnect } from './audit.js';
import { encrypt, decrypt } from './crypto.js';
import { AppError } from './http.js';
import { parseBilling } from '../../shared/billing.js';

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
  let r;
  try {
    r = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    const e = new MeliError(503, 'Mercado Libre no respondió, reintentá en unos minutos.', '/oauth/token');
    e.reason = 'sin_respuesta';
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Motivo que da MeLi (invalid_client, invalid_grant, ...). Nunca logueamos claves ni el código.
    const reason = data?.error || (r.status >= 500 ? 'meli_caido' : `http_${r.status}`);
    console.error('[rinde][meli] token rechazado:', r.status, reason, (data?.message || '').slice(0, 120));
    const e = new MeliError(r.status >= 500 ? 503 : 401, r.status >= 500 ? 'Mercado Libre no respondió, reintentá en unos minutos.' : 'Mercado Libre no aceptó la conexión. Volvé a conectar tu cuenta.', '/oauth/token');
    e.reason = reason;
    e.meliStatus = r.status;
    e.meliMessage = (data?.message || '').slice(0, 160);
    throw e;
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
// Un error de token NUNCA borra nada: marca la cuenta "hay que reconectar", lo registra y avisa con 401.
export async function getAccessToken(userId, req = null) {
  const c = await db.one('rinde_connections', { user_id: userId });
  if (!c) {
    await markNeedsReconnect(userId, 'sin_conexion', req);
    throw new AppError(401, 'Tu cuenta de Mercado Libre no está conectada. Conectala de nuevo.', 'no_connection');
  }
  if (new Date(c.expires_at).getTime() - Date.now() > 5 * 60000) return decrypt(c.access_token_enc);
  if (!c.refresh_token_enc) {
    await markNeedsReconnect(userId, 'sin_refresh_token', req);
    throw new AppError(401, 'La conexión con Mercado Libre venció. Volvé a conectar tu cuenta.', 'expired');
  }
  // El refresh token de MeLi es de un solo uso: guardamos el nuevo enseguida.
  let t;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_token_enc) });
  } catch (e) {
    // MeLi caído (503): no es culpa del token, no marcamos nada.
    if (e.status === 401) await markNeedsReconnect(userId, `refresh_${e.reason || 'rechazado'}`, req, { status: e.meliStatus || null, message: e.meliMessage || null });
    throw e;
  }
  await saveTokens(userId, t);
  return t.access_token;
}

/** GET a la API de MeLi con reintentos (429/5xx) y espera exponencial. */
export async function meliGet(token, path, { retries = 3, allow404 = false, headers = {}, onMiss = null } = {}) {
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
    if (allow404 && (r.status === 404 || r.status === 403 || r.status === 400)) {
      if (onMiss) { const b = await r.json().catch(() => ({})); onMiss({ status: r.status, error: b.error || null, message: b.message || null }); }
      return null;
    }
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
  const attrs = 'id,title,price,currency_id,status,sub_status,available_quantity,sold_quantity,listing_type_id,shipping,catalog_product_id,catalog_listing,pictures,thumbnail,permalink,category_id,attributes,variations,video_id,seller_custom_field,tags,health,date_created';
  const out = [];
  for (const c of chunk(ids, 20)) {
    const data = await meliGet(t, `/items?ids=${c.join(',')}&attributes=${attrs}`);
    for (const row of data || []) if (row.code === 200 && row.body) out.push(row.body);
  }
  return out;
}

/**
 * Atributos que pide una categoría (requeridos y recomendados). Público, cacheado 7 días por categoría
 * en rinde_settings (lo comparten todos los usuarios) para no repetir pedidos a MeLi.
 */
const CAT_TTL = 7 * 86400000;
const SKIP_ATTRS = new Set(['SELLER_SKU', 'ITEM_CONDITION', 'GTIN', 'EMPTY_GTIN_REASON']);
export async function getCategoryAttrs(t, catIds) {
  const ids = [...new Set(catIds.filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  const cached = await db.select('rinde_settings', { key: ids.map((id) => `cat_attrs:${id}`) }).catch(() => []);
  for (const r of cached) if (r.value?.at && Date.now() - new Date(r.value.at).getTime() < CAT_TTL) out[r.key.slice(10)] = r.value;
  const missing = ids.filter((id) => !out[id]);
  const fresh = [];
  await pool(missing, 2, async (id) => {
    const d = await meliGet(t, `/categories/${id}/attributes`, { allow404: true });
    if (!Array.isArray(d)) return;
    const pick = (a) => ({ id: a.id, name: a.name });
    const usable = d.filter((a) => !SKIP_ATTRS.has(a.id) && !a.tags?.hidden && !a.tags?.read_only && !a.tags?.fixed && !a.tags?.others);
    const required = usable.filter((a) => a.tags?.required || a.tags?.catalog_required).map(pick);
    const reqIds = new Set(required.map((a) => a.id));
    const recommended = usable.filter((a) => !reqIds.has(a.id) && a.relevance === 1).map(pick);
    out[id] = { required, recommended, at: new Date().toISOString() };
    fresh.push({ key: `cat_attrs:${id}`, value: out[id], updated_at: new Date().toISOString() });
  });
  if (fresh.length) await db.upsert('rinde_settings', fresh, 'key').catch(() => {});
  return out;
}

/** Atributos que faltan en la publicación contra los que pide su categoría (cuenta también los de variaciones). */
export function missingAttrs(b, cat) {
  if (!cat) return null;
  const filled = new Set();
  const ok = (a) => a && (a.value_name || a.value_id || (Array.isArray(a.values) && a.values.some((v) => v.name || v.id)));
  for (const a of b.attributes || []) if (ok(a)) filled.add(a.id);
  for (const v of b.variations || []) for (const a of [...(v.attribute_combinations || []), ...(v.attributes || [])]) if (ok(a)) filled.add(a.id);
  return {
    req_total: cat.required.length,
    rec_total: cat.recommended.length,
    req_missing: cat.required.filter((a) => !filled.has(a.id)).map((a) => a.name),
    rec_missing: cat.recommended.filter((a) => !filled.has(a.id)).map((a) => a.name),
  };
}

/** Largo de la descripción (texto plano). 0 si no tiene; null si no se pudo leer. */
export async function getDescriptionLength(t, id) {
  let missing = false;
  const d = await meliGet(t, `/items/${id}/description`, { allow404: true, onMiss: (m) => { if (m.status === 404) missing = true; } });
  if (d) return String(d.plain_text || d.text || '').replace(/<[^>]+>/g, '').trim().length;
  return missing ? 0 : null;
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
export async function getPerformance(t, id, probe = null) {
  // probe (opcional) junta por qué MeLi no dio la calidad: código HTTP y mensaje, sin tokens.
  const note = (k, sample) => { if (!probe) return; probe.counts[k] = (probe.counts[k] || 0) + 1; if (sample && !probe.sample) probe.sample = { item_id: id, ...sample }; };
  const p = await meliGet(t, `/item/${id}/performance`, { allow404: true, onMiss: (m) => note(String(m.status), m) });
  if (!p) return null;
  if (p.score == null && p.level == null) note('200_sin_puntaje', { keys: Object.keys(p).slice(0, 15) });
  else note('ok');
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

/** Órdenes de los últimos días, de cualquier estado (paginado). */
// Todas las ventas (no solo 'paid'): las canceladas se guardan con su estado y no cuentan como facturación.
export async function getOrdersPage(t, sellerId, fromIso, offset) {
  return meliGet(t, `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(fromIso)}&sort=date_desc&limit=50&offset=${offset}`);
}

/**
 * GET crudo: no tira error, devuelve { status, body, ms }. Para la Validación y para probar formatos.
 */
export async function meliRaw(token, path, headers = {}) {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } });
      if (r.status === 429 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      const text = await r.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = { _texto_no_json: text.slice(0, 500) }; }
      return { status: r.status, body, ms: Date.now() - t0 };
    } catch (e) {
      if (attempt === 2) return { status: 0, body: { _error: 'Mercado Libre no respondió' }, ms: Date.now() - t0 };
      await sleep(800);
    }
  }
}

/**
 * FACTURACIÓN cruda de una venta. Prueba primero ?order_ids= y, si no trae nada, ?order_id=
 * (la documentación de MeLi muestra las dos formas).
 */
export async function getBillingRaw(t, orderId) {
  const a = await meliRaw(t, `/billing/integration/group/ML/order/details?order_ids=${orderId}`);
  const has = (x) => x.status === 200 && x.body && (Array.isArray(x.body.results) ? x.body.results.length > 0 : true);
  if (has(a)) return { ...a, param: 'order_ids' };
  const b = await meliRaw(t, `/billing/integration/group/ML/order/details?order_id=${orderId}`);
  if (has(b)) return { ...b, param: 'order_id' };
  return { ...(a.status === 200 ? a : b), param: null, tried: [{ param: 'order_ids', status: a.status }, { param: 'order_id', status: b.status }] };
}

/**
 * LIQUIDACIÓN real de un cobro (lo que efectivamente le quedó al vendedor). Solo lectura.
 * Primero la API de pagos de Mercado Pago (el token de MeLi suele servir); si no, /collections de MeLi.
 */
export async function getSettlementRaw(t, paymentId) {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
    const body = await r.json().catch(() => null);
    if (r.status === 200 && body) return { status: 200, body, source: 'mercadopago', ms: Date.now() - t0 };
    const c = await meliRaw(t, `/collections/${paymentId}`);
    if (c.status === 200 && c.body) return { ...c, source: 'collections', tried: [{ source: 'mercadopago', status: r.status }] };
    return { status: c.status || r.status, body: null, source: null, tried: [{ source: 'mercadopago', status: r.status }, { source: 'collections', status: c.status }] };
  } catch {
    return { status: 0, body: null, source: null };
  }
}

/**
 * FACTURACIÓN de VARIAS ventas en UN solo pedido (?order_ids=a,b,c).
 * MeLi limita este servicio a 5 pedidos por minuto: si responde 429, esperamos lo que pide y reintentamos.
 * @returns { status, body, param, waited }
 */
export async function getBillingBatchRaw(t, orderIds, { maxWaitMs = 40000 } = {}) {
  const ids = [...new Set(orderIds.map(String))].slice(0, 50);
  const t0 = Date.now();
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const r = await meliRaw(t, `/billing/integration/group/ML/order/details?order_ids=${ids.join(',')}&limit=250`);
    if (r.status !== 429) return { ...r, param: 'order_ids', waited, ms: Date.now() - t0 };
    const wait = 13000 * (attempt + 1); // 5 por minuto = 1 cada 12 s
    if (waited + wait > maxWaitMs) return { ...r, param: 'order_ids', waited, ms: Date.now() - t0 };
    await sleep(wait);
    waited += wait;
  }
}

/** Cargos reales por venta según la facturación (de varias ventas a la vez). { [order_id]: fees } solo las que tienen dato legible. */
export async function getBillingForOrders(t, orderIds, opts) {
  const raw = await getBillingBatchRaw(t, orderIds, opts);
  if (raw.status !== 200) return { status: raw.status, byOrder: {} };
  const byOrder = {};
  for (const id of orderIds) {
    const p = parseBilling(raw.body, id);
    if (p.lines.length) byOrder[String(id)] = { ...p.fees, v: 2 };
  }
  return { status: 200, byOrder };
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
    // Lado menor de cada foto en su tamaño máximo (para detectar fotos chicas). null si MeLi no lo informa.
    pics: Array.isArray(b.pictures) && b.pictures.some((p) => p.max_size || p.size)
      ? b.pictures.map((p) => { const m = String(p.max_size || p.size || '').match(/(\d+)x(\d+)/); return m ? Math.min(+m[1], +m[2]) : 0; })
      : null,
    video: 'video_id' in b ? !!b.video_id : null,
    permalink: b.permalink,
  };
}
