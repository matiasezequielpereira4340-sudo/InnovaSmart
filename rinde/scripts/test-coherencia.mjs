// Pruebas: estados coherentes entre pestañas, Full/Flex siempre, rutas públicas y costos.
// Uso: node scripts/test-coherencia.mjs
import fs from 'node:fs';
import { buildModel } from '../shared/model.js';
import { getDemoData } from '../shared/demo-data.js';
import { shippingStatus, groupLabel, opState } from '../shared/rules.js';
import { checkConfig, ROUTES } from '../shared/routes.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const D = getDemoData();

// ── Abandonada · sin stock / pausada: igual en tarjetas, listas y alertas ──
const items = D.items.slice(0, 4).map((x, k) => ({ ...x, status: k === 1 ? 'paused' : 'active', available_quantity: k === 0 ? 0 : 5, sub_status: k === 0 ? ['out_of_stock'] : [], sales30: 0, sales90: 0, sales180: 0, revenue180: 0, hist: undefined }));
const m = buildModel({ ...D, items, lines: [] });
ok(m.rows.every((r) => r.group === 'ABANDONADAS'), 'Cuenta sin ventas en 6 meses: las 4 son abandonadas');
ok(groupLabel('ABANDONADAS', items[0]) === 'Abandonada · sin stock' && groupLabel('ABANDONADAS', items[1]) === 'Abandonada · pausada' && groupLabel('ABANDONADAS', items[2]) === null, 'Etiqueta con el estado real: "Abandonada · sin stock" / "Abandonada · pausada"');
const al = Object.fromEntries(m.alerts.filter((a) => a.item_id).map((a) => [a.item_id, a.message]));
ok(/^Abandonada · sin stock/.test(al[items[0].id]) && /^Abandonada · pausada/.test(al[items[1].id]), `La alerta dice lo mismo: "${al[items[0].id]}"`);
ok(opState({ status: 'active', available_quantity: 3 }) === null, 'Activa con stock: sin estado extra');

// ── Full/Flex: estado de cada una aunque no califique ──
const all = buildModel(D).rows;
ok(all.every((r) => r.shipStatus?.full?.text && r.shipStatus?.flex?.text), 'Todas las publicaciones tienen texto de Full y de Flex');
const none = shippingStatus({ status: 'active', available_quantity: 10, shipping: { logistic: 'drop_off' }, hist: { weeks: [0, 0, 0, 0, 0, 0] } }, {}, {});
ok(none.full.text === 'Para Full te falta: vender 2 por semana durante 4 de 6 semanas (hoy 0 de 6).', `Sin ventas: "${none.full.text}"`);
ok(/1 por semana durante 4 de 6 semanas \(hoy 0 de 6\)/.test(none.flex.text), 'Flex: qué le falta');
// Temporada que termina pronto (invierno en agosto, vende bien): no conviene Full y dice en cuántas semanas termina.
const winter = { title: 'Campera Polar Invierno', status: 'active', available_quantity: 40, shipping: { logistic: 'drop_off' }, hist: { weeks: [5, 5, 4, 4, 3, 3], months: { 6: 30, 7: 25, 8: 20 } } };
const ag = shippingStatus(winter, {}, {}, new Date('2026-08-15T15:00:00Z'));
ok(ag.full.state === 'no_conviene' && /termina en ~\d+ semana/.test(ag.full.text), `Temporada terminando: "${ag.full.text}"`);
const nov = shippingStatus(winter, {}, {}, new Date('2026-11-15T15:00:00Z'));
ok(nov.full.state === 'no_conviene' && /fuera de temporada/.test(nov.full.text), `Fuera de temporada: "${nov.full.text}"`);
ok(shippingStatus({ status: 'active', available_quantity: 5, shipping: { logistic: 'fulfillment' } }, {}, {}).full.state === 'ya', 'Ya en Full');
ok(shippingStatus({ status: 'paused', available_quantity: 5, shipping: { logistic: 'drop_off' } }, {}, {}).full.state === 'no_aplica', 'Pausada: no aplica (primero activarla)');

// ── Rutas públicas (lo mismo que corre Vercel antes de publicar) ──
const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const exists = (f) => fs.existsSync(new URL('../' + f, import.meta.url));
const chk = checkConfig(cfg, exists);
ok(!chk.problems.length && ROUTES.every((p) => chk.routes.find((r) => r.p === p)?.ok), `Las ${ROUTES.length} rutas resuelven: ${ROUTES.join(' ')}`);
const viejo = { ...cfg, rewrites: [{ source: '/demo', destination: '/app.html' }] };
ok(checkConfig(viejo, exists).problems.some((x) => /\/demo/.test(x)), 'La config que daba 404 en /demo se detecta antes de publicar');
ok(cfg.buildCommand === 'node api/_lib/check-routes.mjs' && !fs.readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split('\n').includes('api'), 'El chequeo corre en cada deploy (y su archivo se sube)');

// ── Costos: la app manda números; el servidor no les saca los puntos ──
const prof = fs.readFileSync(new URL('../api/profit.js', import.meta.url), 'utf8');
const numSrc = prof.slice(prof.indexOf('const num ='), prof.indexOf('};', prof.indexOf('const num =')) + 2);
const num = new Function(`${numSrc}; return num;`)();
ok(num(1234.5) === 1234.5 && num('1.234,50') === 1234.5 && num('9800') === 9800, 'Costo 1234.5 se guarda como 1234.5 (antes quedaba 12345)');

// ── Diagnóstico: sin el consejo viejo de Full/Flex (lo explica la sección Full y Flex) ──
const { buildRuleSummary } = await import('../shared/model.js');
const sum = buildRuleSummary(buildModel(D));
ok(!(sum.tips || []).some((t) => /Flex|Full/.test(t.detail)), 'Resumen sin "Si en algún momento querés acelerar entregas, Flex o Full…"');
const allSrc = ['../shared/model.js', '../assets/app.js', '../api/diagnosis.js'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
ok(!/acelerar entregas/.test(allSrc), 'Ese texto ya no está en ningún lado');

// ── Tarjetas: "(+1 abandonada)" ──
const tileSrc = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const tileFn = tileSrc.slice(tileSrc.indexOf('function tileStates'), tileSrc.indexOf('function', tileSrc.indexOf('function tileStates') + 10));
ok(/`\+\$\{a\} abandonada/.test(tileFn) && !/abandonadas? o de temporada/.test(tileFn), 'Tarjetas Sin stock / Pausadas: "(+1 abandonada)"');

// ── Textos ──
const app = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
ok(app.includes("'Tus publicaciones de peor a mejor'"), 'Menos de 10: "Tus publicaciones de peor a mejor"');
ok(app.includes('Te faltan cargar') && app.includes("addEventListener('change', () => saveOneCost(inp))"), 'Carga de costos: "Te faltan cargar N costos" y guarda al salir del campo');
const profitUi = app.slice(app.indexOf('function profitView()'), app.indexOf('// ─────────────────────────────── Alertas'));
ok(profitUi.length > 500 && !/90 días/.test(profitUi) && (profitUi.match(/Últimos 30 días/g) || []).length === 2, 'Rentabilidad: un solo período, dicho una vez en el título (con y sin ventas)');
ok(!/sin dato/.test(app), 'Nunca "sin dato"');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
