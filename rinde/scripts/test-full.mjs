// Prueba de la sugerencia Full/Flex con la cuenta de ejemplo. Uso: node scripts/test-full.mjs
import { getDemoData } from '../shared/demo-data.js';
import { shippingSuggestion, weeksToSeasonEnd } from '../shared/rules.js';

const d = getDemoData();
const base = d.items.find((i) => i.id === 'MLA1460211002'); // Soporte Celular: vende ~20 por semana, en Flex
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const NOV = new Date('2026-11-04T15:00:00Z');
const AUG = new Date('2026-08-10T15:00:00Z');

// 1) Califica para Full: venta sostenida, stock para 4+ semanas, no es Full.
const a = shippingSuggestion(base, { hasCost: false }, {}, NOV);
ok(a?.kind === 'full', `Califica: ${base.title} → ${a?.kind}`);
console.log('   ', a?.text);

// 2) De temporada que termina: producto de invierno vendiendo fuerte a mediados de agosto (quedan ~3 semanas).
const winter = { ...base, title: 'Campera Polar Mujer Abrigo Invierno', hist: { ...base.hist, weeks: [4, 5, 4, 6, 5, 4] }, available_quantity: 60 };
const b = shippingSuggestion(winter, { hasCost: false }, {}, AUG);
ok(b?.kind === 'no_full_temporada', `Temporada que termina (quedan ${weeksToSeasonEnd('invierno', AUG).toFixed(1)} semanas) → ${b?.kind}`);
console.log('   ', b?.text);

// 3) Pico de una semana: vendió 12 en una semana y nada las otras 5 → no califica.
const peak = { ...base, hist: { ...base.hist, weeks: [0, 12, 0, 0, 0, 0] } };
const c = shippingSuggestion(peak, { hasCost: false }, {}, NOV);
ok(c === null, `Pico de una semana → ${c?.kind || 'sin sugerencia'}`);

// 4) Flex: vende ~1 por semana sostenido en envío común; vendedor fuera de AMBA → no; sin dato → condicional.
const slow = { ...base, shipping: { logistic: 'drop_off', flex: false, free_shipping: true }, hist: { ...base.hist, weeks: [1, 1, 0, 1, 1, 1] }, available_quantity: 10 };
ok(shippingSuggestion(slow, {}, {}, NOV)?.kind === 'flex', 'Venta lenta sostenida en envío común → flex (condicional AMBA)');
ok(shippingSuggestion(slow, {}, { state: 'Córdoba', city: 'Córdoba' }, NOV) === null, 'Mismo caso con vendedor en Córdoba → sin sugerencia');

// 5) Ya está en Full → nada. Margen con costo cargado → muestra lo que queda por unidad.
ok(shippingSuggestion({ ...base, shipping: { logistic: 'fulfillment' } }, {}, {}, NOV) === null, 'Ya en Full → sin sugerencia');
const withCost = shippingSuggestion(base, { hasCost: true, units: 10, net: 45000 }, {}, NOV);
ok(/te quedan ~\$4\.500 por unidad/.test(withCost?.text || ''), 'Con costo cargado muestra lo que queda por unidad');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
