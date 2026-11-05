// Pruebas: sugerencias para copiar (título y descripción). Uso: node scripts/test-sugerencias.mjs
// - El título nunca pasa el máximo de su categoría.
// - No aparece ninguna palabra (título) ni número (descripción) que no esté en la publicación.
// - Con ventas (o en catálogo) no se sugiere título.
// - Lo que falta queda entre corchetes y se avisa. Sin HTML, links ni datos de contacto.
// - Límites: Plan Rinde 30 por día; plan gratis 1 publicación.
import fs from 'node:fs';
import { sourceOf, titleRule, ruleSuggestion, finalize, checkTitle, unknownNumbers, corpus, sanitize, TITLE_LOCKED_SALES, TITLE_LOCKED_CATALOG, NOTE_BRACKETS, NOTE_FIXED } from '../shared/suggest.js';
import { getDemoData } from '../shared/demo-data.js';
import { usageOf, startOfDayAR } from '../api/_lib/item.js';
import { saleRows, searchItems } from '../shared/item-detail.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const d = getDemoData();
const src = (id, extra = {}) => sourceOf({ item: { ...d.items.find((i) => i.id === id), ...extra }, ...(d.sources[id] || {}) });

// ── Casos del demo ──
const sinVentas = src('MLA1460211014');
const s1 = ruleSuggestion(sinVentas);
ok(titleRule(sinVentas).allowed && s1.title, `Sin ventas: sugiere título ("${s1.title?.text}")`);
ok(s1.title.length <= s1.title.max, `Título dentro del máximo (${s1.title.length}/${s1.title.max})`);
ok(checkTitle(s1.title.text, sinVentas, s1.title.max).unknown.length === 0, 'Título sin palabras que no estén en la publicación');
ok(/AquaPura/.test(s1.title.text) && /AP-Maxi/.test(s1.title.text), 'Título con marca y modelo de los atributos');

const conVentas = src('MLA1460211001');
const s2 = ruleSuggestion(conVentas);
ok(!s2.title && s2.titleNote === TITLE_LOCKED_SALES, 'Con ventas: no sugiere título y muestra el aviso de Mercado Libre');
ok(!!s2.description, 'Con ventas: igual sugiere descripción');

const faltan = src('MLA1460211015');
const s3 = ruleSuggestion(faltan);
ok(/\[MEDIDA\]/.test(s3.description.text) && s3.brackets && s3.notes.includes(NOTE_BRACKETS), 'Datos faltantes: deja [MEDIDA] y avisa "Completá lo que está entre corchetes"');
ok(s3.attributes.some((a) => a.name === 'Marca' && a.required && /dato real/.test(a.hint)), 'Atributos faltantes listados con "Completá con el dato real del producto" (no se completan)');
ok(s3.notes.includes(NOTE_FIXED), 'Aclaración fija "Revisalo antes de pegarlo…"');

// ── Todas las publicaciones del demo, forzando "sin ventas" para probar el título ──
let worst = 0;
for (const it of d.items) {
  const sc = sourceOf({ item: { ...it, sold_quantity: 0, sales180: 0, catalog_listing: false }, ...(d.sources[it.id] || {}) });
  for (const v of [0, 1]) {
    const r = ruleSuggestion(sc, v);
    const chk = checkTitle(r.title.text, sc, r.title.max);
    if (!chk.ok) { ok(false, `${it.id} v${v}: ${r.title.text} (${chk.length}/${chk.max}) ${chk.unknown}`); worst++; }
    const nums = unknownNumbers(r.description.text, sc);
    if (nums.length) { ok(false, `${it.id}: números inventados en la descripción: ${nums}`); worst++; }
  }
}
ok(!worst, `Las ${d.items.length} publicaciones del demo: títulos ≤ máximo y sin datos ajenos (2 variantes cada una)`);
// Máximo chico: igual respeta el largo
const corto = { ...sinVentas, title_max: 30 };
const rc = ruleSuggestion(corto);
ok(rc.title.length <= 30, `Con máximo de 30 caracteres: "${rc.title.text}" (${rc.title.length})`);

