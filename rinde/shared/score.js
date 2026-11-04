// Rinde — Nota de publicación (0 a 100), propia, solo con datos que Mercado Libre sí nos da.
// Regla: ninguna mejora puede empeorar el margen sin decir cuánto cuesta. Premium y envío gratis
// solo cuentan cuando tienen sentido (precio alto / envío barato) y siempre con el costo a la vista.
import { THRESHOLDS as T } from './config.js';
// Cada criterio tiene un peso. Si un dato no se pudo leer, ese criterio no cuenta y su peso se reparte entre los demás.
// Nunca se muestra "sin dato": se explica con lo que hay.

export const SCORE_WEIGHTS = {
  atributos: 25,   // atributos completos contra los que pide la categoría
  fotos: 15,       // cantidad (mínimo 6) y resolución
  titulo: 15,      // no muy corto ni más largo que lo que acepta la categoría; sin palabras repetidas ni mayúsculas
  descripcion: 10, // tiene descripción y es completa
  video: 5,        // tiene video o clip
  tipo: 10,        // gratuita resta; Clásica vs Premium solo en precios altos (con costo)
  envio: 8,        // envío gratis solo debajo del mínimo y si cuesta menos del 20 % (con costo)
  preguntas: 7,    // preguntas sin responder
  conversion: 5,   // conversión contra el promedio de su propia cuenta (con visitas suficientes)
};

export const SCORE_LABELS = {
  atributos: 'Atributos', fotos: 'Fotos', titulo: 'Título', descripcion: 'Descripción', video: 'Video',
  tipo: 'Tipo de publicación', envio: 'Envío gratis', preguntas: 'Preguntas', conversion: 'Conversión',
};

const MIN_PHOTOS = 6;
const SMALL_PX = 500;          // lado menor por debajo de esto = foto chica
const MIN_VISITS_CONV = 30;    // visitas mínimas para comparar conversión
const pct = (n) => (n * 100).toFixed(1).replace('.', ',') + ' %';
const clamp = (x) => Math.max(0, Math.min(1, x));
const list = (arr, n = 5) => (arr.length > n ? `${arr.slice(0, n).join(', ')} y ${arr.length - n} más` : arr.join(', '));

export const scoreTone = (n) => (n == null ? 'neutral' : n < 50 ? 'bad' : n <= 75 ? 'warn' : 'ok');

/** Conversión promedio de la cuenta (ventas/visitas 30 días) entre publicaciones con visitas suficientes. */
export function accountConversion(items) {
  let v = 0, s = 0;
  for (const it of items) if ((it.visits30 || 0) >= MIN_VISITS_CONV) { v += it.visits30; s += it.sales30 || 0; }
  return v > 0 ? s / v : null;
}

function titleCheck(title, max) {
  const t = String(title || '').trim();
  const len = t.length;
  const words = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9ñ]+/).filter((w) => w.length > 2);
  const seen = {}; const repeated = [];
  for (const w of words) { seen[w] = (seen[w] || 0) + 1; if (seen[w] === 2) repeated.push(w); }
  const caps = t.split(/\s+/).filter((w) => w.length > 3 && /[A-ZÁÉÍÓÚÑ]/.test(w) && w === w.toUpperCase() && !/\d/.test(w));
  // Largo: nunca se penaliza un título que Mercado Libre acepta. Solo si pasa el máximo de la categoría
  // o si es muy corto (menos de 40 caracteres: le faltan palabras clave).
  const over = max && len > max;
  let s = over ? 0.3 : len >= 40 ? 1 : Math.max(0, Math.min(1, (len - 15) / 25));
  if (repeated.length) s -= 0.25;
  if (caps.length >= 2) s -= 0.25;
  return { score: clamp(s), len, repeated, caps, over, max };
}

/**
 * @param it publicación normalizada (puede traer it.attrs, it.pics, it.desc_len, it.video)
 * @param ctx { avgConv }
 * @returns { score, tone, criteria: [{key,label,weight,value,note}], improvements: [texto] (las 3 que más suben la nota) }
 */
