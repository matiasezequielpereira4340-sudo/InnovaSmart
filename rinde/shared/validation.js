// Reporte de Validación: compara, venta por venta, lo que calcula Rinde contra la facturación de MeLi y la orden.
import { parseBilling, orderFees, rindeFees, categorize, FEE_KEYS, FEE_LABELS } from './billing.js';

export const DIFF_ALERT = 0.02; // 2 %

function diff(a, b, base) {
  if (a == null || b == null) return null;
  const d = a - b;
  const ref = Math.abs(base ?? b) || 0;
  const pct = ref > 0 ? d / ref : d === 0 ? 0 : 1;
  return { amount: d, pct, alert: Math.abs(pct) > DIFF_ALERT && Math.abs(d) >= 1 };
}

/**
 * @param input {
 *   orders: [orden cruda de /orders/search],
 *   calls: { [order_id]: { billing: {status, param, body}, shipment: {status, body} } },
 *   items: [snapshots de publicaciones] (para el contador de competencia)
 * }
 */
export function buildValidationReport({ orders = [], calls = {}, items = [], ordersCall = null }) {
  const sales = orders.slice(0, 10).map((o) => {
    const c = calls[o.id] || {};
    const billing = c.billing?.status === 200 ? parseBilling(c.billing.body, o.id) : null;
    const ord = orderFees(o, c.shipment?.body);
    const rinde = rindeFees(billing, ord);
    const billTotal = billing && billing.lines.length ? billing.total : null;
    const gross = ord.gross;

    const rows = FEE_KEYS.map((k) => {
      const r = rinde.fees[k] ?? 0;
      const b = billing && billing.lines.length ? billing.fees[k] : null;
      const or = ord.fees[k];
      return { key: k, label: FEE_LABELS[k], rinde: r, billing: b, order: or, dRB: diff(r, b, b), dOB: diff(or, b, b) };
    });
    const net = { rinde: gross - rinde.total, billing: billTotal != null ? gross - billTotal : null, order: gross - ord.total };
    const totals = {
      key: 'total', label: 'Total cargos', rinde: rinde.total, billing: billTotal, order: ord.total,
      dRB: diff(rinde.total, billTotal, billTotal), dOB: diff(ord.total, billTotal, billTotal),
    };
    const netRow = { key: 'net', label: 'Te quedó (antes del costo del producto)', rinde: net.rinde, billing: net.billing, order: net.order, dRB: diff(net.rinde, net.billing, gross), dOB: diff(net.order, net.billing, gross) };

    const flags = [];
    if (c.billing?.status === 429) flags.push('Mercado Libre limitó los pedidos a la facturación (429, máximo 5 por minuto): esta venta quedó sin control independiente.');
    else if (c.billing?.status && c.billing.status >= 400) flags.push(`Facturación respondió error ${c.billing.status}.`);
    if (billing?.empty) flags.push('La facturación todavía no tiene esta venta: Rinde usa la orden (estimado).');
    if (billing && !billing.formatOk) flags.push('El formato de la facturación no es el que esperábamos.');
    if (billing) billing.problems.forEach((p) => flags.push(p));
    const unmapped = billing ? billing.lines.filter((l) => l.category === 'other') : [];
    if (unmapped.length) flags.push(`${unmapped.length} cargo(s) de la facturación sin clasificar: ${unmapped.map((l) => l.desc || l.sub || l.type).join(' · ')}.`);
    if (billing?.lines.length && billing.fees.financing > 0) flags.push('La orden no informa el costo de las cuotas: con la orden sola, los cargos quedan cortos.');
    // Cuentan como alerta: cualquier diferencia Rinde vs facturación, y comisión/envío de la orden vs facturación.
    const alerts = [...rows, totals, netRow].filter((r) => r.dRB?.alert || (['commission', 'shipping'].includes(r.key) && r.dOB?.alert)).length;
    const noTaxes = !!(billing?.lines.length && !billing.fees.taxes);

    return {
      order_id: String(o.id),
      date: o.date_created,
      title: o.order_items?.[0]?.item?.title || o.order_items?.[0]?.item?.id || '',
      item_id: o.order_items?.[0]?.item?.id || null,
      qty: (o.order_items || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0),
      gross,
      source: rinde.source,
      billingParam: c.billing?.param || null,
      billingLines: billing?.lines || [],
      rows: [...rows, totals, netRow],
      flags,
      alerts,
      formatOk: billing ? billing.formatOk : null,
      noTaxes,
    };
  });

  const comp = {
    total: items.length,
    sinDato: items.filter((i) => !i.competition).length,
    catalogoSinDato: items.filter((i) => !i.competition && i.catalog_product_id).length,
    busquedaSinDato: items.filter((i) => !i.competition && !i.catalog_product_id).length,
  };
  comp.pct = comp.total ? comp.sinDato / comp.total : 0;

  const withBilling = sales.filter((s) => s.source === 'facturación');
  const params = [...new Set(sales.map((s) => s.billingParam).filter(Boolean))];
  return {
    created_at: new Date().toISOString(),
    summary: {
      sales: sales.length,
      withBilling: withBilling.length,
      estimated: sales.length - withBilling.length,
      formatProblems: sales.filter((s) => s.formatOk === false).length,
      withAlerts: sales.filter((s) => s.alerts > 0).length,
      noTaxes: sales.filter((s) => s.noTaxes).length,
      billingParam: params.join(', ') || 'ninguno',
      ordersStatus: ordersCall?.status ?? null,
    },
    competition: comp,
    sales,
  };
}

