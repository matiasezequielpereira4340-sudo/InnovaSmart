// Pruebas: 1) cuenta sin ventas no es "sana", 2) publicidad sin gasto agrupada, 3) plan leído del servidor.
// Uso: node scripts/test-sin-ventas-y-plan.mjs
import { getDemoData } from '../shared/demo-data.js';
import { buildModel, buildRuleSummary, sellingState } from '../shared/model.js';
import { splitIdle, isIdleAds, campaignStateText, evaluateAll } from '../shared/campaigns.js';
import { regenState, planChanged } from '../shared/plans.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// ── 1) Cuenta como MATYPERE: 4 publicaciones, 0 ventas en 6 meses, $0 en 30 días ──
const d = getDemoData();
const items = d.items.slice(0, 4).map((it, k) => ({ ...it, status: k % 2 ? 'paused' : 'active', available_quantity: k === 3 ? 0 : 10,
  sales30: 0, sales90: 0, sales180: 0, revenue180: 0, visits30: k === 0 ? 1 : 0, hist: undefined }));
const data = { ...d, items, lines: [], revenue: { ...d.revenue, d30: 0, d90: 0, d180: 0, months: {} } };
const m = buildModel(data);
const sum = buildRuleSummary(m);
ok(sellingState(m).state === 'no_vende', 'Sin ventas en 6 meses: estado "no vende"');
ok(!/sana/i.test(sum.headline) && /no está vendiendo: 4 publicaciones sin ventas en 6 meses/.test(sum.headline), `Titular: "${sum.headline}"`);
ok(sum.revenueNote === 'Sin ventas en los últimos 6 meses', `Nota de facturación: "${sum.revenueNote}"`);
ok(sellingState(buildModel({ ...data, revenue: { ...data.revenue, d30: 50000 } })).state !== 'no_vende', 'Si la facturación muestra ventas en 30 días (publicaciones ya cerradas), no dice que no vende');
ok(m.groupCounts.SANA === 0, `La tarjeta "Sanas" no cuenta publicaciones sin ventas (${m.groupCounts.SANA})`);
ok(m.groupCounts.ABANDONADAS === 4, `Las 4 quedan en Abandonadas (${m.groupCounts.ABANDONADAS})`);
ok(sum.startPlan?.length === 3 && /mejor nota/.test(sum.startPlan[0].label) && /precio y fotos/.test(sum.startPlan[1].label) && /Cerrá/.test(sum.startPlan[2].label),
  `Plan para arrancar: ${sum.startPlan?.map((x) => x.label).join(' / ')}`);
const best = sum.startPlan[0].top;
const scores = m.rows.map((r) => r.score?.score).filter((x) => x != null).sort((a, b) => b - a).slice(0, 3);
ok(best.length === 3 && best.every((t, i) => t.title.includes(`nota ${scores[i]}`)), 'Las 3 del plan son las de mejor nota, de mayor a menor');
ok(/mejor nota/.test(sum.first), `"Qué arreglar primero": ${sum.first}`);

// Una que vende pero las demás abandonadas: la que vende sí puede ser sana; la cuenta no dice "no vende".
const mixed = buildModel(d);
ok(sellingState(mixed).state === 'vende', 'Cuenta que vende (demo): estado "vende"');
ok(mixed.rows.filter((r) => r.group === 'SANA').every((r) => (r.it.sales30 || 0) > 0 || (r.it.sales180 ?? r.it.sales90 ?? 0) > 0), 'Ninguna "Sana" sin ventas');
// Vendió en 6 meses pero nada en 30 días: "no vendió nada en los últimos 30 días", nunca "sana"
const frozen = buildModel({ ...d, lines: [], items: d.items.map((it) => ({ ...it, sales30: 0 })), revenue: { ...d.revenue, d30: 0 } });
const sf = buildRuleSummary(frozen);
ok(!/sana/i.test(sf.headline), `Frenada 30 días: "${sf.headline}"`);

// ── 2) Publicidad sin gasto ──
const ad = (id, cost, total, clicks = 0) => ({ item_id: id, cost, total_amount: total, direct_amount: total, indirect_amount: 0, clicks, item: { title: 'Libro ' + id, price: 33000, listing_type: 'gold_pro', cost: null, maxFinancingPct: 0.129 } });
const cdata = { offers: [], fees: { 'gold_pro||33000': { percentage: 13.5, fixed: 0, financing: 4257, source: 'meli' } }, taxRate: 0,
  ads: [...Array.from({ length: 9 }, (_, i) => ad('MLA' + i, 0, 0)), ad('MLAX', 2000, 33000, 40)] };
const ev = evaluateAll(cdata);
const camps = [{ id: 1, name: 'Mi campaña', status: 'paused', metrics: { cost: 0, total_amount: 0, clicks: 0 } }];
const sp = splitIdle(ev.ads, camps);
ok(sp.idleAds.length === 9 && sp.ads.length === 1, `9 avisos sin gasto van a una línea; el que gastó tiene tarjeta (${sp.idleAds.length} / ${sp.ads.length})`);
ok(sp.idleCampaigns.length === 1 && sp.campaigns.length === 0, 'La campaña sin gasto va a la línea, no a una tarjeta con ceros');
ok(campaignStateText(camps[0]) === 'está pausada' && campaignStateText({ status: 'active', budget: 0 }) === 'no tiene presupuesto' && campaignStateText({}) === null, 'Estado de campaña: pausada / sin presupuesto; si MeLi no lo manda, no se dice nada');
ok(!isIdleAds({ cost: null, total_amount: null }), 'Sin métricas (null) no es "sin gasto": se muestra aparte, no como $0');
ok(ev.ads.every(({ e }) => e.verdict === null), 'Sin costo cargado: ningún aviso tiene veredicto');

// ── 3) Plan ──
ok(regenState({ paid: true, user: { plan: 'rinde', can_regenerate: false } }).showFreeUsed === false, 'Plan Rinde: nunca "Ya usaste tu diagnóstico gratis"');
ok(regenState({ paid: false, user: { plan: 'rinde', can_regenerate: false } }).canRegen === true, 'Plan Rinde según el usuario (aunque el dato viejo diga no pago): puede regenerar');
ok(regenState({ paid: false, user: { plan: 'free', can_regenerate: false } }).showFreeUsed === true, 'Gratis y ya usado: sí muestra el aviso');
ok(planChanged(false, { user: { plan: 'rinde' } }) && !planChanged(true, { user: { plan: 'rinde' } }), 'Si activaron el plan con la página abierta, se detecta y se relee');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
