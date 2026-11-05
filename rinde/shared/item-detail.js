// Desglose de plata por venta de una publicación (últimos 90 días). Mismo cálculo en el demo y en la cuenta real.
// "Te quedó" = precio − comisión − cargo fijo − cuotas − envío − retenciones − otros − publicidad − costo del producto.
// La comisión que informa MeLi ya incluye el cargo fijo: acá se muestran separados.

/**
 * @param lines ventas [{order_id, date, qty, unit_price, fees:{commission, fixed_fee, financing, shipping, taxes, other}, source, shipping_unknown}]
 * @param opts { cost: {purchase, replacement} | null, adsPerUnit: número (publicidad prorrateada por unidad) }
 */
export function saleRows(lines, { cost = null, adsPerUnit = 0 } = {}) {
  const pu = cost && cost.purchase != null && cost.purchase !== '' && !Number.isNaN(Number(cost.purchase)) ? Number(cost.purchase) : null;
  const rows = (lines || []).map((l) => {
    const qty = Number(l.qty) || 1;
    const f = l.fees || {};
    const fixed = Number(f.fixed_fee) || 0;
    const r = {
      order_id: l.order_id, date: l.date, qty,
      price: (Number(l.unit_price) || 0) * qty,
      commission: (Number(f.commission) || 0) - fixed,
      fixed,
      financing: Number(f.financing) || 0,
      shipping: Number(f.shipping) || 0,
      taxes: Number(f.taxes) || 0,
      other: Number(f.other) || 0,
      ads: adsPerUnit * qty,
      cost: pu != null ? pu * qty : null,
      source: l.source || 'orden',
      shippingUnknown: !!l.shipping_unknown,
    };
    r.charges = r.commission + r.fixed + r.financing + r.shipping + r.taxes + r.other;
    r.left = r.cost != null ? r.price - r.charges - r.ads - r.cost : null;
    r.beforeCost = r.price - r.charges - r.ads;
    return r;
  });
  const units = rows.reduce((s, r) => s + r.qty, 0);
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const avg = units ? Object.fromEntries(['price', 'commission', 'fixed', 'financing', 'shipping', 'taxes', 'other', 'ads', 'charges', 'beforeCost'].map((k) => [k, sum(k) / units])) : null;
  if (avg) { avg.cost = pu; avg.left = pu != null ? avg.beforeCost - pu : null; }
  return { rows, units, avg, hasCost: pu != null, partial: rows.some((r) => r.source !== 'facturación'), shippingUnknown: rows.some((r) => r.shippingUnknown) };
}

/** Estado legible de una publicación (puede tener más de uno). */
export function itemStates(it, group) {
  const out = [];
  const noStock = (it.available_quantity ?? 1) === 0 || (it.sub_status || []).includes('out_of_stock');
  if (it.status === 'active' && !noStock) out.push(['Activa', 'ok']);
  if (it.status === 'paused') out.push(['Pausada', 'warn']);
  if (it.status === 'under_review') out.push(['En revisión', 'bad']);
  if (noStock) out.push(['Sin stock', 'bad']);
  if (group === 'TEMPORADA') out.push(['De temporada', 'neutral']);
  if (group === 'ABANDONADAS') out.push(['Abandonada', 'neutral']);
  return out;
}

/** Búsqueda por título o número de publicación (MLA123… o solo los números). */
export function searchItems(rows, q, limit = 8) {
  const raw = String(q || '').trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, '');
  const n = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = n(raw).split(/\s+/).filter(Boolean);
  const byId = digits.length >= 4 ? rows.filter((r) => String(r.it.id).includes(digits)) : [];
  const byTitle = rows.filter((r) => !byId.includes(r) && words.every((w) => n(r.it.title).includes(w)));
  return [...byId, ...byTitle].slice(0, limit);
}
