// Atributos que cuentan para la nota, las mejoras y las sugerencias: SOLO los que ve el comprador o afectan la búsqueda.
// Se excluyen los fiscales e internos (IVA, impuesto interno, datos de facturación, SKU, condición), el código de
// barras salvo que la categoría lo exija, y todo lo que Mercado Libre marca como oculto, de solo lectura, fijo o
// no visible para el comprador.

const INTERNAL_IDS = new Set([
  'VALUE_ADDED_TAX', 'IMPORT_DUTY', 'SELLER_SKU', 'ITEM_CONDITION', 'EMPTY_GTIN_REASON', 'PRODUCT_DATA_SOURCE',
  'IS_SUITABLE_FOR_SHIPMENT', 'HAZMAT_TRANSPORTABILITY', 'SHIPMENT_PACKING', 'INVOICE', 'TAX_CODE', 'NCM',
]);
const INTERNAL_NAME = /(^|\s|\()(iva|impuestos?|percepci[oó]n(es)?|retenci[oó]n(es)?|facturaci[oó]n|factura|condici[oó]n fiscal|c[oó]digo fiscal|posici[oó]n arancelaria|ncm)(\b|$)|^sku\b/i;
const HIDDEN_TAGS = ['hidden', 'read_only', 'fixed', 'others', 'not_visible', 'internal'];
const GTIN = new Set(['GTIN', 'EAN', 'UPC']);

/** true si el atributo NO lo ve el comprador ni afecta la búsqueda (no cuenta). */
export function isInternalAttr(a) {
  if (!a) return true;
  if (INTERNAL_IDS.has(a.id)) return true;
  if (INTERNAL_NAME.test(String(a.name || '').trim())) return true;
  if (HIDDEN_TAGS.some((t) => a.tags?.[t])) return true;
  // Código de barras: solo cuenta si la categoría lo exige.
  if (GTIN.has(a.id) || /^c[oó]digo de barras|^c[oó]digo universal/i.test(String(a.name || ''))) return !(a.tags?.required || a.tags?.catalog_required);
  return false;
}
export const isInternalName = (name) => INTERNAL_NAME.test(String(name || '').trim());

/**
 * Limpia los atributos guardados de una publicación ({ req_total, rec_total, req_missing, rec_missing }).
 * Con la lista de la categoría (caché de MeLi), los totales se recalculan exactos. Sin ella, se sacan de los
 * faltantes por nombre y se descuentan del total.
 */
export function cleanAttrs(attrs, cat = null) {
  if (!attrs) return attrs;
  const keep = (n) => !isInternalName(n);
  const req_missing = (attrs.req_missing || []).filter(keep);
  const rec_missing = (attrs.rec_missing || []).filter(keep);
  if (cat?.required && cat?.recommended) {
    const req = cat.required.filter((a) => !isInternalAttr(a));
    const rec = cat.recommended.filter((a) => !isInternalAttr(a));
    const names = new Set([...req, ...rec].map((a) => a.name));
    return { req_total: req.length, rec_total: rec.length, req_missing: req_missing.filter((n) => names.has(n)), rec_missing: rec_missing.filter((n) => names.has(n)), cleaned: 'categoria' };
  }
  const removedReq = (attrs.req_missing || []).length - req_missing.length;
  const removedRec = (attrs.rec_missing || []).length - rec_missing.length;
  return { req_total: Math.max(0, (attrs.req_total || 0) - removedReq), rec_total: Math.max(0, (attrs.rec_total || 0) - removedRec), req_missing, rec_missing, cleaned: attrs.cleaned || 'nombre' };
}

// ── Textos ya guardados (planes de IA, resúmenes, sugerencias) que mencionen atributos fiscales o internos ──
const INTERNAL_IN_TEXT = /\b(IVA|impuestos? internos?|datos de facturaci[oó]n)\b/i;
const ATTR_CONTEXT = /atribut|carg[aá]|complet|ficha|faltan?/i;
/** true si el texto habla de atributos y nombra uno fiscal/interno ("Cargá …, IVA, Impuesto interno"). */
export function mentionsInternalAttr(text) {
  const t = String(text || '');
  return INTERNAL_IN_TEXT.test(t) && ATTR_CONTEXT.test(t);
}
/** Sugerencia guardada: fuera los atributos fiscales/internos de la lista y de la descripción. */
export function scrubSuggestion(s) {
  if (!s) return s;
  const out = { ...s };
  if (Array.isArray(out.attributes)) out.attributes = out.attributes.filter((a) => !a.fiscal && !isInternalName(a.name));
  if (out.description?.text) {
    const text = out.description.text.split('\n').filter((l) => !/^\s*-?\s*(IVA|impuestos? internos?)\s*:/i.test(l)).join('\n');
    out.description = { ...out.description, text, length: text.length };
  }
  return out;
}