// ── La IA inventa: el control lo corrige ──
const ia = finalize(sinVentas, {
  title: 'Filtro Brita Original Samsung Garantía 12 Meses Premium Envío Gratis',
  description: '<b>Filtro</b> original con garantía de 12 meses. Medidas 30x40 cm. Dura 4 semanas. Consultas al 11 5555-4444 o ventas@tienda.com, www.mitienda.com.ar, @mitienda en Instagram.',
}, 'ia');
ok(ia.title && checkTitle(ia.title.text, sinVentas, ia.title.max).ok && !/samsung|garant|gratis/i.test(ia.title.text), `Título de IA con palabras ajenas: se reemplaza por uno armado con los datos ("${ia.title.text}")`);
ok(!/12|30x40/.test(ia.description.text) && /\[DATO\]/.test(ia.description.text) && /4 semanas/.test(ia.description.text), 'Números inventados por la IA → [DATO]; los reales (4 semanas) quedan');
ok(!/<|www\.|https?:|@|5555|ventas@|instagram/i.test(ia.description.text), `Sin HTML, links, teléfonos, emails ni redes: "${ia.description.text}"`);
ok(ia.brackets && ia.notes.includes(NOTE_BRACKETS), 'Si quedó [DATO], se avisa que hay que completar los corchetes');
ok(sanitize('Medidas: 30 x 40\n- Peso: 2 kg') === 'Medidas: 30 x 40\n- Peso: 2 kg', 'El saneado no confunde medidas con teléfonos');

// ── Publicaciones guardadas de MATYPERE (4, sin ventas en 6 meses; 3 en catálogo) ──
const MATYPERE = [{"id": "MLA1654121789", "title": "Aspiradora Portátil Razurii As-228 De 100 Ml, Para Hogar, Oficina Y Coche Negro", "price": 13950, "status": "active", "catalog_listing": true, "title_max": 60, "sales180": 0, "sales90": 0, "sales30": 0, "visits30": 0, "desc_len": 0, "attrs": {"rec_total": 24, "req_total": 3, "rec_missing": ["Tipos de colector", "Presión máxima de vapor", "Número de certificado de seguridad eléctrica", "Organismo de certificación (OCP)", "Etiqueta de eficiencia energética", "Eficiencia energética", "IVA", "Impuesto interno"], "req_missing": []}}, {"id": "MLA2370754886", "title": "Foco Led Tuya Smart Wifi Rgb E27 15w Compatible Alexa Google Home Lámparas Rgbw+ww", "price": 14744.33, "status": "paused", "catalog_listing": true, "title_max": 60, "sales180": 0, "sales90": 0, "sales30": 0, "visits30": 0, "desc_len": 274, "attrs": {"rec_total": 18, "req_total": 6, "rec_missing": ["Voltaje", "Formato de venta", "Cantidad de lámparas", "IVA", "Impuesto interno"], "req_missing": []}}, {"id": "MLA2705340112", "title": "Orta Celular Magnético Fuerte Para Auto  Soporte 360  Tipo", "price": 16990, "status": "paused", "catalog_listing": false, "title_max": 60, "sales180": 0, "sales90": 0, "sales30": 0, "visits30": 0, "desc_len": 788, "attrs": {"rec_total": 15, "req_total": 3, "rec_missing": ["Línea del soporte", "Color", "Modelos de celulares y GPS compatibles", "IVA", "Impuesto interno"], "req_missing": ["Modelo del soporte"]}}, {"id": "MLA2864508298", "title": "Trimmer Afeitadora Recortadora Barba Portátil Usb 0.5mm A 4mm Color Dorado Oscuro", "price": 10000, "status": "active", "catalog_listing": true, "title_max": 60, "sales180": 0, "sales90": 0, "sales30": 0, "visits30": 1, "desc_len": 1269, "attrs": {"rec_total": 21, "req_total": 2, "rec_missing": ["Voltaje de la batería", "Tipo de pila", "IVA", "Impuesto interno"], "req_missing": []}}];
for (const it of MATYPERE) {
  const sc = sourceOf({ item: it });
  const r = ruleSuggestion(sc);
  if (it.catalog_listing) ok(!r.title && r.titleNote === TITLE_LOCKED_CATALOG, `MATYPERE ${it.id}: en catálogo, no sugiere título`);
  else {
    ok(r.title && r.title.length <= r.title.max && checkTitle(r.title.text, sc, r.title.max).ok, `MATYPERE ${it.id}: título "${r.title?.text}" (${r.title?.length}/${r.title?.max}) sin palabras ajenas`);
    ok(!/\s{2}/.test(r.title.text), 'Sin espacios dobles (el título original tenía)');
  }
  ok(unknownNumbers(r.description.text, sc).length === 0, `MATYPERE ${it.id}: descripción sin números ajenos`);
  ok(!r.attributes.some((a) => /dato real/.test(a.hint) && /^(IVA|Impuesto interno)$/.test(a.name)), `MATYPERE ${it.id}: IVA/Impuesto interno marcados como dato fiscal, no del producto`);
}
// Con ventas confirmadas por Mercado Libre (sold_quantity) aunque no haya ventas en 6 meses: no hay título.
ok(!titleRule(sourceOf({ item: { ...MATYPERE[2], sold_quantity: 3 } })).allowed, 'sold_quantity > 0 (ventas viejas): Mercado Libre no deja cambiar el título');

