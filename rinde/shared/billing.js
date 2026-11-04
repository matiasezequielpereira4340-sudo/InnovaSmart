// Lectura de la FACTURACIÓN de Mercado Libre y de la orden, tolerante a formatos inesperados.
// Lo usa la sincronización (para calcular "Te quedó") y la pantalla de Validación del admin.

export const FEE_KEYS = ['commission', 'shipping', 'financing', 'taxes', 'other'];
export const FEE_LABELS = { commission: 'Comisión', shipping: 'Envío', financing: 'Cuotas', taxes: 'Retenciones', other: 'Otros / sin clasificar' };

// Cargo fijo por unidad vendida (CVFF / "Costo por unidad vendida" / flat_fee): va en Comisión, marcado como cargo fijo.
export const isFixedFee = (label) => /\bcvff\b|unidad vendida|cargo fijo|flat_fee|fixed_fee/i.test(String(label || ''));

export function categorize(label) {
  const l = String(label || '').toLowerCase();
  if (isFixedFee(l)) return 'commission';
  if (/env[ií]o|shipping|\bshp_|flete|\bcxd\b|\bcfe\b/.test(l)) return 'shipping';
  if (/cuota|financ|installment|\bcsi\b|\bcvfn\b/.test(l)) return 'financing';
  if (/impuest|retenc|percep|iibb|iva|tax|ganancias|sirtac/.test(l)) return 'taxes';
  if (/\bcv\b|\bcvfv\b|venta|vender|comisi|cargo por|sale fee|percentage_fee/.test(l)) return 'commission';
  return 'other';
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const zero = () => ({ ...Object.fromEntries(FEE_KEYS.map((k) => [k, 0])), fixed_fee: 0 });

/**
 * Interpreta la respuesta de /billing/integration/group/ML/order/details (sirve para una o varias ventas).
 * Formato real (2026): { results: [ { order_id, details: [ { charge_info: {...}, sales_info, items_info } ], payment_info: [ { tax_details: [...] } ] } ] }
 * También acepta el formato viejo { results: [ { charge_info } ] }. Si no coincide, busca montos igual y lo informa en `problems`.
 * @param orderId si viene, toma solo las líneas de esa venta (respuesta de varias ventas juntas).
 */
export function parseBilling(raw, orderId = null) {
  const out = { formatOk: true, empty: false, problems: [], lines: [], fees: zero(), total: 0, keysSeen: [] };
  if (raw == null) { out.empty = true; return out; }
  if (typeof raw !== 'object') { out.formatOk = false; out.problems.push(`La respuesta no es un objeto JSON (vino ${typeof raw}).`); return out; }
  out.keysSeen = Array.isArray(raw) ? ['(lista)'] : Object.keys(raw).slice(0, 15);

  let rows = null;
  if (Array.isArray(raw.results)) rows = raw.results;
  else {
    out.formatOk = false;
    const alt = raw.data || raw.details || raw.charges || (Array.isArray(raw) ? raw : null);
    out.problems.push(`No vino la lista "results". Claves recibidas: ${out.keysSeen.join(', ') || 'ninguna'}.`);
    if (Array.isArray(alt)) rows = alt;
  }
  if (!rows) return out;
  const same = (a) => a == null || orderId == null || String(a) === String(orderId);
  if (orderId != null) rows = rows.filter((r) => same(r?.order_id ?? r?.sales_info?.[0]?.order_id ?? r?.details?.[0]?.sales_info?.[0]?.order_id));
  if (!rows.length) { out.empty = true; return out; }

  const addLine = (ci, path) => {
    const amount = num(ci.detail_amount ?? ci.amount ?? ci.charge_amount);
    if (Number.isNaN(amount)) return false;
    const type = String(ci.detail_type || ci.type || '');
    const sub = String(ci.detail_sub_type || ci.sub_type || ci.code || '');
    const desc = String(ci.transaction_detail || ci.description || ci.concept || '').trim();
    const isBonus = /bonus|bonif|credit|devoluc/i.test(type) || /bonif/i.test(desc);
    const signed = isBonus ? -Math.abs(amount) : Math.abs(amount);
    const category = categorize(`${sub} ${desc} ${type}`);
    const fixed = isFixedFee(`${sub} ${desc}`);
    out.lines.push({ type, sub, desc, amount, signed, category, fixed, source: path });
    out.fees[category] += signed;
    if (fixed) out.fees.fixed_fee += signed;
    out.total += signed;
    return true;
  };

  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') { out.formatOk = false; out.problems.push(`results[${i}] no es un objeto.`); return; }
    let read = 0;
    if (Array.isArray(r.details)) {
      r.details.forEach((d, j) => { if (d?.charge_info && typeof d.charge_info === 'object' && addLine(d.charge_info, `results[${i}].details[${j}].charge_info`)) read++; });
    } else if (r.charge_info && typeof r.charge_info === 'object') {
      if (addLine(r.charge_info, `results[${i}].charge_info`)) read++;
    }
    // Retenciones (IIBB / SIRTAC) que vienen en el pago de la venta.
    for (const p of Array.isArray(r.payment_info) ? r.payment_info : []) {
      for (const t of Array.isArray(p?.tax_details) ? p.tax_details : []) {
        if (t?.from && t.from !== 'collector') continue;
        const amount = num(t.original_amount ?? t.amount) - (num(t.refunded_amount) || 0);
        if (Number.isNaN(amount)) continue;
        const desc = `Retención ${String(t.mov_detail || 'impuesto').replace(/_/g, ' ')}${t.mov_financial_entity ? ' · ' + String(t.mov_financial_entity).replace(/_/g, ' ') : ''}`;
        out.lines.push({ type: 'TAX', sub: String(t.mov_detail || ''), desc, amount, signed: amount, category: 'taxes', fixed: false, source: `results[${i}].payment_info.tax_details` });
        out.fees.taxes += amount;
        out.total += amount;
        read++;
      }
    }
    if (!read) {
      out.formatOk = false;
      out.problems.push(`results[${i}] no trae cargos en un formato conocido (claves: ${Object.keys(r).slice(0, 10).join(', ')}).`);
      const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((n, j) => walk(n, `${path}[${j}]`));
        if (('detail_amount' in node || 'amount' in node) && addLine(node, path)) return;
        for (const k of Object.keys(node)) if (typeof node[k] === 'object') walk(node[k], `${path}.${k}`);
      };
      walk(r, `results[${i}]`);
    }
  });
  if (!out.lines.length) { out.problems.push('No encontramos ningún monto en la respuesta.'); out.empty = !out.problems.length; }
  return out;
}

