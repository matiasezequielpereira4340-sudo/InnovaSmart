// Pruebas de los cálculos de Campañas y publicidad. Uso: node scripts/test-campanas.mjs
import { chargesAt, evaluatePromo, evaluateAds, meliContribution, summarize, feeFromHistory, feeKey } from '../shared/campaigns.js';
import { getCampaignsDemo } from '../shared/campaigns-demo.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-AR');
const d = getCampaignsDemo();
const ctxOf = (it) => ({ listingType: it.listing_type, offersFreeShipping: it.offersFreeShipping, shipCost: it.shipCost, taxRate: d.taxRate, cost: it.cost, feeAt: (p) => d.fees[feeKey(it.listing_type, it.category_id, p)] || null });

const lp = (percentage, fixed = 0, financingPct = 0) => (price) => ({ percentage, fixed, financing: price * financingPct, source: 'meli' });
// Sin tabla inventada: si no hay cargo de MeLi ni historial, no se calcula
ok(chargesAt(20000, { listingType: 'gold_special' }) === null, 'Sin listing_prices ni historial: no se calculan cargos (no hay tabla inventada)');
// Umbrales de envío gratis con cargos reales
const a = chargesAt(34000, { feeAt: lp(13.5), offersFreeShipping: false, shipCost: 7900 });
const b = chargesAt(32000, { feeAt: lp(13.5, 2810), offersFreeShipping: false, shipCost: 7900 });
ok(a.shipping === 7900 && a.fixed === 0, 'Desde $33.000: envío gratis obligatorio');
ok(b.shipping === 0 && b.fixed === 2810, 'Debajo de $33.000 (sin envío gratis propio): no paga envío; el cargo fijo es el que da MeLi');
ok(chargesAt(32000, { feeAt: lp(13.5, 2810), offersFreeShipping: true, shipCost: 7900 }).shipping === 7900, 'Debajo de $33.000 ofreciendo envío gratis: lo sigue pagando');
ok(Math.round(chargesAt(20000, { feeAt: () => ({ percentage: 14.5, fixed: 2300, financing: 0, total: 5200, source: 'meli' }) }).commission) === 2900, 'Si MeLi da el total del cargo (sale_fee_amount), manda ese número');

// Cargos REALES de MYVALENTINEIMP (facturación guardada): el historial de cada publicación reproduce lo facturado
const real = [
  { price: 57000, commission: 6121.7, fixed: 0, pct: '10,7 %' },
  { price: 60000, commission: 8400, fixed: 0, pct: '14 %' },
  { price: 47990, commission: 7438.45, fixed: 0, pct: '15,5 %' },
  { price: 22000, commission: 5990, fixed: 2800, pct: '14,5 % + $2.800' },
];
for (const r of real) {
  const h = { price: r.price, pct: (r.commission - r.fixed) / r.price, fixed: r.fixed, financingPct: 0 };
  const c = chargesAt(r.price, { feeAt: (p) => feeFromHistory(h, p) });
  ok(Math.abs(c.commission + c.fixed - r.commission) < 1, `Real ${money(r.price)}: ${r.pct} → cargo ${money(c.commission + c.fixed)} (facturado ${money(r.commission)})`);
}
const h22 = { price: 22000, pct: 3190 / 22000, fixed: 2800, financingPct: 0 };
ok(feeFromHistory(h22, 20500) !== null && feeFromHistory(h22, 15000) === null, 'Historial con cargo fijo: sirve a ±10 % del precio; más lejos no (el cargo fijo cambia por tramo)');
ok(feeFromHistory({ price: 47990, pct: 0.155, fixed: 0 }, 30000) === null, 'Historial no sirve si el precio nuevo cruza el mínimo de envío gratis');
const ctxNo = { feeAt: () => null, cost: 1000 };
const nf = evaluatePromo({ name: 'x', price_today: 30000, promo_price: 27000 }, ctxNo);
ok(nf.verdict === null && nf.noFees && /No pudimos calcular los cargos de MeLi para este precio/.test(nf.note), 'Sin cargos: "No pudimos calcular los cargos de MeLi para este precio", sin veredicto');

// 1) Campaña que conviene: baja de umbral y deja de pagar envío
const [o1, o2, o3, o4, o5, o6] = d.offers;
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

const e6 = evaluatePromo(o6, ctxOf(o6.item));
ok(e6.noFees && e6.verdict === null, `Oferta sin tabla de cargos: ${e6.note}`);

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

const nm = evaluateAds({ cost: 9000, total_amount: 60000 }, { price: 30000, cost: 10000, feeAt: lp(13.5, 2810) });
ok(nm.acos === 0.15 && nm.verdict != null, `Publicidad sin directas/indirectas separadas: usa ventas totales (ACOS ${Math.round(nm.acos * 100)} %)`);
const { normMetrics } = await import('../api/_lib/campaigns-meli.js');
ok(normMetrics({ item_id: 'x' }) === null && normMetrics({ cost: 100, clicks: 3 }).missing.includes('total_amount'), 'Métricas: si MeLi no las manda queda null (no cero) y se lista cuáles faltan');

const s = summarize([e1, e2, e3, e4, e5], [a1, a2, a3, a4]);
ok(s.conv === 2 && s.loseP === 1 && s.loseA === 2, `Resumen: "${s.text}"`);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
