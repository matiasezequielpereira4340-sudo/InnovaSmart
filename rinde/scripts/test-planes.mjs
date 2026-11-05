// Pruebas: planes de IA filtrados contra la nota y "sin dato" fuera de la pantalla. Uso: node scripts/test-planes.mjs
import fs from 'node:fs';
import { guardPlan, scoreAllows, conflictOf } from '../shared/plan-guard.js';
import { listingScore } from '../shared/score.js';
import { buildRulePlan, classify } from '../shared/rules.js';
import { buildModel } from '../shared/model.js';
import { getDemoData } from '../shared/demo-data.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// Publicación como la del Trimmer de MATYPERE: título de 81 caracteres, la API dice "máximo 60".
const trimmer = { id: 'MLA2864508298', title: 'Cortadora De Pelo Trimmer Recargable Inalambrica Profesional Barba Patillas Cuerpo', title_max: 60,
  price: 10000, listing_type: 'gold_special', status: 'active', available_quantity: 11, pictures_count: 3, visits30: 1, sales30: 0, sales90: 0, sales180: 0,
  shipping: { free_shipping: false }, video: false, desc_len: 500 };
const sc = listingScore(trimmer, {});
ok(!sc.criteria.some((c) => c.fix && /recort/i.test(c.fix)), 'La nota nunca pide recortar un título publicado (aunque la API diga máximo 60)');
ok(sc.criteria.find((c) => c.key === 'titulo').value === 1, 'Título de 81 caracteres: puntaje completo');

// Plan de IA REAL guardado para el Trimmer (con "Recortá el título" y "Evaluá envío Full o Flex")
const iaPlan = { source: 'ia', verdict: 'mejorar', headline: 'Con 1 visita y 0 ventas en 30 días: recortá el título y sumá fotos y video.', actions: [
  { title: 'Recortá el título a 60 caracteres', detail: 'El título tiene 81 caracteres y la categoría acepta 60: recortalo para que no se corte.', impact: 'alto' },
  { title: 'Sumá fotos', detail: 'Tenés 3 fotos, sumá 3 más: en uso, detalle y medidas.', impact: 'alto' },
  { title: 'Sumá video corto', detail: 'Sumá un video o clip corto mostrando el producto en uso.', impact: 'medio' },
  { title: 'Evaluá envío Full o Flex', detail: 'Hoy no usás Full ni Flex y competís contra envíos más rápidos; considerá activarlo.', impact: 'medio' },
] };
const cls = classify(trimmer, { hasCost: false }, {});
const rule = buildRulePlan(trimmer, cls, { hasCost: false }, sc);
const g = guardPlan(iaPlan, sc, rule, { ship: null });
const all = (p) => [p.headline, ...p.actions.map((a) => a.title + ' ' + a.detail)].join(' | ');
ok(!/recort/i.test(all(g)), `Sin "recortá el título" (titular: "${g.headline}")`);
ok(!/\b(full|flex)\b/i.test(all(g)), 'Sin Full/Flex: no hay venta sostenida');
ok(g.actions.some((a) => a.title === 'Sumá fotos') && g.actions.some((a) => /video/i.test(a.title)), 'Se mantienen las acciones de la IA que coinciden con la nota (fotos, video)');
ok(g.guarded >= 2 && new Set(g.actions.map((a) => /foto/i.test(a.title) ? 'f' : /video/i.test(a.title) ? 'v' : a.title)).size === g.actions.length, `Se sacan las que contradicen y no se repiten temas (${g.actions.map((a) => a.title).join(' / ')})`);
ok(!/premium|env[ií]o gratis|recort|\bfull\b|\bflex\b/i.test(all(rule)), `El plan de reglas tampoco contradice la nota: ${rule.actions.map((a) => a.title).join(' / ')}`);

// Premium / envío gratis: solo si la nota lo recomienda
const cheap = { ...trimmer, price: 20000 };
ok(!scoreAllows(listingScore(cheap, {})).premium, 'Debajo de $50.000 la nota no recomienda Premium');
ok(conflictOf({ title: 'Pasala a Premium', detail: 'más exposición' }, scoreAllows(listingScore(cheap, {}))) === 'pasar a Premium', 'IA que sugiere Premium a $20.000: se saca');
const exp = { ...trimmer, price: 90000 };
ok(scoreAllows(listingScore(exp, {})).premium && !conflictOf({ title: 'Probá Premium' }, scoreAllows(listingScore(exp, {}))), 'Desde $50.000 Clásica: la nota recomienda Premium y se deja');
ok(conflictOf({ title: 'Ofrecé envío gratis' }, scoreAllows(listingScore(cheap, { shipCost: 9000 }))) === 'envío gratis', 'Envío que pesa más del 20 %: no se sugiere envío gratis');
ok(!conflictOf({ title: 'Ofrecé envío gratis' }, scoreAllows(listingScore(cheap, { shipCost: 2000 }))), 'Envío que pesa menos del 20 %: sí');
ok(!conflictOf({ title: 'Bajá el precio', detail: 'reducí el precio un 5 % y sumá una palabra clave al título' }, { trim: false, premium: false, freeShip: false, fullFlex: false }), 'No confunde "reducí el precio… título" con recortar el título');

// En el modelo, los planes guardados se filtran al leerlos (no hace falta esperar a regenerar)
const d = getDemoData();
const it0 = d.items[0];
const m = buildModel({ ...d, plans: { [it0.id]: { ...iaPlan } } });
ok(!/recort/i.test(all(m.rows.find((r) => r.it.id === it0.id).plan)), 'Plan guardado con "recortá el título": se filtra al armar el diagnóstico');

// "sin dato" nunca en pantalla
const app = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
ok(!/sin dato/.test(app), 'La app no muestra "sin dato" en ningún lado');
ok(/conv != null && \(it\.visits30 \|\| 0\) >= MIN_VISITS_CONV/.test(app), 'Conversión solo con visitas suficientes (30 o más)');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
