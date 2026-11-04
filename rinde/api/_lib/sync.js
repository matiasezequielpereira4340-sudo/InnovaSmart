// Sincronización por pasos: cada llamada procesa un lote y devuelve el progreso real.
// Así no superamos el tiempo máximo de una función y el usuario ve cuántas publicaciones vamos analizando.
import { db } from './db.js';
import * as meli from './meli.js';
import { LIMITS, FEATURES } from '../../shared/config.js';
import { parseSettlement } from '../../shared/validation.js';
import { markNeedsReconnect } from './audit.js';

const now = () => new Date().toISOString();
const DAY = 86400000;
// Ventas que NO cuentan como facturación (MeLi las muestra en "ventas brutas" pero no se cobraron).
export const NOT_SOLD = new Set(['cancelled', 'invalid']);
const sold = (o) => !NOT_SOLD.has(o.data?.status);
const BILLING_V = 2; // versión del lector de facturación: si cambia, se vuelve a leer el último mes

export async function getJob(userId) {
  return db.one('rinde_sync_jobs', { user_id: userId });
}

async function saveJob(job) {
  job.updated_at = now();
  await db.upsert('rinde_sync_jobs', [job], 'user_id');
  return job;
}

export function isFresh(job) {
  return job?.status === 'done' && job.finished_at && Date.now() - new Date(job.finished_at).getTime() < LIMITS.MELI_CACHE_HOURS * 3600000;
}

export async function startJob(userId) {
  return saveJob({ user_id: userId, status: 'running', phase: 'list', item_ids: [], cursor: 0, total: 0, meta: {}, error: null, started_at: now(), finished_at: null });
}

export function progressOf(job) {
  const phases = { list: 'Buscando tus publicaciones', items: 'Analizando publicaciones', orders: 'Leyendo tus ventas', billing: 'Leyendo la facturación de Mercado Libre', finalize: 'Clasificando', done: 'Listo' };
  return {
    status: job.status,
    phase: job.phase,
    label: phases[job.phase] || job.phase,
    done: job.phase === 'items' ? job.cursor : job.phase === 'list' ? 0 : job.total,
    total: job.total,
    orders: job.meta?.orders_count || 0,
    billing: job.meta?.billing_done || 0,
    billingTotal: (job.meta?.billing_queue || []).length,
    error: job.error,
    finished_at: job.finished_at,
  };
}

