// Lectura de la FACTURACIÓN de Mercado Libre y de la orden, tolerante a formatos inesperados.
// Lo usa la sincronización (para calcular "Te quedó") y la pantalla de Validación del admin.

export const FEE_KEYS = ['commission', 'shipping', 'financing', 'taxes', 'other'];
export const FEE_LABELS = { commission: 'Comisión', shipping: 'Envío', financing: 'Cuotas', taxes: 'Retenciones', other: 'Otros / sin clasificar' };

export function categorize(label) {
  const l = String(label || '').toLowerCase();
  if (/env[ií]o|shipping|flete|\bcxd\b|\bcfe\b/.test(l)) return 'shipping';
  if (/cuota|financ|installment|\bcsi\b/.test(l)) return 'financing';
  if (/impuest|retenc|percep|iibb|iva|tax|ganancias/.test(l)) return 'taxes';
  if (/\bcv\b|venta|comisi|cargo por|sale fee/.test(l)) return 'commission';
  return 'other';
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const zero = () => Object.fromEntries(FEE_KEYS.map((k) => [k, 0]));

/**
 * Interpreta la respuesta de /billing/integration/group/ML/order/details.
 * Formato esperado: { results: [ { charge_info: { detail_type, detail_sub_type, transaction_detail, detail_amount }, sales_info: [...] } ] }
 * Si el formato no coincide, no se rompe: intenta encontrar montos igual y lo informa en `problems`.
 */
export function parseBilling(raw) {
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
  if (!rows.length) { out.empty = true; return out; }

  const addLine = (src, ci, path) => {
    const amount = num(ci.detail_amount ?? ci.amount ?? ci.charge_amount);
    if (Number.isNaN(amount)) return false;
    const type = String(ci.detail_type || ci.type || '');
    const sub = String(ci.detail_sub_type || ci.sub_type || ci.code || '');
    const desc = String(ci.transaction_detail || ci.description || ci.concept || '');
    const isBonus = /bonus|bonif|credit|devoluc/i.test(type) || /bonif/i.test(desc);
    const signed = isBonus ? -Math.abs(amount) : Math.abs(amount);
    const category = categorize(`${sub} ${desc} ${type}`);
    out.lines.push({ type, sub, desc, amount, signed, category, source: path });
    out.fees[category] += signed;
    out.total += signed;
    return true;
  };

  rows.forEach((r, i) => {
    if (r && typeof r === 'object' && r.charge_info && typeof r.charge_info === 'object') {
      if (!addLine(r, r.charge_info, `results[${i}].charge_info`)) {
        out.formatOk = false;
        out.problems.push(`results[${i}].charge_info no trae un monto numérico (claves: ${Object.keys(r.charge_info).join(', ')}).`);
      }
    } else {
      out.formatOk = false;
      const keys = r && typeof r === 'object' ? Object.keys(r).join(', ') : typeof r;
      out.problems.push(`results[${i}] no tiene "charge_info" (claves: ${keys}).`);
      // búsqueda de rescate: cualquier objeto con un monto
      const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((n, j) => walk(n, `${path}[${j}]`));
        if (('detail_amount' in node || 'amount' in node) && addLine(r, node, path)) return;
        for (const k of Object.keys(node)) if (typeof node[k] === 'object') walk(node[k], `${path}.${k}`);
      };
      walk(r, `results[${i}]`);
    }
  });
  if (!out.lines.length) out.problems.push('No encontramos ningún monto en la respuesta.');
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
  const f = order.fees;
  const fees = { commission: f.commission || 0, shipping: f.shipping || 0, financing: 0, taxes: f.taxes || 0, other: 0 };
  return { source: 'orden (estimado)', fees, total: fees.commission + fees.shipping + fees.taxes, estimated: true };
}
