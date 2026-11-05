// Pruebas: la nota, las mejoras y las sugerencias cuentan SOLO atributos que ve el comprador o afectan la búsqueda.
// Uso: node scripts/test-atributos.mjs
import { isInternalAttr, cleanAttrs } from '../shared/attrs.js';
import { listingScore } from '../shared/score.js';
import { sourceOf, missingAttributes, ruleSuggestion } from '../shared/suggest.js';
import { missingAttrs } from '../api/_lib/meli.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// ── Qué es interno ──
ok(isInternalAttr({ id: 'VALUE_ADDED_TAX', name: 'IVA' }) && isInternalAttr({ id: 'IMPORT_DUTY', name: 'Impuesto interno' }), 'IVA e Impuesto interno: fiscales, no cuentan');
ok(isInternalAttr({ id: 'X', name: 'Impuestos internos' }) && isInternalAttr({ id: 'Y', name: 'Datos de facturación' }) && isInternalAttr({ id: 'Z', name: 'Factura A' }), 'Por nombre: impuestos, facturación');
ok(isInternalAttr({ id: 'SELLER_SKU', name: 'SKU' }) && isInternalAttr({ id: 'ITEM_CONDITION', name: 'Condición del ítem' }), 'SKU y condición: internos');
ok(['hidden', 'read_only', 'fixed', 'others', 'not_visible'].every((t) => isInternalAttr({ id: 'A', name: 'Algo', tags: { [t]: true } })), 'Ocultos, de solo lectura, fijos o no visibles para el comprador: no cuentan');
ok(isInternalAttr({ id: 'GTIN', name: 'Código universal de producto' }) && !isInternalAttr({ id: 'GTIN', name: 'Código universal de producto', tags: { required: true } }), 'Código de barras: solo cuenta si la categoría lo exige');
ok(!isInternalAttr({ id: 'BRAND', name: 'Marca' }) && !isInternalAttr({ id: 'VOLTAGE', name: 'Voltaje' }) && !isInternalAttr({ id: 'CELL_BATTERY_TYPE', name: 'Tipo de pila' }), 'Marca, voltaje, tipo de pila: sí cuentan');

// ── Trimmer de MATYPERE (MLA2864508298): datos guardados y lista de su categoría (MLA5411) ──
const trimmer = { id: 'MLA2864508298', title: 'Trimmer Afeitadora Recortadora Barba Portátil Usb 0.5mm A 4mm Color Dorado Oscuro', title_max: 60, price: 10000, listing_type: 'gold_special', status: 'active', available_quantity: 11, pictures_count: 3, pics: [1128, 1100, 658], visits30: 1, sales30: 0, desc_len: 1269, video: false, questions_unanswered: 0, catalog_listing: true, shipping: { free_shipping: false },
  attrs: { rec_total: 21, req_total: 2, rec_missing: ['Voltaje de la batería', 'Tipo de pila', 'IVA', 'Impuesto interno'], req_missing: [] } };
const rec = ['COLOR', 'VOLTAGE', 'MAIN_COLOR', 'FUNCTIONS', 'HEADS_TYPES', 'WITH_WASHABLE_HEADS', 'IS_SUITABLE_FOR_TRAVEL', 'IS_SUITABLE_FOR_BABIES', 'INCLUDES_RECHARGEABLE_BATTERY', 'COMBS_NUMBER', 'IS_WIRELESS', 'POSITIONS_NUMBER', 'POWER_SUPPLY_TYPE', 'ELECTRICAL_SAFETY_CERTIFICATE_NUMBER', 'OCP_CERTIFICATION_AGENCY', 'BATTERY_VOLTAGE', 'INCLUDES_ACCESSORIES', 'ACCESSORIES_INCLUDED'].map((id) => ({ id, name: id }));
const cat = { required: [{ id: 'BRAND', name: 'Marca' }, { id: 'MODEL', name: 'Modelo' }], recommended: [...rec, { id: 'CELL_BATTERY_TYPE', name: 'Tipo de pila' }, { id: 'VALUE_ADDED_TAX', name: 'IVA' }, { id: 'IMPORT_DUTY', name: 'Impuesto interno' }] };
const exact = cleanAttrs(trimmer.attrs, cat);
ok(exact.req_total === 2 && exact.rec_total === 19 && exact.rec_missing.join() === 'Tipo de pila', `Con la lista de la categoría: totales exactos sin fiscales (${exact.req_total}+${exact.rec_total})`);
const byName = cleanAttrs(trimmer.attrs);
ok(byName.rec_total === 19 && !byName.rec_missing.some((n) => /iva|impuesto/i.test(n)), 'Sin la lista: se sacan por nombre y se descuentan del total');
ok(JSON.stringify(cleanAttrs(byName)) === JSON.stringify(byName), 'Limpiar dos veces da lo mismo');

const before = listingScore({ ...trimmer, attrs: { ...trimmer.attrs, rec_missing: ['Voltaje de la batería', 'Tipo de pila'], rec_total: 19 } }, {}); // referencia: como si nunca hubieran estado
const after = listingScore(trimmer, {});
const fix = after.improvements.find((x) => x.key === 'atributos')?.text || '';
ok(!/IVA|Impuesto/i.test(fix) && /Te faltan 2 atributos: Voltaje de la batería, Tipo de pila/.test(fix), `Mejora del Trimmer sin IVA ni impuesto interno: "${fix}"`);
ok(!after.criteria.some((c) => /IVA|Impuesto/.test(c.note + (c.fix || ''))), 'La nota no menciona atributos fiscales en ningún criterio');
ok(after.score === before.score && after.score === 84, `Nota del Trimmer recalculada: 84 (antes 81 con IVA e impuesto interno)`);

// ── Sugerencias ──
const src = sourceOf({ item: trimmer, attributes: [{ id: 'VALUE_ADDED_TAX', name: 'IVA', value: '21 %' }, { id: 'BRAND', name: 'Marca', value: 'Genérica' }] });
const miss = missingAttributes(src);
ok(!miss.some((a) => /IVA|Impuesto/i.test(a.name)) && miss.map((a) => a.name).join() === 'Voltaje de la batería,Tipo de pila', 'Sugerencias: los atributos que faltan no incluyen IVA ni impuesto interno');
ok(!/IVA|21 %/.test(ruleSuggestion(src).description.text), 'La descripción sugerida no usa el IVA como característica');

// ── Sincronización: una caché de categoría vieja (con IVA) igual se filtra ──
const b = { attributes: [{ id: 'BRAND', value_name: 'X' }, { id: 'MODEL', value_name: 'Y' }], variations: [] };
const m = missingAttrs(b, cat);
ok(m.rec_total === 19 && !m.rec_missing.includes('IVA') && m.cleaned === 'categoria', 'missingAttrs con caché vieja: sin IVA ni impuesto interno en totales ni faltantes');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