// ── Límites ──
const now = Date.parse('2026-11-05T15:00:00Z');
const hoy = (n, item = 'MLA1') => Array.from({ length: n }, () => ({ item_id: item, created_at: new Date(now - 3600e3).toISOString() }));
ok(usageOf(hoy(29), { paid: true, itemId: 'MLA1', now }).allowed && !usageOf(hoy(30), { paid: true, itemId: 'MLA1', now }).allowed, 'Plan Rinde: hasta 30 por día');
ok(usageOf([{ item_id: 'MLA1', created_at: new Date(now - 30 * 3600e3).toISOString() }, ...hoy(29)], { paid: true, itemId: 'MLA1', now }).allowed, 'Las de ayer no cuentan para hoy');
ok(usageOf([], { paid: false, itemId: 'MLA1', now }).allowed, 'Plan gratis: la primera publicación se puede probar');
ok(!usageOf(hoy(1, 'MLA1'), { paid: false, itemId: 'MLA2', now }).allowed, 'Plan gratis: otra publicación → "Disponible en Plan Rinde"');
ok(startOfDayAR(Date.parse('2026-11-05T02:00:00Z')) === Date.parse('2026-11-04T03:00:00Z'), 'El día se cuenta en hora argentina');

// ── Desglose por venta y buscador ──
const lines = d.lines90.filter((l) => l.item_id === 'MLA1460211001');
const sr = saleRows(lines, { cost: d.costs['RND-001'], adsPerUnit: 500 });
ok(sr.units === d.items[0].sales90 && sr.rows.every((r) => Math.abs(r.price - r.commission - r.fixed - r.financing - r.shipping - r.taxes - r.other - r.ads - r.cost - r.left) < 0.01), `Desglose: ${sr.units} ventas en 90 días y "Te quedó" cierra en cada una`);
const rows = d.items.map((it) => ({ it }));
ok(searchItems(rows, '1460211022')[0]?.it.id === 'MLA1460211022' && searchItems(rows, 'MLA1460211022')[0]?.it.id === 'MLA1460211022', 'Buscador por número MLA (con o sin "MLA")');
ok(searchItems(rows, 'lampara escritorio')[0]?.it.id === 'MLA1460211003', 'Buscador por título sin acentos');

// ── Textos ──
for (const f of ['../assets/app.js', '../shared/suggest.js']) ok(!/sin dato/.test(fs.readFileSync(new URL(f, import.meta.url), 'utf8')), `${f.split('/').pop()} no muestra "sin dato"`);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