/** Lo que dice la orden (y el costo de envío del shipment). Las cuotas no vienen en la orden. */
export function orderFees(order, shipmentCosts) {
  const items = order?.order_items || [];
  const gross = items.reduce((s, l) => s + (Number(l.unit_price) || 0) * (Number(l.quantity) || 0), 0);
  const commissionKnown = items.some((l) => l.sale_fee != null);
  const commission = items.reduce((s, l) => s + (Number(l.sale_fee) || 0) * (Number(l.quantity) || 1), 0);
  const sender = shipmentCosts?.senders?.[0];
  const shipping = sender ? Number(sender.cost || 0) : null;
  const taxesArr = (order?.payments || []).map((p) => p.taxes_amount).filter((x) => x != null);
  const taxes = taxesArr.length ? taxesArr.reduce((s, x) => s + Number(x), 0) : null;
  return {
    gross,
    fees: { commission: commissionKnown ? commission : null, shipping, financing: null, taxes, other: null },
    total: (commissionKnown ? commission : 0) + (shipping || 0) + (taxes || 0),
  };
}

/** Lo que usa Rinde: facturación si hay datos legibles; si no, la orden (marcado "estimado"). */
export function rindeFees(billing, order) {
  if (billing && billing.lines.length) return { source: 'facturación', fees: { ...billing.fees }, total: billing.total, estimated: false };
  // Sin facturación: la orden trae un solo sale_fee que mezcla comisión, cargo fijo y cuotas (no se puede separar).
  const f = order.fees;
  const fees = { commission: f.commission || 0, shipping: f.shipping || 0, financing: 0, taxes: f.taxes || 0, other: 0 };
  return { source: 'orden (estimado)', fees, total: fees.commission + fees.shipping + fees.taxes, estimated: true };
}
