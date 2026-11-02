// Reporte de Validación: compara, venta por venta, lo que calcula Rinde contra la facturación de MeLi y la orden.
import { parseBilling, orderFees, rindeFees, FEE_KEYS, FEE_LABELS } from './billing.js';

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
    const billing = c.billing?.body !== undefined ? parseBilling(c.billing.body) : null;
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
    if (c.billing?.status && c.billing.status >= 400) flags.push(`Facturación respondió error ${c.billing.status}.`);
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
