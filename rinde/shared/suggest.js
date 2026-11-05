// Rinde — Sugerencias listas para copiar (título, descripción, atributos faltantes).
// Mismo código en el servidor (IA + control), en el demo (sin IA) y en las pruebas.
//
// Regla dura: nada que no esté en la publicación. Lo que falta va entre corchetes, por ejemplo [MEDIDA].
// El control (checkTitle / guardText) se aplica SIEMPRE a lo que devuelve la IA: si no pasa, se corrige o se descarta.

export const NOTE_FIXED = 'Revisalo antes de pegarlo en Mercado Libre: Rinde no publica nada por vos.';
export const NOTE_BRACKETS = 'Completá lo que está entre corchetes antes de pegarlo.';
export const ATTR_HINT = 'Completá con el dato real del producto';
export const TITLE_LOCKED_SALES = 'Mercado Libre no permite cambiar el título de una publicación con ventas. Si querés otro título, tenés que crear una publicación nueva.';
export const TITLE_LOCKED_CATALOG = 'Esta publicación está en el catálogo de Mercado Libre: el título lo pone el catálogo y no se puede cambiar desde la publicación.';
export const SUGGEST_LIMITS = { PAID_PER_DAY: 30, FREE_ITEMS: 1, FREE_GENERATIONS: 3 };
import { isInternalAttr, cleanAttrs } from './attrs.js';
export const DEFAULT_TITLE_MAX = 60; // si Mercado Libre no informa el máximo de la categoría

const STOP = new Set(['de', 'del', 'para', 'con', 'sin', 'y', 'e', 'o', 'u', 'el', 'la', 'los', 'las', 'en', 'x', 'por', 'a', 'al', 'un', 'una', 'tipo', 'tu', 'su']);
// Atributos que no son del producto o no suman en un título/descripción.
const SKIP_ATTR = new Set(['SELLER_SKU', 'GTIN', 'EMPTY_GTIN_REASON', 'ITEM_CONDITION', 'VALUE_ADDED_TAX', 'IMPORT_DUTY', 'IVA', 'IMPUESTO_INTERNO', 'PRODUCT_DATA_SOURCE', 'IS_KIT', 'IS_FLAMMABLE', 'IS_SUITABLE_FOR_SHIPMENT', 'HAZMAT_TRANSPORTABILITY']);
const FISCAL = /^(iva|impuesto interno)$/i;
const TITLE_ATTRS = ['BRAND', 'MODEL', 'LINE', 'COLOR', 'MAIN_COLOR', 'MATERIAL', 'SIZE', 'CAPACITY', 'POWER', 'VOLTAGE', 'LENGTH', 'WIDTH'];
const MEASURE = /\b(alto|ancho|largo|profundidad|di[aá]metro|peso|medidas?|tama[nñ]o|capacidad|volumen|longitud)\b/i;
const INCLUDES = /\b(incluye|incluidos?|accesorios|unidades por (pack|kit)|formato de venta|cantidad de (piezas|unidades))\b/i;

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokens = (s) => norm(s).split(/[^a-z0-9ñ]+/).filter(Boolean);
const cap = (w) => (w.length > 3 && w === w.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(w) && !/\d/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w);

