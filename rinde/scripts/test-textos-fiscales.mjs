// Prueba: "IVA" e "Impuesto interno" no pueden aparecer en NINGÚN texto que se muestre de una publicación
// (nota, mejoras, plan de IA o de reglas, motivos, Full/Flex, alertas, resumen, sugerencias), aunque vengan de
// datos o textos guardados antes del filtro. Uso: node scripts/test-textos-fiscales.mjs
import { buildModel, buildRuleSummary } from '../shared/model.js';
import { getDemoData } from '../shared/demo-data.js';
import { sourceOf, ruleSuggestion } from '../shared/suggest.js';
import { scrubSuggestion, mentionsInternalAttr } from '../shared/attrs.js';
import { guardPlan } from '../shared/plan-guard.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const FISCAL = /\bIVA\b|impuestos? internos?/i;
const hit = (obj) => { const s = JSON.stringify(obj); const m = s.match(/.{0,60}(\bIVA\b|[Ii]mpuestos? internos?).{0,30}/); return m ? m[0] : null; };

// Trimmer de MATYPERE (MLA2864508298) tal como está guardado: atributos con IVA e impuesto interno y el plan
// de IA real ("Completar los 4 atributos faltantes / Cargá Voltaje de la batería, Tipo de pila, IVA, Impuesto interno.").
const trimmer = { id: 'MLA2864508298', title: 'Trimmer Afeitadora Recortadora Barba Portátil Usb 0.5mm A 4mm Color Dorado Oscuro', title_max: 60, price: 10000, listing_type: 'gold_special', status: 'active', available_quantity: 11, pictures_count: 3, pics: [1128, 1100, 658], visits30: 1, sales30: 0, sales90: 0, sales180: 0, desc_len: 1269, video: false, questions_unanswered: 0, oldest_question_hours: 0, catalog_listing: true, sub_status: [], shipping: { logistic: 'xd_drop_off', flex: false, free_shipping: false }, category_id: 'MLA5411',
  attrs: { rec_total: 21, req_total: 2, rec_missing: ['Voltaje de la batería', 'Tipo de pila', 'IVA', 'Impuesto interno'], req_missing: [] } };
const iaPlan = { source: 'ia', verdict: 'mejorar', headline: 'Casi sin visitas con buena nota: completá fotos y atributos para ganar visibilidad.', actions: [
  { title: 'Completar los 4 atributos faltantes', detail: 'Cargá Voltaje de la batería, Tipo de pila, IVA, Impuesto interno.', impact: 'alto' },
  { title: 'Subir 3 fotos más', detail: 'Tenés 3 fotos, sumá 3 más: en uso, detalle y medidas.', impact: 'alto' },
  { title: 'Sumar un video corto', detail: 'Sumá un video o clip corto mostrando el producto en uso.', impact: 'medio' },
] };
const others = [
  { ...trimmer, id: 'MLA2705340112', title: 'Orta Celular Magnético Fuerte Para Auto Soporte 360 Tipo', status: 'paused', available_quantity: 3, catalog_listing: false, attrs: { rec_total: 15, req_total: 3, rec_missing: ['Color', 'IVA', 'Impuesto interno'], req_missing: ['Modelo del soporte'] } },
];
const m = buildModel({ items: [trimmer, ...others], lines: [], costs: {}, settings: {}, seller: {}, plans: { [trimmer.id]: iaPlan, MLA2705340112: { ...iaPlan, headline: 'Completá los atributos: falta el IVA y el impuesto interno.' } } });
for (const r of m.rows) {
  const shown = { score: r.score, plan: r.plan, reasons: r.cls.reasons, ship: r.shipStatus, season: r.season };
  ok(!hit(shown), `${r.it.id}: ningún texto de la publicación menciona IVA ni impuesto interno${hit(shown) ? ` → "${hit(shown)}"` : ''}`);
}
const t = m.rows.find((r) => r.it.id === trimmer.id);
const attrAct = t.plan.actions.find((a) => /atribut/i.test(a.title));
ok(attrAct && /Voltaje de la batería, Tipo de pila/.test(attrAct.detail) && !/\b4\b/.test(attrAct.title + attrAct.detail), `Trimmer: la acción de atributos sale de la lista filtrada ("${attrAct?.title}: ${attrAct?.detail}")`);
ok(t.plan.actions.some((a) => /foto/i.test(a.title)) && t.plan.actions.some((a) => /video/i.test(a.title)), 'Las otras acciones de la IA (fotos, video) se mantienen');
const s = m.rows.find((r) => r.it.id === 'MLA2705340112');
ok(!FISCAL.test(s.plan.headline), `Titular guardado que nombra el IVA: se reemplaza ("${s.plan.headline}")`);
ok(!hit(m.alerts) && !hit(buildRuleSummary(m)), 'Alertas y resumen del diagnóstico sin IVA ni impuesto interno');

// guardPlan directo (lo mismo que se aplica a TODO plan guardado al mostrarlo)
ok(guardPlan(iaPlan, t.score, { actions: [] }).actions.every((a) => !FISCAL.test(a.title + a.detail)), 'guardPlan saca la acción con IVA aunque no haya reemplazo');
ok(!mentionsInternalAttr('Bajá el precio: con IVA incluido te queda poco margen.'), 'No confunde un "IVA" de precio con un atributo');

// Sugerencias: nuevas y guardadas antes del filtro
const sug = ruleSuggestion(sourceOf({ item: trimmer, attributes: [{ id: 'VALUE_ADDED_TAX', name: 'IVA', value: '21 %' }, { id: 'BRAND', name: 'Marca', value: 'Genérica' }] }));
ok(!hit(sug), 'Sugerencia nueva sin IVA ni impuesto interno (lista de atributos y descripción)');
const viejaGuardada = { attributes: [{ name: 'Voltaje de la batería', hint: 'Completá con el dato real del producto' }, { name: 'IVA', fiscal: true, hint: 'Dato fiscal: completalo con tu contador' }, { name: 'Impuesto interno', fiscal: true, hint: 'Dato fiscal' }], description: { text: 'CARACTERÍSTICAS\n- Marca: Genérica\n- IVA: 21 %', length: 40 }, notes: [] };
ok(!hit(scrubSuggestion(viejaGuardada)), 'Sugerencia guardada antes del filtro: se limpia al mostrarla');

// Demo: aunque una categoría traiga IVA e impuesto interno, no aparecen en ninguna pantalla de publicación
const d = getDemoData();
for (const it of d.items) if (it.attrs) it.attrs = { ...it.attrs, rec_total: it.attrs.rec_total + 2, rec_missing: [...it.attrs.rec_missing, 'IVA', 'Impuesto interno'] };
const dm = buildModel(d);
const bad = dm.rows.filter((r) => hit({ score: r.score, plan: r.plan, reasons: r.cls.reasons, ship: r.shipStatus }));
ok(!bad.length, `Demo con IVA inyectado en las ${dm.rows.length} publicaciones: ningún texto lo muestra${bad.length ? ` (${bad.map((r) => r.it.id).join(', ')})` : ''}`);
ok(!hit(buildRuleSummary(dm)) && !hit(dm.alerts), 'Demo: resumen y alertas limpios');

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