/** Saca datos personales y credenciales de las respuestas crudas antes de guardarlas. */
export function scrub(value) {
  const BAD = /token|secret|authorization|password|buyer|receiver|address|phone|email|first_name|last_name|identification|doc_number|billing_info|card/i;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = BAD.test(k) ? '[oculto]' : scrub(v);
    return o;
  }
  return value;
}

// ───────────── Liquidación real (Mercado Pago) vs "Te quedó" de Rinde ─────────────
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => '$' + Math.round(v).toLocaleString('es-AR');

/** Lee un pago (/v1/payments de Mercado Pago o /collections de MeLi): neto recibido y cargos por concepto. */
export function parseSettlement(body) {
  if (!body || typeof body !== 'object') return null;
  const p = body.collection && typeof body.collection === 'object' ? body.collection : body;
  const net = p.transaction_details?.net_received_amount ?? p.amounts?.collector?.net_received ?? p.net_received_amount ?? null;
  const fees = Object.fromEntries(FEE_KEYS.map((k) => [k, 0]));
  const lines = [];
  const charges = Array.isArray(p.charges_details) ? p.charges_details.filter((c) => !c.accounts || c.accounts.from === 'collector') : [];
  if (charges.length) {
    for (const c of charges) {
      const amt = n0(c.amounts?.original ?? c.amount) - n0(c.amounts?.refunded);
      let k = c.type === 'tax' ? 'taxes' : categorize(`${c.name || ''} ${c.type || ''}`);
      if (k === 'other' && c.type === 'fee') k = 'commission';
      fees[k] += amt;
      lines.push({ concept: c.name || c.type, type: c.type, key: k, amount: amt });
    }
  } else if (Array.isArray(p.fee_details)) {
    for (const f of p.fee_details.filter((x) => !x.fee_payer || x.fee_payer === 'collector')) {
      const t = String(f.type || '');
      const k = /financ/.test(t) ? 'financing' : /shipping/.test(t) ? 'shipping' : /tax/.test(t) ? 'taxes' : 'commission';
      fees[k] += n0(f.amount);
      lines.push({ concept: t, type: t, key: k, amount: n0(f.amount) });
    }
  }
  return { net: net == null ? null : Number(net), gross: n0(p.transaction_amount), buyerShipping: n0(p.shipping_amount ?? p.shipping_cost), status: p.status || null, fees, lines };
}

