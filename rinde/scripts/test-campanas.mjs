// Pruebas de los cálculos de Campañas y publicidad. Uso: node scripts/test-campanas.mjs
import { chargesAt, evaluatePromo, evaluateAds, meliContribution, summarize } from '../shared/campaigns.js';
import { getCampaignsDemo } from '../shared/campaigns-demo.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-AR');
const d = getCampaignsDemo();
const ctxOf = (it) => ({ listingType: it.listing_type, offersFreeShipping: it.offersFreeShipping, shipCost: it.shipCost, taxRate: d.taxRate, cost: it.cost });

// Umbrales: envío gratis obligatorio y cargo fijo
const a = chargesAt(34000, { listingType: 'gold_special', offersFreeShipping: false, shipCost: 7900 });
const b = chargesAt(32000, { listingType: 'gold_special', offersFreeShipping: false, shipCost: 7900 });
ok(a.shipping === 7900 && a.fixed === 0, 'Desde $33.000: envío gratis obligatorio, sin cargo fijo');
ok(b.shipping === 0 && b.fixed === 2810, 'Debajo de $33.000 (sin envío gratis propio): no paga envío, suma cargo fijo $2.810');
const c2 = chargesAt(32000, { listingType: 'gold_special', offersFreeShipping: true, shipCost: 7900 });
ok(c2.shipping === 7900 && c2.fixed === 2810, 'Debajo de $33.000 pero ofreciendo envío gratis: paga envío Y cargo fijo');
ok(chargesAt(14000, { listingType: 'gold_special' }).fixed === 1115 && chargesAt(20000, { listingType: 'gold_special' }).fixed === 2300, 'Cargo fijo por tramo: $1.115 debajo de $15.000, $2.300 debajo de $25.000');
ok(Math.round(chargesAt(20000, { listingType: 'gold_pro' }).financing) === 2300, 'Premium suma el costo de cuotas (11,5 %)');
ok(chargesAt(20000, { feeAt: () => ({ percentage: 16, fixed: 0, financing: 0 }) }).commission === 3200 && !chargesAt(20000, { feeAt: () => ({ percentage: 16, fixed: 0, financing: 0 }) }).estimated, 'Si hay tabla real de MeLi (listing_prices), se usa en vez de la estimada');

// 1) Campaña que conviene: baja de umbral y deja de pagar envío
const [o1, o2, o3, o4, o5] = d.offers;
const e1 = evaluatePromo(o1, ctxOf(o1.item));
ok(e1.verdict === 'conviene', `1) ${o1.name}: ${e1.label} (hoy ${money(e1.today.profit)} → promo ${money(e1.promo.profit)} por venta)`);
ok(e1.crossings.some((x) => /deja de ser obligatorio el envío/.test(x)), '1) Avisa que cruza el umbral de envío gratis');

// 2) Co-fondeada con boost
ok(Math.round(meliContribution(o2)) === 4950, '2) Aporte de MeLi = 15 % del precio original ($4.950)');
const e2 = evaluatePromo(o2, ctxOf(o2.item));
ok(e2.verdict === 'conviene', `2) ${o2.name}: ${e2.label} (hoy ${money(e2.today.profit)} → promo ${money(e2.promo.profit)})`);

// 3) Descuento que la baja de umbral y pierde
const e3 = evaluatePromo(o3, ctxOf(o3.item));
ok(e3.verdict === 'no_conviene' && e3.promo.profit < 0, `3) ${o3.name}: ${e3.label}`);
ok(e3.crossings.some((x) => /cargo fijo/.test(x)), '3) Avisa que se suma el cargo fijo al bajar de $33.000');

// Descuento común: conviene solo si vende más
const e4 = evaluatePromo(o4, ctxOf(o4.item));
ok(e4.verdict === 'conviene_si' && e4.moreSales > 0, `${o4.name}: ${e4.label}`);

// 5) Sin costo cargado: sin veredicto, cuenta antes del costo
const e5 = evaluatePromo(o5, ctxOf(o5.item));
ok(e5.verdict === null && e5.today.profit === null && e5.promo.beforeCost > 0 && /Cargá el costo/.test(e5.note), `5) Sin costo: sin veredicto, antes del costo ${money(e5.today.beforeCost)} → ${money(e5.promo.beforeCost)}`);

// Temporada
ok(evaluatePromo(o4, { ...ctxOf(o4.item), outOfSeason: true, seasonName: 'invierno' }).verdict === 'no_ahora', 'Fuera de temporada: "No ahora"');

// Publicidad
const [a1, a2, a3, a4] = d.ads.map((x) => evaluateAds(x, { ...ctxOf(x.item), price: x.item.price }));
ok(a1.losing && a1.acos > a1.maxAcos, `4) ${d.ads[0].item.title.slice(0, 20)}: ACOS ${Math.round(a1.acos * 100)} % > margen ${Math.round(a1.maxAcos * 100)} % → ${a1.label}`);
ok(a2.verdict === 'subir' || a2.verdict === 'ok', `Auriculares: ACOS ${Math.round(a2.acos * 100)} % vs máximo ${Math.round(a2.maxAcos * 100)} % → ${a2.label}`);
ok(['bajar', 'apagar'].includes(a3.verdict), `Cargador: ACOS ${Math.round(a3.acos * 100)} % vs máximo ${Math.round(a3.maxAcos * 100)} % → ${a3.label}`);
ok(a4.verdict === null && /Cargá el costo/.test(a4.note), 'Publicidad sin costo: sin veredicto');
const zero = evaluateAds({ cost: 5000, direct_amount: 0, indirect_amount: 0 }, { price: 20000, cost: 5000, listingType: 'gold_special' });
ok(zero.verdict === 'apagar', 'Gastó y no vendió: "Apagala"');

const s = summarize([e1, e2, e3, e4, e5], [a1, a2, a3, a4]);
ok(s.conv === 2 && s.loseP === 1 && s.loseA === 2, `Resumen: "${s.text}"`);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