/** Ejecuta un paso de la sincronización. */
export async function step(userId, sellerId) {
  let job = await getJob(userId);
  if (!job || job.status === 'error') job = await startJob(userId);
  if (job.status === 'done') return job;
  const token = await meli.getAccessToken(userId);
  try {
    if (job.phase === 'list') {
      const me = await meli.getMe(token);
      const ids = await meli.listItemIds(token, sellerId);
      const questions = await meli.getUnansweredQuestions(token, sellerId);
      const productAds = await meli.getProductAdsSpend(token);
      const prevUser = await db.one('rinde_users', { id: userId }, { columns: 'settings' });
      await db.update('rinde_users', { id: userId }, {
        nickname: me.nickname,
        settings: { ...(prevUser?.settings || {}), prev_reputation: prevUser?.settings?.reputation?.level_id || null, reputation: me.seller_reputation || null },
      });
      Object.assign(job, { item_ids: ids, total: ids.length, cursor: 0, phase: ids.length ? 'items' : 'orders', meta: { questions, productAds, seller: { id: me.id, nickname: me.nickname, reputation: me.seller_reputation || null, state: me.address?.state || null, city: me.address?.city || null } } });
    } else if (job.phase === 'items') {
      const batch = job.item_ids.slice(job.cursor, job.cursor + LIMITS.ITEMS_PER_SYNC_STEP);
      const raw = await meli.getItems(token, batch);
      const visits = await meli.getVisits30(token, batch);
      const probe = { counts: {}, sample: null };
      const perf = FEATURES.quality ? await meli.pool(raw, 4, (b) => meli.getPerformance(token, b.id, probe)) : raw.map(() => null);
      if (raw.length && FEATURES.quality) {
        perf.forEach((x) => { if (x?.__error) { probe.counts.error = (probe.counts.error || 0) + 1; if (!probe.sample) probe.sample = { error: String(x.__error).slice(0, 200) }; } });
        try { await db.upsert('rinde_settings', [{ key: 'last_perf_probe', value: { ...probe, at: new Date().toISOString() }, updated_at: new Date().toISOString() }], 'key'); } catch {}
      }
      const comp = FEATURES.competition ? await meli.pool(raw, 3, (b) => meli.getCompetition(token, b)) : raw.map(() => null);
      // Para la Nota de publicación: atributos de la categoría (caché) y largo de la descripción.
      const cats = await meli.getCategoryAttrs(token, raw.map((b) => b.category_id)).catch(() => ({}));
      const descs = await meli.pool(raw, 3, (b) => meli.getDescriptionLength(token, b.id));
      const rows = raw.map((b, i) => {
        const it = meli.normalizeItem(b);
        const q = job.meta.questions?.[b.id];
        it.visits30 = visits[b.id] ?? null;
        it.quality = perf[i]?.__error ? null : perf[i];
        it.competition = comp[i]?.__error ? null : comp[i];
        it.attrs = meli.missingAttrs(b, cats[b.category_id]);
        it.desc_len = descs[i]?.__error ? null : descs[i];
        it.questions_unanswered = q?.count || 0;
        it.oldest_question_hours = q?.oldest ? Math.round((Date.now() - q.oldest) / 3600000) : 0;
        return { user_id: userId, item_id: b.id, data: it, fetched_at: now() };
      });
      await db.upsert('rinde_items', rows, 'user_id,item_id');
      job.cursor += batch.length;
      if (job.cursor >= job.total) Object.assign(job, { phase: 'orders', meta: { ...job.meta, orders_offset: 0, orders_count: 0 } });
    } else if (job.phase === 'orders') {
      const from = new Date(Date.now() - 180 * DAY).toISOString(); // 180 días: para saber qué vendía cada publicación antes del problema
      let offset = job.meta.orders_offset || 0;
      let finished = false;
      for (let p = 0; p < 8; p++) {
        const page = await meli.getOrdersPage(token, sellerId, from, offset);
        const results = page?.results || [];
        const rows = results.map((o) => ({
          user_id: userId,
          order_id: String(o.id),
          date_created: o.date_created,
          data: {
            status: o.status || null,
            lines: (o.order_items || []).map((l) => ({ item_id: l.item?.id, sku: l.item?.seller_sku || null, qty: l.quantity, unit_price: l.unit_price, sale_fee: l.sale_fee ?? null })),
            shipping_id: o.shipping?.id || null,
            pack_id: o.pack_id || null,
            taxes_amount: (o.payments || []).reduce((s, p) => s + (Number(p.taxes_amount) || 0), 0),
            installments: (o.payments || [])[0]?.installments || null,
            payment_ids: (o.payments || []).filter((p) => p?.id && p.status !== 'refunded' && p.status !== 'cancelled').map((p) => p.id),
          },
        }));
        await db.upsert('rinde_orders', rows, 'user_id,order_id');
        offset += results.length;
        job.meta.orders_count = offset;
        const total = Math.min(page?.paging?.total || 0, 10000);
        if (!results.length || offset >= total) { finished = true; break; }
      }
      job.meta.orders_offset = offset;
      if (finished) {
        const recent = await db.selectAll('rinde_orders', { user_id: userId }, { columns: 'order_id,date_created,fees_source,fees,data', order: 'date_created.desc' });
        const cutoff = Date.now() - 31 * DAY;
        const queue = recent.filter((o) => new Date(o.date_created).getTime() >= cutoff && sold(o) && (o.fees_source !== 'facturación' || o.fees?.v !== BILLING_V)).map((o) => o.order_id);
        Object.assign(job, { phase: queue.length ? 'billing' : 'finalize', meta: { ...job.meta, billing_queue: queue, billing_done: 0 } });
      }
    } else if (job.phase === 'billing') {
      const queue = job.meta.billing_queue || [];
      const batchIds = queue.slice(job.meta.billing_done, job.meta.billing_done + 25);
      const orders = await db.select('rinde_orders', { user_id: userId, order_id: batchIds });
      // UN pedido para las 25 ventas (MeLi permite 5 por minuto). Si limita (429), se reintenta en el próximo paso.
      const bill = await meli.getBillingForOrders(token, batchIds, { maxWaitMs: 30000 });
      if (bill.status === 429 && (job.meta.billing_429 || 0) < 4) {
        job.meta.billing_429 = (job.meta.billing_429 || 0) + 1;
        return saveJob(job);
      }
      job.meta.billing_429 = 0;
      await meli.pool(orders, 2, async (o) => {
        let fees = bill.byOrder[o.order_id] || null;
        let source = 'facturación';
        let taxesUnknown = false;
        if (!fees) {
          // Respaldo: datos de la orden + costo de envío del shipment. Se marca "estimado".
          source = 'orden';
          const commission = (o.data.lines || []).reduce((s, l) => s + (Number(l.sale_fee) || 0) * (l.qty || 1), 0);
          const shipping = await meli.getShippingCost(token, o.data.shipping_id).catch(() => null);
          const taxes = Number(o.data.taxes_amount) || 0;
          taxesUnknown = !taxes;
          fees = { commission, shipping: shipping || 0, financing: 0, taxes, other: 0, v: BILLING_V };
        }
        // Retenciones (IIBB, etc.): normalmente vienen en la facturación (tax_details); si no, se leen del pago en Mercado Pago.
        if (!(fees.taxes > 0) && (o.data.payment_ids || []).length) {
          let taxes = 0, read = false;
          for (const pid of o.data.payment_ids) {
            const st = await meli.getSettlementRaw(token, pid);
            const p = st.status === 200 ? parseSettlement(st.body) : null;
            if (p) { read = true; taxes += p.fees.taxes; }
          }
          if (read) { fees = { ...fees, taxes }; taxesUnknown = false; }
        }
        await db.update('rinde_orders', { user_id: userId, order_id: o.order_id }, { fees, fees_source: source, taxes_unknown: taxesUnknown });
      });
      job.meta.billing_done += batchIds.length;
      if (job.meta.billing_done >= queue.length) job.phase = 'finalize';
    } else if (job.phase === 'finalize') {
      const orders = await db.selectAll('rinde_orders', { user_id: userId }, { columns: 'order_id,date_created,data', order: 'order_id.asc' });
      // Ventas por publicación (unidades y $) en 30/90/180 días, y facturación real de la cuenta.
      // Las canceladas no cuentan, pero se informan aparte (MeLi las suma en "ventas brutas").
      const st = {};
      const revenue = { d30: 0, d90: 0, d180: 0, orders30: 0, orders90: 0, orders180: 0, cancelled30: 0, cancelled30_amount: 0, statuses30: {}, months: {} };
      const t30 = Date.now() - 30 * DAY, t90 = Date.now() - 90 * DAY, t180 = Date.now() - 180 * DAY;
      const monthAR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 7); // mes en hora argentina
      for (const o of orders) {
        const t = new Date(o.date_created).getTime();
        if (t < t180) continue;
        const gross = (o.data.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
        const status = o.data.status || 'paid';
        const m = (revenue.months[monthAR(o.date_created)] ||= { orders: 0, amount: 0, cancelled: 0, cancelled_amount: 0 });
        if (t >= t30) revenue.statuses30[status] = (revenue.statuses30[status] || 0) + 1;
        if (!sold(o)) {
          m.cancelled++; m.cancelled_amount += gross;
          if (t >= t30) { revenue.cancelled30++; revenue.cancelled30_amount += gross; }
          continue;
        }
        m.orders++; m.amount += gross;
        revenue.d180 += gross; revenue.orders180++;
        if (t >= t90) { revenue.d90 += gross; revenue.orders90++; }
        if (t >= t30) { revenue.d30 += gross; revenue.orders30++; }
        for (const l of o.data.lines || []) {
          const a = (st[l.item_id] ||= { s30: 0, s90: 0, s180: 0, r180: 0, last: null });
          const q = Number(l.qty) || 0;
          a.s180 += q; a.r180 += q * (Number(l.unit_price) || 0);
          if (t >= t90) a.s90 += q;
          if (t >= t30) a.s30 += q;
          if (!a.last || o.date_created > a.last) a.last = o.date_created;
        }
      }
      job.meta.revenue = { ...revenue, at: now() };
      const items = await db.selectAll('rinde_items', { user_id: userId }, { columns: 'item_id,data', order: 'item_id.asc' });
      const keep = new Set(job.item_ids);
      const rows = items.filter((r) => keep.has(r.item_id)).map((r) => ({ user_id: userId, item_id: r.item_id, data: { ...r.data, sales30: st[r.item_id]?.s30 || 0, sales90: st[r.item_id]?.s90 || 0, sales180: st[r.item_id]?.s180 || 0, revenue180: st[r.item_id]?.r180 || 0, last_sale_at: st[r.item_id]?.last || null }, fetched_at: now() }));
      for (const part of meli.chunk(rows, 200)) await db.upsert('rinde_items', part, 'user_id,item_id');
      // publicaciones que ya no están activas/pausadas se borran
      const gone = items.filter((r) => !keep.has(r.item_id)).map((r) => r.item_id);
      if (gone.length) for (const part of meli.chunk(gone, 100)) await db.remove('rinde_items', { user_id: userId, item_id: part });
      Object.assign(job, { phase: 'done', status: 'done', finished_at: now() });
    }
  } catch (e) {
    if (e.status === 401) {
      // Token revocado o vencido: NO se borra nada; queda marcada para reconectar.
      if (e.name === 'MeliError') await markNeedsReconnect(userId, `api_401${e.path ? ' ' + String(e.path).split('?')[0].slice(0, 60) : ''}`);
      throw e;
    }
    job.error = e.message;
    job.retries = (job.retries || 0) + 1;
    if (job.retries > 5) job.status = 'error';
    await saveJob(job);
    throw e;
  }
  job.retries = 0;
  job.error = null;
  return saveJob(job);
}