export function listingScore(it, ctx = {}) {
  const c = {}; // key -> { value 0..1, fix: texto o null, note }

  // a) Atributos
  const a = it.attrs;
  if (a && (a.req_total || a.rec_total)) {
    const totalW = (a.req_total || 0) * 2 + (a.rec_total || 0);
    const missW = (a.req_missing?.length || 0) * 2 + (a.rec_missing?.length || 0);
    const missing = [...(a.req_missing || []), ...(a.rec_missing || [])];
    c.atributos = {
      value: totalW ? clamp(1 - missW / totalW) : 1,
      note: missing.length ? `Faltan ${missing.length} de ${(a.req_total || 0) + (a.rec_total || 0)}` : 'Completos',
      fix: missing.length ? `Te faltan ${missing.length} atributo${missing.length > 1 ? 's' : ''}: ${list(missing)}.` : null,
    };
  }

  // b) Fotos
  const n = it.pictures_count;
  if (n != null) {
    const qty = clamp(n / MIN_PHOTOS);
    const sizes = Array.isArray(it.pics) ? it.pics.filter((x) => x > 0) : null;
    const small = sizes ? sizes.filter((x) => x < SMALL_PX).length : 0;
    const res = sizes && sizes.length ? 1 - small / sizes.length : null;
    const value = res == null ? qty : qty * 0.7 + res * 0.3;
    let fix = null;
    if (n < MIN_PHOTOS) {
      const ideas = ['en uso', 'detalle', 'medidas', 'fondo blanco', 'empaque', 'variantes'].slice(0, MIN_PHOTOS - n);
      fix = `Tenés ${n} foto${n === 1 ? '' : 's'}, sumá ${MIN_PHOTOS - n} más: ${ideas.join(', ').replace(/, ([^,]*)$/, ' y $1')}.`;
    } else if (small) fix = `${small} foto${small > 1 ? 's son' : ' es'} chica${small > 1 ? 's' : ''} (menos de ${SMALL_PX} px): subilas en 1200 px o más.`;
    c.fotos = { value, note: `${n} foto${n === 1 ? '' : 's'}${small ? `, ${small} chica${small > 1 ? 's' : ''}` : ''}`, fix };
  }

  // c) Título (el máximo lo da la categoría: hoy muchas aceptan más de 60)
  if (it.title) {
    const t = titleCheck(it.title, it.title_max);
    let fix = null;
    if (t.over) fix = `El título tiene ${t.len} caracteres y la categoría acepta ${t.max}: recortalo para que no se corte.`;
    else if (t.len < 40) fix = `El título tiene ${t.len} caracteres: sumale producto, marca, modelo y un atributo clave${t.max ? ` (la categoría acepta hasta ${t.max})` : ''}.`;
    else if (t.repeated.length) fix = `Repetís "${t.repeated.slice(0, 2).join('", "')}" en el título: usá ese espacio para otra palabra clave.`;
    else if (t.caps.length >= 2) fix = `Sacá las mayúsculas del título (${t.caps.slice(0, 3).join(', ')}).`;
    c.titulo = { value: t.score, note: `${t.len} caracteres${t.max ? ` de ${t.max}` : ''}`, fix };
  }

  // d) Descripción
  if (it.desc_len != null) {
    const d = it.desc_len;
    c.descripcion = {
      value: d === 0 ? 0 : d < 300 ? 0.5 : 1,
      note: d === 0 ? 'No tiene' : `${d} caracteres`,
      fix: d === 0 ? 'No tiene descripción: escribí 3 a 5 párrafos con medidas, materiales, qué incluye y cómo se usa.'
        : d < 300 ? `La descripción es corta (${d} caracteres): sumá medidas, materiales, qué incluye y cuidados.` : null,
    };
  }

  // e) Video / clip
  if (it.video != null) c.video = { value: it.video ? 1 : 0, note: it.video ? 'Tiene' : 'No tiene', fix: it.video ? null : 'Sumá un video o clip corto mostrando el producto en uso.' };

  // f) Tipo de publicación. Gratuita siempre resta (casi no aparece). Clásica vs Premium solo cuenta
  //    si el precio es alto (ahí las cuotas pesan), y la sugerencia dice cuánto cuesta.
  if (it.listing_type === 'free') {
    c.tipo = { value: 0, note: 'Gratuita', fix: 'Es gratuita: pasala a Clásica (sin costo extra de cuotas) para que aparezca en las búsquedas.' };
  } else if (it.listing_type && (it.price || 0) >= T.PREMIUM_MIN_PRICE) {
    const premium = it.listing_type === 'gold_pro';
    const extra = Math.round((it.price || 0) * T.PREMIUM_EXTRA_RATE);
    c.tipo = { value: premium ? 1 : 0.5, note: premium ? 'Premium' : 'Clásica',
      fix: premium ? null : `Es Clásica y vale $${Math.round(it.price).toLocaleString('es-AR')}: en precios altos las cuotas sin interés pesan. Premium te cuesta ~$${extra.toLocaleString('es-AR')} más por venta (estimado ${Math.round(T.PREMIUM_EXTRA_RATE * 100)} %): probalo solo si el margen lo banca.` };
  }

  // g) Envío gratis. Desde el mínimo MeLi lo obliga (no se mide). Debajo, solo se sugiere si el envío
  //    cuesta poco (menos del 20 % del precio) y se dice cuánto cuesta; si no, no se mide.
  if (it.shipping && typeof it.shipping.free_shipping === 'boolean' && (it.price || 0) < T.FREE_SHIPPING_MIN_PRICE && ctx.shipCost != null && it.price) {
    const share = ctx.shipCost / it.price;
    if (it.shipping.free_shipping || share < T.FREE_SHIPPING_MAX_SHARE) {
      c.envio = { value: it.shipping.free_shipping ? 1 : 0, note: it.shipping.free_shipping ? 'Sí' : 'No',
        fix: it.shipping.free_shipping ? null : `Ofrecé envío gratis: te cuesta ~$${Math.round(ctx.shipCost).toLocaleString('es-AR')} por venta (${pct(share)} del precio) y pesa en el ranking.` };
    }
  }

  // h) Preguntas sin responder
  if (it.questions_unanswered != null) {
    const q = it.questions_unanswered;
    c.preguntas = { value: clamp(1 - q / 3), note: q ? `${q} sin responder` : 'Al día', fix: q ? `Respondé ${q === 1 ? 'la pregunta pendiente' : `las ${q} preguntas pendientes`}: cada una es una venta que se puede ir.` : null };
  }

  // i) Conversión vs promedio de la cuenta (solo con visitas suficientes)
  if (ctx.avgConv && (it.visits30 || 0) >= MIN_VISITS_CONV) {
    const conv = (it.sales30 || 0) / it.visits30;
    c.conversion = { value: clamp(conv / ctx.avgConv), note: `${pct(conv)} vs ${pct(ctx.avgConv)} de tu cuenta`,
      fix: conv < ctx.avgConv ? `Convierte ${pct(conv)} contra ${pct(ctx.avgConv)} de tu cuenta: revisá primera foto, fotos y descripción (si bajás el precio, mirá antes el margen en Rentabilidad).` : null };
  }

  // Peso repartido entre los criterios que se pudieron medir.
  const keys = Object.keys(c);
  const wSum = keys.reduce((s, k) => s + SCORE_WEIGHTS[k], 0);
  const criteria = keys.map((k) => ({ key: k, label: SCORE_LABELS[k], weight: wSum ? (SCORE_WEIGHTS[k] / wSum) * 100 : 0, value: c[k].value, note: c[k].note, fix: c[k].fix }));
  const score = wSum ? Math.round(criteria.reduce((s, x) => s + x.weight * x.value, 0)) : null;
  const improvements = criteria
    .filter((x) => x.fix)
    .map((x) => ({ text: x.fix, gain: Math.round(x.weight * (1 - x.value)), key: x.key }))
    .filter((x) => x.gain > 0)
    .sort((x, y) => y.gain - x.gain)
    .slice(0, 3);
  return { score, tone: scoreTone(score), criteria, improvements };
}