/** Texto plano de una descripción de MeLi (sin HTML). */
export function plain(s) {
  return String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Normaliza los datos de una publicación a la "fuente" de la sugerencia.
 * attributes: [{ id, name, value }] (solo los que tienen valor), questions: [{ q, a }] (respondidas).
 */
export function sourceOf({ item = {}, attributes = [], description = '', questions = [], category = null } = {}) {
  const attrs = (attributes || [])
    .map((a) => ({ id: a.id || null, name: a.name || a.id || '', value: String(a.value ?? a.value_name ?? '').trim() }))
    .filter((a) => a.value && !SKIP_ATTR.has(a.id) && !FISCAL.test(a.name) && !isInternalAttr(a));
  const miss = cleanAttrs(item.attrs) || {};
  return {
    id: item.id,
    title: String(item.title || '').trim(),
    category: category?.name || null,
    title_max: Number(category?.max_title || item.title_max) || null,
    sold_quantity: item.sold_quantity ?? null,
    sales180: item.sales180 ?? item.sales90 ?? 0,
    catalog_listing: !!item.catalog_listing,
    attributes: attrs,
    description: plain(description),
    questions: (questions || []).map((x) => ({ q: plain(x.q || x.text), a: plain(x.a || x.answer) })).filter((x) => x.q && x.a).slice(0, 8),
    missing: { required: miss.req_missing || [], recommended: miss.rec_missing || [] },
  };
}

/** ¿Se puede sugerir un título nuevo? Regla de MeLi: no con ventas (sold_quantity > 0). Catálogo: lo fija el catálogo. */
export function titleRule(src) {
  const sold = src.sold_quantity != null ? src.sold_quantity > 0 : (src.sales180 || 0) > 0;
  if (sold) return { allowed: false, reason: 'ventas', message: TITLE_LOCKED_SALES };
  if (src.catalog_listing) return { allowed: false, reason: 'catalogo', message: TITLE_LOCKED_CATALOG };
  return { allowed: true, max: src.title_max || DEFAULT_TITLE_MAX, confirmed: src.sold_quantity != null };
}

/** Todas las palabras que aparecen en la publicación (lo único que puede usar una sugerencia). */
export function corpus(src) {
  const parts = [src.title, src.category, src.description, ...src.attributes.flatMap((a) => [a.name, a.value]), ...src.questions.flatMap((x) => [x.q, x.a])];
  return new Set(parts.flatMap(tokens));
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]/g;

/** Control del título: largo máximo y ninguna palabra que no esté en la publicación. */
export function checkTitle(text, src, max) {
  const t = String(text || '').trim();
  const known = corpus(src);
  const bare = t.replace(PLACEHOLDER, ' ');
  const unknown = [...new Set(tokens(bare).filter((w) => !STOP.has(w) && !known.has(w)))];
  return { ok: t.length > 0 && t.length <= max && !unknown.length, length: t.length, max, unknown, tooLong: t.length > max };
}

/** Números (con su unidad pegada o no) que no aparecen en la publicación: no se pueden afirmar. */
export function unknownNumbers(text, src) {
  const known = corpus(src);
  return [...new Set(tokens(String(text || '').replace(PLACEHOLDER, ' ')).filter((w) => /\d/.test(w) && !known.has(w)))];
}

/** Saca HTML, links, emails, teléfonos y redes (MeLi no los acepta en la descripción). */
const CONTACT = /\bhttps?:\/\/|\bwww\.|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(^|\s)@[A-Za-z0-9_.]{3,}|\b(whats ?app|wsp|instagram|facebook|telegram)\b|\+?\d[\d -]{7,}\d/i;
export function sanitize(text) {
  // La frase que tiene un dato de contacto se saca entera (si no, quedan restos como "Consultas al , en .").
  const kept = plain(text).split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((sent) => {
    if (!CONTACT.test(sent)) return true;
    const m = sent.match(/\+?\d[\d -]{7,}\d/);
    return m && m[0].replace(/\D/g, '').length < 8 && !CONTACT.test(sent.replace(m[0], ''));
  }).join(' ')).join('\n');
  return kept
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '')
    .replace(/(\+?\d[\d -]{7,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '' : m))
    .replace(/(^|\s)@[A-Za-z0-9_.]{3,}/g, '$1')
    .replace(/\b(whats ?app|wsp|instagram|facebook|telegram)\b/gi, '')
    .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Control de un texto de la IA: sanea y reemplaza números inventados por [DATO]. */
export function guardText(text, src) {
  let out = sanitize(text);
  const bad = unknownNumbers(out, src);
  for (const n of bad) out = out.replace(new RegExp(`(?<![\\p{L}\\d])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'giu'), '[DATO]');
  return { text: out, replaced: bad };
}

const attr = (src, ...ids) => src.attributes.find((a) => ids.includes(a.id))?.value || null;
const attrByName = (src, rx) => src.attributes.filter((a) => rx.test(a.name));
const has = (text, value) => norm(text).includes(norm(value));

/**
 * Título por reglas: producto (del título actual) + marca + modelo + atributos clave, sin repetir palabras,
 * sin mayúsculas sostenidas y cortado en palabras completas al máximo. Solo usa datos de la publicación.
 */
export function ruleTitle(src, max) {
  const words = [];
  const seen = new Set();
  const push = (w) => { const k = norm(w); if (!k || (seen.has(k) && !STOP.has(k))) return; seen.add(k); words.push(cap(w)); };
  const base = src.title.replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const head = base.slice(0, 3);
  head.forEach(push);
  const brand = attr(src, 'BRAND');
  const model = attr(src, 'MODEL');
  const brandMissing = !brand && src.missing.required.some((n) => /marca/i.test(n));
  if (brand && !has(head.join(' '), brand)) brand.split(' ').forEach(push);
  else if (brandMissing) push('[MARCA]');
  if (model && !has(head.join(' '), model)) model.split(' ').forEach(push);
  base.slice(3).forEach(push);
  for (const id of TITLE_ATTRS.slice(2)) {
    const v = attr(src, id);
    if (v && v.length <= 20 && !has(words.join(' '), v)) v.split(' ').forEach(push);
  }
  // Conectores sueltos al final no suman.
  const out = [];
  for (const w of words) { if ((out.join(' ') + ' ' + w).trim().length > max) break; out.push(w); }
  while (out.length && STOP.has(norm(out[out.length - 1]))) out.pop();
  return out.join(' ');
}

/** Descripción por reglas, en texto plano. Lo que falta queda entre corchetes. */
export function ruleDescription(src) {
  const L = [];
  const feats = src.attributes.filter((a) => !MEASURE.test(a.name) && !INCLUDES.test(a.name));
  const measures = attrByName(src, MEASURE);
  const includes = attrByName(src, INCLUDES);
  const intro = src.description ? src.description.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20).slice(0, 3) : [];
  L.push(src.title);
  L.push('');
  L.push('BENEFICIOS');
  if (intro.length) intro.forEach((s) => L.push('- ' + s));
  else L.push('- [BENEFICIO PRINCIPAL DEL PRODUCTO]');
  L.push('');
  L.push('CARACTERÍSTICAS');
  if (feats.length) feats.slice(0, 14).forEach((a) => L.push(`- ${a.name}: ${a.value}`));
  else L.push('- [CARACTERÍSTICAS DEL PRODUCTO]');
  L.push('');
  L.push('QUÉ INCLUYE');
  if (includes.length) includes.forEach((a) => L.push(`- ${a.name}: ${a.value}`));
  else L.push('- [QUÉ INCLUYE EL PAQUETE]');
  L.push('');
  L.push('MEDIDAS');
  if (measures.length) measures.forEach((a) => L.push(`- ${a.name}: ${a.value}`));
  else L.push('- [MEDIDA]');
  if (src.questions.length) {
    L.push('');
    L.push('PREGUNTAS FRECUENTES');
    for (const x of src.questions.slice(0, 5)) { L.push(`P: ${x.q}`); L.push(`R: ${x.a}`); }
  }
  return sanitize(L.join('\n'));
}

/** Atributos que faltan según la categoría: nunca se completan con IA. */
export function missingAttributes(src) {
  // Fiscales e internos (IVA, impuesto interno…) no se listan: no los ve el comprador.
  const req = src.missing.required.filter((n) => !FISCAL.test(n)).map((name) => ({ name, required: true }));
  const rec = src.missing.recommended.filter((n) => !FISCAL.test(n)).map((name) => ({ name, required: false }));
  return [...req, ...rec].map((a) => ({ ...a, hint: ATTR_HINT }));
}

/** Arma la sugerencia completa sin IA (demo, respaldo si la IA no está o falla). */
export function ruleSuggestion(src, variant = 0) {
  const rule = titleRule(src);
  let title = null;
  if (rule.allowed) {
    title = ruleTitle(src, rule.max);
    if (variant % 2 === 1) {
      // "Generar otra": misma información, otro orden (marca y modelo primero).
      const brand = attr(src, 'BRAND');
      if (brand) title = ruleTitle({ ...src, title: [brand, src.title].join(' ') }, rule.max);
    }
  }
  return finalize(src, { title, description: ruleDescription(src) }, 'reglas');
}

/** Control final común (IA o reglas): título válido o descartado, texto saneado, corchetes avisados. */
export function finalize(src, raw, source) {
  const rule = titleRule(src);
  let title = null;
  let titleNote = rule.allowed ? null : rule.message;
  if (rule.allowed && raw.title) {
    let t = String(raw.title).replace(/\s+/g, ' ').trim();
    let chk = checkTitle(t, src, rule.max);
    if (!chk.ok) { t = ruleTitle(src, rule.max); chk = checkTitle(t, src, rule.max); titleNote = 'La IA propuso palabras que no están en tu publicación: armamos el título solo con tus datos.'; }
    if (chk.ok) title = { text: t, length: t.length, max: rule.max };
  }
  const desc = raw.description ? guardText(raw.description, src) : null;
  const description = desc ? { text: desc.text, length: desc.text.length } : null;
  const brackets = /\[[^\]]+\]/.test((title?.text || '') + (description?.text || ''));
  return {
    title, titleRule: rule, titleNote,
    description,
    attributes: missingAttributes(src),
    brackets, notes: [...(brackets ? [NOTE_BRACKETS] : []), NOTE_FIXED],
    source, replacedNumbers: desc?.replaced || [],
  };
}