/**
 * Historial por publicación desde las órdenes guardadas (sin canceladas):
 * unidades por mes del año (hora AR) y $ vendidos en los 60 días antes de su última venta.
 */
export function itemHistories(orders) {
  const by = {};
  for (const o of orders) {
    if (NOT_SOLD.has(o.data?.status)) continue;
    const t = new Date(o.date_created).getTime();
    const month = new Date(t - 3 * 3600000).getUTCMonth() + 1;
    for (const l of o.data?.lines || []) {
      const h = (by[l.item_id] ||= { months: {}, sales: [], last: 0, weeks: [0, 0, 0, 0, 0, 0] });
      const q = Number(l.qty) || 0;
      const wk = Math.floor((Date.now() - t) / (7 * DAY)); // 0 = últimos 7 días
      if (wk >= 0 && wk < 6) h.weeks[wk] += q;
      h.months[month] = (h.months[month] || 0) + q;
      h.sales.push([t, q * (Number(l.unit_price) || 0)]);
      if (t > h.last) h.last = t;
    }
  }
  const out = {};
  for (const [id, h] of Object.entries(by)) {
    const from = h.last - 60 * DAY;
    out[id] = { months: h.months, weeks: h.weeks, last_sale_at: new Date(h.last).toISOString(), rev60: h.sales.filter(([t]) => t >= from).reduce((s, [, v]) => s + v, 0) };
  }
  return out;
}