/**
 * Compara por venta lo que muestra Rinde ("Te quedó") contra lo que Mercado Pago efectivamente liquidó.
 * @param sale fila del reporte de validación
 * @param stored fees que Rinde guardó para esa orden (lo que ve el usuario en la app), o null
 * @param settlements [{ payment_id, raw: { status, body, source } }]
 */
export function compareSettlement(sale, stored, settlements) {
  const parsed = settlements.map((s) => ({ id: s.payment_id, source: s.raw?.source || null, status: s.raw?.status ?? null, p: s.raw?.status === 200 ? parseSettlement(s.raw.body) : null }));
  const ok = parsed.filter((x) => x.p && x.p.net != null && !['refunded', 'cancelled', 'rejected'].includes(x.p.status));
  const shown = stored?.fees || Object.fromEntries((sale.rows || []).filter((r) => FEE_KEYS.includes(r.key)).map((r) => [r.key, r.rinde]));
  const rindeTotal = FEE_KEYS.reduce((t, k) => t + n0(shown[k]), 0);
  const out = {
    gross: sale.gross, rindeNet: sale.gross - rindeTotal, rindeSource: stored?.fees_source || sale.source,
    meliNet: null, diff: null, pct: null, alert: false, explain: null, concepts: [],
    payments: parsed.map((x) => ({ id: x.id, source: x.source, status: x.status, pay_status: x.p?.status || null })),
  };
  if (!ok.length) {
    out.explain = `No pudimos leer la liquidación (${parsed.map((x) => `pago ${x.id}: respuesta ${x.status ?? 'ninguna'}`).join(', ') || 'la venta no trae pagos'}).`;
    return out;
  }
  // Lo que pagó el comprador por el envío entra al pago pero no es venta: se descuenta para comparar parejo.
  out.buyerShipping = ok.reduce((t, x) => t + x.p.buyerShipping, 0);
  out.meliNet = ok.reduce((t, x) => t + x.p.net, 0) - out.buyerShipping;
  out.diff = out.rindeNet - out.meliNet;
  out.pct = sale.gross ? out.diff / sale.gross : null;
  out.alert = out.pct != null && Math.abs(out.pct) > DIFF_ALERT && Math.abs(out.diff) >= 1;
  out.concepts = FEE_KEYS.map((k) => {
    const m = ok.reduce((t, x) => t + x.p.fees[k], 0);
    return { key: k, label: FEE_LABELS[k], rinde: n0(shown[k]), meli: m, diff: n0(shown[k]) - m };
  });
  out.mpLines = ok.flatMap((x) => x.p.lines);
  if (out.alert) {
    const worst = [...out.concepts].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];
    const residual = out.diff + out.concepts.reduce((t, c) => t + c.diff, 0);
    out.explain = worst && Math.abs(worst.diff) >= Math.abs(residual)
      ? `La diferencia viene sobre todo de ${worst.label.toLowerCase()}: Rinde descuenta ${money(worst.rinde)} y el pago muestra ${money(worst.meli)}.${worst.key === 'shipping' && worst.meli === 0 ? ' Mercado Libre puede cobrar el envío aparte (en la factura) y no en el pago.' : ''}`
      : `Los cargos por concepto casi coinciden; la diferencia (${money(residual)}) está en el monto cobrado: descuentos, cupones, bonificaciones o envío.`;
  }
  return out;
}

/** Agrega a cada venta del reporte la comparación contra la liquidación real. */
export function attachSettlements(report, calls, storedBy = {}) {
  for (const sale of report.sales) sale.settlement = compareSettlement(sale, storedBy[sale.order_id]?.fees ? storedBy[sale.order_id] : null, calls[sale.order_id]?.settlements || []);
  const sv = report.sales.map((x) => x.settlement).filter((x) => x.meliNet != null);
  report.summary.settled = sv.length;
  report.summary.settledAlerts = sv.filter((x) => x.alert).length;
  return report;
}
