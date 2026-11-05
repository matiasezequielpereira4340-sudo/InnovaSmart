// Pruebas: simulador de campaña. Uso: node scripts/test-simulador.mjs
// Casos: con historial, sin historial (3 escenarios), sin costo (sin veredicto), ACOS mayor al margen.
import { simSources, scenarios, simulate, trialBudget, ASSUMED_CPC, SIM_NOTE, adReadiness, fmtSales } from '../shared/simulator.js';
import fs from 'node:fs';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const price = 24999;
// Cargos como los de listing_prices: 13,5 % + $2.300 fijo, envío $4.200 (gratis), retenciones 3,5 %.
const ctx = { listingType: 'gold_special', offersFreeShipping: true, shipCost: 4200, taxRate: 0.035, feeAt: () => ({ percentage: 13.5, fixed: 2300, financing: 0, source: 'meli' }) };
const unitCharges = price * 0.135 + 2300 + 4200 + price * 0.035;

// 1) Con historial: costo por clic y conversión de su propia publicidad
const src = simSources({ adsItem: { cost: 21000, clicks: 2310, direct_units: 14, indirect_units: 6 }, item: { visits30: 1840, sales30: 62 } });
ok(near(src.cpc.value, 21000 / 2310) && src.cpc.source === 'tu publicidad de esta publicación', `Costo por clic de su publicidad: $${src.cpc.value.toFixed(2)}`);
ok(near(src.conv.value, 20 / 2310) && /publicidad/.test(src.conv.source), `Conversión de su publicidad: ${(src.conv.value * 100).toFixed(2)} %`);
const sc = scenarios(src);
ok(sc.single && sc.list.length === 1, 'Con historial: un solo escenario "Con tus datos"');
const r = simulate({ price, budget: 3000, days: 7, cpc: sc.list[0].cpc, conv: sc.list[0].conv, ctx, cost: 9800 });
ok(r.spend === 21000 && near(r.clicks, 2310) && near(r.sales, 20) && near(r.revenue, 20 * price), `clics = gasto / costo por clic (${r.clicks.toFixed(0)}), ventas = clics × conversión (${r.sales.toFixed(1)})`);
ok(near(r.charges, 20 * unitCharges, 0.5), 'Cargos de MeLi = ventas × cargos por venta (comisión + fijo + envío + retenciones)');
ok(near(r.acos, 21000 / (20 * price)), `ACOS = gasto / facturación (${(r.acos * 100).toFixed(1)} %)`);
ok(near(r.left, r.revenue - r.charges - r.spend - 20 * 9800, 0.5), `Te queda = facturación − cargos − publicidad − costo (${Math.round(r.left)})`);
ok(near(r.maxAcos, (price - unitCharges - 9800) / price), `ACOS máximo sin perder = (precio − cargos − costo) / precio (${(r.maxAcos * 100).toFixed(1)} %)`);
ok(near(r.targetAcos, Math.floor(r.maxAcos * 0.8 * 100) / 100) && r.targetAcos < r.maxAcos, `ACOS objetivo con colchón: ${Math.round(r.targetAcos * 100)} %`);
ok(r.verdict === 'gana' && !r.acosOverMargin, 'Veredicto con costo: te deja plata');
ok(r.visits === r.clicks && !('reach' in r) && !('alcance' in r), 'Visitas estimadas = clics; no se estima alcance');

// 2) Sin historial: tres escenarios con supuestos explicados
const s0 = simSources({ item: { visits30: 5, sales30: 0 } });
const sc0 = scenarios(s0);
ok(!sc0.single && sc0.list.map((x) => x.key).join() === 'pesimista,medio,optimista', 'Sin historial: pesimista, medio y optimista');
ok(sc0.list[0].cpc === ASSUMED_CPC.pesimista && sc0.list[0].conv < sc0.list[2].conv, 'Pesimista: clic más caro y menos conversión');
ok(sc0.explain.length === 2 && sc0.explain.every((t) => /supuesto/.test(t)), 'Cada supuesto está explicado (no son datos de Mercado Libre)');
const sAvg = scenarios(simSources({ item: { visits30: 5 }, avgConv: 0.02 }));
ok(near(sAvg.list[1].conv, 0.02) && near(sAvg.list[0].conv, 0.01) && near(sAvg.list[2].conv, 0.03), 'Con promedio de la cuenta: 0,5×, 1× y 1,5× ese promedio');
ok(trialBudget(ASSUMED_CPC.medio) === Math.ceil((100 * 150 / 7) / 100) * 100, `Prueba sugerida: 7 días con $${trialBudget(ASSUMED_CPC.medio)} por día (~100 clics)`);
const sm = scenarios(s0, { cpc: 120, conv: 0.015 });
ok(sm.single && sm.list[0].cpc === 120 && sm.cpc.source === 'lo que cargaste', 'Lo que el usuario carga a mano manda');
const zero = scenarios(simSources({ item: { visits30: 80, sales30: 0 } }));
ok(!zero.single && /0 ventas/.test(zero.explain.join(' ')), 'Con visitas pero 0 ventas: escenarios y se explica por qué');