/** Carga todo lo necesario para armar el modelo de la cuenta. */
export async function loadAccount(userId) {
  const [user, items, orders, costs, job, plans] = await Promise.all([
    db.one('rinde_users', { id: userId }),
    db.selectAll('rinde_items', { user_id: userId }, { columns: 'item_id,data', order: 'item_id.asc' }),
    db.selectAll('rinde_orders', { user_id: userId }, { columns: 'order_id,date_created,data,fees,fees_source,taxes_unknown', order: 'date_created.desc' }),
    db.select('rinde_costs', { user_id: userId }),
    getJob(userId),
    db.select('rinde_ai_plans', { user_id: userId }, { columns: 'item_id,plan,input_hash' }),
  ]);
  const cutoff30 = Date.now() - 30 * DAY;
  const lines = [];
  for (const o of orders) {
    if (new Date(o.date_created).getTime() < cutoff30) continue;
    if (NOT_SOLD.has(o.data?.status)) continue;
    const ls = o.data.lines || [];
    const total = ls.reduce((s, l) => s + l.qty * l.unit_price, 0) || 1;
    for (const l of ls) {
      const share = (l.qty * l.unit_price) / total;
      const f = o.fees || { commission: (Number(l.sale_fee) || 0) * l.qty, shipping: 0, financing: 0, taxes: 0, other: 0 };
      lines.push({
        order_id: o.order_id, item_id: l.item_id, sku: l.sku, qty: l.qty, unit_price: l.unit_price, date: o.date_created,
        fees: o.fees ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'v').map(([k, v]) => [k, v * share])) : f,
        estimated: o.fees_source !== 'facturación',
        taxes_unknown: o.fees_source !== 'facturación' && (o.taxes_unknown || !o.fees),
        source: o.fees_source || 'orden',
      });
    }
  }
  const costMap = {};
  for (const c of costs) costMap[c.sku] = { purchase: c.purchase_cost, replacement: c.replacement_cost };
  const s = user?.settings || {};
  return {
    user,
    job,
    data: {
      items: (() => { const hist = itemHistories(orders); return items.map((r) => ({ ...r.data, hist: hist[r.data.id] || null })); })(),
      lines,
      costs: costMap,
      settings: { ads_manual_monthly: s.ads_manual_monthly || 0, meta_ads_monthly: s.meta_ads_monthly || 0 },
      productAds: job?.meta?.productAds || null,
      revenue: job?.meta?.revenue || null,
      seller: job?.meta?.seller || { reputation: s.reputation || null },
      prevReputation: s.prev_reputation || null,
      plans: Object.fromEntries(plans.map((p) => [p.item_id, p.plan])),
      planHashes: Object.fromEntries(plans.map((p) => [p.item_id, p.input_hash])),
    },
  };
}