// 3) Sin costo: todo hasta "antes del costo" y sin veredicto
const nc = simulate({ price, budget: 3000, days: 7, cpc: 10, conv: 0.01, ctx, cost: null });
ok(nc.verdict === null && nc.left === null && nc.maxAcos === null && nc.targetAcos === null, 'Sin costo: no hay veredicto, ni "te queda", ni ACOS objetivo');
ok(near(nc.beforeCost, nc.revenue - nc.charges - nc.spend) && near(nc.maxAcosBeforeCost, (price - unitCharges) / price), 'Sin costo: se muestra antes del costo y el ACOS máximo antes del costo');

// 4) ACOS mayor al margen: pierde plata
const bad = simulate({ price, budget: 10000, days: 7, cpc: 40, conv: 0.005, ctx, cost: 9800 });
ok(bad.acos > bad.maxAcos && bad.acosOverMargin && bad.verdict === 'pierde' && bad.left < 0, `ACOS ${(bad.acos * 100).toFixed(0)} % > máximo ${(bad.maxAcos * 100).toFixed(0)} %: pierde plata`);
const loss = simulate({ price, budget: 1000, days: 7, cpc: 100, conv: 0.01, ctx, cost: 20000 });
ok(loss.verdict === 'pierde_sin_ads' && loss.targetAcos === null, 'Si ya pierde sin publicidad: no hay ACOS objetivo');

// 5) Sin cargos de MeLi para ese precio: no se simula el resultado
const nf = simulate({ price, budget: 1000, days: 7, cpc: 100, conv: 0.01, ctx: { feeAt: () => null }, cost: 9800 });
ok(nf.noFees && nf.verdict === undefined, 'Sin cargos de MeLi para el precio: no se simula el resultado');

// 6) ¿Conviene publicitar? Pausada o sin stock: no se simula gasto. Nota baja / 0 visitas / abandonada: primero la nota.
const imp = [{ text: 'Te falta 1 atributo: Modelo del soporte.' }, { text: 'Tenés 5 fotos, sumá 1 más.' }, { text: 'Sumá un video.' }, { text: 'Cuarta mejora.' }];
// Como el Soporte de MATYPERE: pausado, nota 70, 0 visitas, abandonado.
const soporte = adReadiness({ it: { id: 'MLA2705340112', status: 'paused', available_quantity: 3, visits30: 0 }, score: { score: 70, improvements: imp }, group: 'ABANDONADAS' });
ok(soporte.block && soporte.text === 'Está pausada: reactivala antes de hacer publicidad.', `Pausada: "${soporte.text}" (sin simular gasto)`);
ok(soporte.then && soporte.then.improvements.length === 3, 'Pausada con nota baja: igual dice qué mejorar después de reactivarla (3 mejoras)');
const sinStock = adReadiness({ it: { status: 'active', available_quantity: 0, visits30: 40 }, score: { score: 90, improvements: [] }, group: 'SIN_STOCK' });
ok(sinStock.block && /sin stock/.test(sinStock.text) && !sinStock.then, `Sin stock: "${sinStock.text}"`);
const pausadaSinStock = adReadiness({ it: { status: 'paused', available_quantity: 0, sub_status: ['out_of_stock'] }, score: { score: 90, improvements: [] }, group: 'SIN_STOCK' });
ok(pausadaSinStock.block && /pausada y sin stock/.test(pausadaSinStock.text), 'Pausada por falta de stock: lo dice');
const notaBaja = adReadiness({ it: { status: 'active', available_quantity: 5, visits30: 120 }, score: { score: 60, improvements: imp }, group: 'POCA_VISIBILIDAD' });
ok(notaBaja.first && notaBaja.text === 'Antes de pagar publicidad, subí la nota' && notaBaja.improvements.length === 3 && /60\/100/.test(notaBaja.reasons[0]), 'Nota menor a 75: primero las 3 mejoras principales');
ok(adReadiness({ it: { status: 'active', available_quantity: 5, visits30: 0 }, score: { score: 90, improvements: [] }, group: 'SIN_VENTAS' })?.first, '0 visitas en 30 días: primero la nota');
ok(adReadiness({ it: { status: 'active', available_quantity: 5, visits30: 50 }, score: { score: 90, improvements: [] }, group: 'ABANDONADAS' })?.first, 'Abandonada: primero la nota');
ok(adReadiness({ it: { status: 'active', available_quantity: 5, visits30: 50 }, score: { score: 75, improvements: [] }, group: 'SANA' }) === null, 'Activa, nota 75 o más, con visitas: simulador directo');

// 7) Ventas sin decimales
ok(fmtSales(0.3) === 'menos de 1' && fmtSales(1) === '1' && fmtSales(1.02) === '1' && fmtSales(3.9) === 'unas 4' && fmtSales(2) === '2' && fmtSales(0) === '0', 'Ventas: "menos de 1", "1", "unas 4" (nunca 0,3 ni 3,9)');

// Textos
const app = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
ok(app.includes('SIM_NOTE') && /simulación con tus números/.test(SIM_NOTE), 'Aclaración fija del simulador en la pantalla');
const simUi = app.slice(app.indexOf('// ─── Simulador'), app.indexOf('// ─── Fin simulador'));
ok(simUi.length > 100 && !/alcance|personas alcanzadas|vas a llegar/i.test(simUi), 'La pantalla del simulador no muestra alcance');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
