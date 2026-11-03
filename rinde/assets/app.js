// Rinde — app (diagnóstico, rentabilidad, alertas). Funciona en modo real (/app) y DEMO (/demo).
import { I, hydrateIcons } from './icons.js';
import { CATEGORIES, THRESHOLDS, waLink, PLAN_PRICE_ARS } from '../shared/config.js';
import { fmtMoney, fmtPct, conversion, LISTING_LABEL, ALERT_LABELS, competitorRef, priceGap } from '../shared/rules.js';
import { buildModel, buildRuleSummary, costKey } from '../shared/model.js';

const DEMO = location.pathname.startsWith('/demo') || new URLSearchParams(location.search).has('demo');
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TONE_TAG = { bad: 'tag-bad', warn: 'tag-warn', ok: 'tag-ok' };

const S = {
  demoData: null, // datos crudos del demo (editables en memoria)
  model: null,
  summary: null,
  user: null,
  paid: false,
  syncedAt: null,
  filter: 'TODAS',
  sort: { key: 'revenue', dir: -1 },
  dirtyCosts: {},
  settings: {},
  productAds: false,
  history: [],
};

// ─────────────────────────────── API ───────────────────────────────────────
async function api(path, opts = {}) {
  const { timeout = 50000, ...rest } = opts;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...rest, body: rest.body ? JSON.stringify(rest.body) : undefined, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw Object.assign(new Error('El servidor tardó demasiado en responder.'), { status: 0, code: 'timeout' });
    throw Object.assign(new Error('No hay conexión. Revisá tu internet y reintentá.'), { status: 0 });
  }
  clearTimeout(timer);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Algo falló. Reintentá en unos minutos.'), { status: r.status, code: data.code, data });
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ─────────────────────────────── Helpers UI ────────────────────────────────
function catTag(key) {
  const c = CATEGORIES[key];
  return `<span class="tag ${TONE_TAG[c.tone]}">${I[c.icon]} ${esc(c.label)}</span>`;
}
const shipLabel = (it) => (it.shipping?.logistic === 'fulfillment' ? 'Full' : it.shipping?.flex ? 'Flex' : 'Normal');
const sd = (v, f = (x) => x) => (v == null ? '<span class="muted">sin dato</span>' : f(v));
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
};

function helpBox(context = 'diag') {
  return `<div class="help-box">
    <div class="row">${I.sparkle}<div><b>¿No tenés tiempo de hacer estos cambios?</b><div class="small muted">${context === 'profit' ? 'Te ayudamos a ajustar precios y costos para que cada venta deje plata.' : 'Innovasmart optimiza tus publicaciones por vos, empezando por las que más ventas te cuestan.'}</div></div></div>
    <div class="help-links">
      <a class="btn btn-wa btn-sm" href="${waLink('optimize')}" target="_blank" rel="noopener">${I.chat} Que lo optimice Innovasmart por vos</a>
      <a class="btn btn-light btn-sm" href="${waLink('ai')}" target="_blank" rel="noopener">${I.sparkle} Aprendé a usar IA en tu negocio como esta herramienta</a>
    </div>
  </div>`;
}

function lockCard(what) {
  return `<div class="card lock">${I.lock.replace('<svg', '<svg class="big"')}
    <h2 style="margin-top:10px">${esc(what)} es parte del Plan Rinde</h2>
    <p class="muted">Diagnóstico ilimitado, rentabilidad real por producto, margen a costo de reposición y alertas diarias por email.</p>
    <p><b style="font-size:1.4rem">$${PLAN_PRICE_ARS.toLocaleString('es-AR')}</b> <span class="muted">/ mes · 3 días gratis con tarjeta</span></p>
    <a class="btn btn-primary" href="/suscribirme">Suscribirme</a>
    <p class="tiny muted" style="margin-top:10px">Con tarjeta por Mercado Pago o por transferencia. Cancelás cuando quieras.</p>
    <p class="small"><a href="/demo#/${what === 'La rentabilidad' ? 'rentabilidad' : 'alertas'}">Ver cómo se ve en el demo</a></p>
  </div>`;
}

function errorView(msg, retry = true) {
  $app.innerHTML = `${header()}<div class="wrap" style="padding-top:30px"><div class="notice notice-bad" role="alert">${I.alert}<div><b>No pudimos cargar tus datos</b><div>${esc(msg)}</div>${retry ? '<button class="btn btn-light btn-sm" style="margin-top:10px" id="retry">Reintentar</button>' : ''}</div></div></div>`;
  document.getElementById('retry')?.addEventListener('click', () => boot());
}

// ─────────────────────────────── Layout ────────────────────────────────────
function header() {
  const route = currentRoute();
  const tab = (r, icon, label) => `<a href="#/${r}" ${route === r ? 'aria-current="page"' : ''}>${I[icon]}<span>${label}</span></a>`;
  const tabs = `<nav class="tabs" aria-label="Secciones de la app">${tab('diagnostico', 'search', 'Diagnóstico')}${tab('rentabilidad', 'money', 'Rentabilidad')}${tab('alertas', 'bell', 'Alertas')}</nav>`;
  return `${DEMO ? `<div class="demo-bar"><div class="wrap"><span>${I.info.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px"')} Estás viendo una <b>cuenta de ejemplo</b> con datos ficticios.</span><a href="/api/auth/login">Diagnosticar mi cuenta gratis →</a></div></div>` : ''}
  <header class="topbar"><div class="wrap">
    <a class="logo" href="${DEMO ? '/' : '#/diagnostico'}" aria-label="Rinde"><span class="logo-mark" data-logo></span>Rinde<span class="dot">.</span></a>
    <div class="desktop-only">${tabs}</div>
    <details class="menu" style="position:relative">
      <summary class="btn btn-ghost btn-sm" aria-label="Menú de cuenta">${I.user}<span class="desktop-only">${esc(S.user?.nickname || (DEMO ? 'TIENDA.EJEMPLO' : ''))}</span></summary>
      <div class="card menu-panel">
        <div class="small muted" style="padding:6px 8px">${esc(S.user?.nickname || '')} · ${S.paid ? '<span class="tag tag-accent">Plan Rinde</span>' : '<span class="tag tag-neutral">Gratis</span>'}</div>
        ${!S.paid ? `<a class="btn btn-primary btn-sm btn-block" href="/suscribirme">Suscribirme al Plan Rinde</a>` : ''}
        ${DEMO ? '<a class="btn btn-ghost btn-sm btn-block" href="/">Volver al inicio</a>' : `
        <a class="btn btn-ghost btn-sm btn-block" href="/api/auth/logout">${I.logout} Salir</a>
        <button class="btn btn-ghost btn-sm btn-block" style="color:var(--bad)" id="disconnect">${I.trash} Desconectar mi cuenta</button>`}
      </div>
    </details>
  </div></header>
  <div class="mobile-tabs">${tabs.replace('class="tabs"', 'class="tabs mobile-nav"')}</div>`;
}

function currentRoute() {
  const r = (location.hash || '#/diagnostico').replace('#/', '');
  return ['diagnostico', 'rentabilidad', 'alertas', 'conectando'].includes(r) ? r : 'diagnostico';
}

function billingBanner() {
  const b = S.user?.billing;
  if (DEMO || !b?.status) return '';
  const d = (iso) => (iso ? new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' }) : '');
  if (b.status === 'past_due') return `<div class="wrap" style="padding-top:14px"><div class="notice notice-bad" role="alert">${I.alert}<div><b>No pudimos cobrar tu Plan Rinde.</b> Tenés hasta el ${d(b.grace_until)} para pagar sin perder nada. <a href="/suscribirme">Actualizar medio de pago</a></div></div></div>`;
  if (b.status === 'lapsed') return `<div class="wrap" style="padding-top:14px"><div class="notice notice-warn">${I.info}<div>Tu plan se cortó por falta de pago y pasaste al plan gratis. No borramos nada. <a href="/suscribirme">Reactivar el Plan Rinde</a></div></div></div>`;
  if (b.status === 'trial') return `<div class="wrap" style="padding-top:14px"><div class="notice notice-info">${I.sparkle}<div>Estás en la prueba gratis hasta el ${d(b.expires_at)}.</div></div></div>`;
  return '';
}

function render() {
  let route = currentRoute();
  if (route === 'conectando') {
    // Solo mostramos "diagnosticando" si de verdad hay un diagnóstico en curso; si no, vamos al resultado.
    if (!DEMO && S.connectRun && !S.connectRun.ended) return connectingView();
    history.replaceState(null, '', '#/diagnostico');
    route = 'diagnostico';
  }
  let body = '';
  if (route === 'rentabilidad') body = profitView();
  else if (route === 'alertas') body = alertsView();
  else body = diagnosisView();
  $app.innerHTML = header() + billingBanner() + `<main class="wrap${route === 'rentabilidad' ? ' wide' : ''}">${body}</main>
  <footer class="footer"><div class="wrap"><span>Rinde · un servicio de Innovasmart · solo lectura: nunca modificamos tu cuenta.</span><span><a href="/privacidad">Privacidad</a> · <a href="/terminos">Términos</a></span></div></footer>`;
  hydrateIcons($app);
  bind(route);
}

// ─────────────────────────────── Diagnóstico ───────────────────────────────
function sortedRows() {
  return [...S.model.rows].sort((a, b) => CATEGORIES[a.cls.category].order - CATEGORIES[b.cls.category].order || (b.lost + Math.max(0, -(b.profit.net || 0))) - (a.lost + Math.max(0, -(a.profit.net || 0))));
}

function diagnosisView() {
  const m = S.model;
  const sum = S.summary || buildRuleSummary(m);
  const canRegen = DEMO || S.paid || S.user?.can_regenerate;
  const total = m.rows.length;
  const noCosts = m.hasAnyCost === false;
  const tiles = Object.values(CATEGORIES).map((c) => (c.key === 'PIERDE_PLATA' && noCosts)
    ? `<a class="cat-tile ${c.tone} is-pending" href="#/rentabilidad" aria-label="Pierde plata: cargá tus costos para calcularlo"><span class="n n-text">Cargá tus costos para calcularlo</span><span class="l">${I[c.icon]} ${esc(c.short)}</span></a>`
    : `<button class="cat-tile ${c.tone}" data-filter="${c.key}" aria-label="Filtrar ${esc(c.label)}: ${m.counts[c.key]}"><span class="n">${m.counts[c.key]}</span><span class="l">${I[c.icon]} ${esc(c.short)}</span></button>`).join('');
  const chips = [['TODAS', 'Todas', total, 'search'], ...Object.values(CATEGORIES).map((c) => [c.key, c.short, m.counts[c.key], c.icon])]
    .map(([k, l, n, ic]) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${I[ic]} ${esc(l)} <span class="count">${n}</span></button>`).join('');
  const rows = sortedRows().filter((r) => S.filter === 'TODAS' || r.cls.category === S.filter);

  return `
  <div class="page-head">
    <div><h1>Diagnóstico de tu cuenta</h1><div class="small muted">${total} publicaciones activas y pausadas · datos ${ago(S.syncedAt)}</div></div>
    ${canRegen
      ? `<button class="btn btn-light btn-sm" id="regen">${I.refresh} ${DEMO ? 'Regenerar (demo)' : 'Actualizar diagnóstico'}</button>`
      : `<a class="btn btn-light btn-sm" href="/suscribirme">${I.lock} Regenerar con Plan Rinde</a>`}
  </div>
  ${!canRegen ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Ya usaste tu diagnóstico gratis: podés verlo siempre. Para actualizarlo cuando cambies algo, <a href="/suscribirme">suscribite al Plan Rinde</a>.</div></div>` : ''}
  <div class="diag-grid">
    <section class="summary-card" aria-labelledby="sum-h">
      <div class="label">Resumen de la cuenta · ${total} publicaciones</div>
      <h2 id="sum-h">${esc(sum.headline)}</h2>
      ${sum.revenueNote ? `<div class="rev-note">${esc(sum.revenueNote)}</div>` : ''}
      <div class="problems">${(sum.problems || []).map((p) => problemBlock(p)).join('') || '<div class="problem"><b>Sin problemas graves</b><span>Tu cuenta está sana.</span></div>'}</div>
      ${sum.abandoned ? `<div class="problems problems-extra">${problemBlock(sum.abandoned, 'Abandonadas')}</div>` : ''}
      ${(sum.tips || []).length ? sum.tips.map((t) => `<p class="tip-line">${I.info} ${esc(t.detail)}</p>`).join('') : ''}
      ${sum.first ? `<div class="first">${I.arrow}<div><b>Qué arreglar primero:</b> ${esc(sum.first)}</div></div>` : ''}
      ${sum.explain ? `<details class="meta" style="margin-top:12px"><summary style="cursor:pointer;color:var(--panel-ink);font-weight:600">¿Cómo calculamos este número?</summary><p style="margin:6px 0 0">${esc(sum.explain)}</p></details>` : ''}
      <div class="meta">${sum.source === 'ia' ? 'Las recomendaciones las redacta la IA con tus datos reales; los montos los calculamos nosotros.' : 'Resumen calculado con tus datos reales.'}</div>
    </section>
    <div class="diag-side">
      <div class="label">Por categoría · tocá para filtrar</div>
      <div class="cat-grid" role="group" aria-label="Publicaciones por categoría">${tiles}</div>
      ${helpBox()}
    </div>
  </div>
  <h2 style="margin:30px 0 10px;font-size:1.4rem">Publicaciones</h2>
  <div class="cat-filter" role="toolbar" aria-label="Filtrar por categoría">${chips}</div>
  <div class="items">${rows.map(itemCard).join('') || '<div class="empty">No hay publicaciones en esta categoría.</div>'}</div>`;
}

function topList(top) {
  if (!top?.length) return '';
  const lis = top.map((t) => t.more
    ? `<li class="more">y ${t.more} más</li>`
    : `<li>${t.permalink && t.permalink !== '#' ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener">${esc(t.title)}</a>` : esc(t.title)} <span class="sold">${t.sold ? `${t.sold} vendida${t.sold === 1 ? '' : 's'} en 6 meses` : 'sin ventas en 6 meses'}</span></li>`).join('');
  return `<ol class="top-items">${lis}</ol>`;
}

function problemBlock(p, tag) {
  return `<div class="problem${tag ? ' problem-tag' : ''}">${tag ? `<span class="ptag">${esc(tag)}</span>` : ''}<b>${esc(p.label)}</b><span>${esc(p.detail)}${p.fix ? ` — ${esc(p.fix)}` : ''}</span>${topList(p.top)}</div>`;
}

function itemCard(r) {
  const { it, cls, plan, profit } = r;
  const conv = conversion(it);
  const ref = competitorRef(it);
  const gap = priceGap(it);
  const reasons = (cls.reasons || []).filter((x) => x.text);
  return `<details class="item tone-${CATEGORIES[cls.category].tone}" id="it-${esc(it.id)}">
    <summary>
      <div class="i-top"><div class="i-title">${esc(it.title)}</div>${catTag(cls.category)}</div>
      <div class="i-meta"><span>Precio <b>${fmtMoney(it.price)}</b></span><span>Visitas 30 d <b>${sd(it.visits30, (v) => v.toLocaleString('es-AR'))}</b></span><span>Ventas 30 d <b>${it.sales30 ?? 0}</b></span><span>Conversión <b>${conv == null ? 'sin dato' : fmtPct(conv)}</b></span></div>
      <div class="i-head">${plan.verdict === 'liquidar' ? `<span class="tag tag-bad">${I.x} Sin salida</span> ` : ''}${esc(plan.headline)}</div>
      <span class="i-more">Ver plan de acción ${I.chevron}</span>
    </summary>
    <div class="i-body">
      <div class="facts">
        <div class="fact"><span>Calidad Mercado Libre</span><b>${it.quality ? `${sd(it.quality.score)}/100` : '<span class="muted">sin dato</span>'}</b> ${it.quality?.level_wording ? `<span>${esc(it.quality.level_wording)}</span>` : ''}</div>
        <div class="fact"><span>Competencia (referencia)</span><b>${ref ? fmtMoney(ref) : '<span class="muted">sin dato</span>'}</b>${gap != null ? `<span>${gap > 0 ? 'estás ' + fmtPct(gap) + ' arriba' : 'estás ' + fmtPct(-gap) + ' abajo'}</span>` : ''}</div>
        <div class="fact"><span>Preguntas sin responder</span><b>${it.questions_unanswered ?? 0}</b>${it.oldest_question_hours ? `<span>la más vieja: ${it.oldest_question_hours} h</span>` : ''}</div>
        <div class="fact"><span>Ganancia 30 días</span><b class="${profit.net < 0 ? 'neg' : ''}">${profit.hasCost ? (profit.units ? fmtMoney(profit.net) : 'sin ventas') : '<span class="muted">costo sin cargar</span>'}</b></div>
        <div class="fact"><span>Tipo / envío</span><b>${esc(LISTING_LABEL[it.listing_type] || it.listing_type || 'sin dato')} · ${shipLabel(it)}</b></div>
        <div class="fact"><span>Stock</span><b>${sd(it.available_quantity)}</b></div>
        <div class="fact"><span>Ventas 90 días</span><b>${it.sales90 ?? 0}</b></div>
        <div class="fact"><span>Fotos</span><b>${sd(it.pictures_count)}</b></div>
      </div>
      ${reasons.length ? `<p class="sec-label">Qué detectamos</p><ul class="reasons">${reasons.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : ''}
      ${plan.actions?.length ? `<p class="sec-label">Plan de acción · de mayor a menor impacto</p>
      <ol class="actions">${plan.actions.map((a) => `<li><b>${esc(a.title)}<span class="impact impact-${esc(a.impact)}">impacto ${esc(a.impact)}</span></b><p>${esc(a.detail)}</p></li>`).join('')}</ol>` : ''}
      <div class="source" style="margin-bottom:12px">${plan.source === 'ia' ? 'Plan redactado con IA usando solo tus datos y las recomendaciones de Mercado Libre.' : 'Plan armado con reglas a partir de tus datos.'} ${it.permalink && it.permalink !== '#' ? `· <a href="${esc(it.permalink)}" target="_blank" rel="noopener">Ver publicación</a>` : ''}</div>
      ${cls.category !== 'SANA' ? helpBox() : ''}
    </div>
  </details>`;
}

// ─────────────────────────────── Rentabilidad ──────────────────────────────
const COLS = [
  ['title', 'Producto'], ['units', 'Ventas'], ['revenue', 'Facturación'], ['fees', 'Cargos ML'], ['ads', 'Publicidad'],
  ['purchase', 'Costo compra'], ['replacement', 'Costo reposición'], ['net', 'Ganancia'], ['margin', 'Margen'], ['marginR', 'Margen repos.'], ['minPrice', 'Precio mín.'], ['suggested', 'Sugerido'],
];
function profitRows() {
  const rows = S.model.rows.map((r) => ({
    r,
    title: r.it.title, units: r.profit.units, revenue: r.profit.revenue, fees: r.profit.feesTotal, ads: r.profit.ads,
    purchase: r.cost?.purchase ?? null, replacement: r.cost?.replacement ?? null,
    net: r.profit.net, margin: r.profit.margin, marginR: r.profit.marginReplacement, minPrice: r.profit.minPrice, suggested: r.profit.suggestedPrice,
  }));
  const { key, dir } = S.sort;
  return rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === 'string' ? x.localeCompare(y) * dir : (x - y) * dir;
  });
}

function profitView() {
  if (!DEMO && !S.paid) return `<div class="page-head"><h1>Rentabilidad</h1></div>${lockCard('La rentabilidad')}`;
  const k = S.model.kpis;
  const sales90 = S.model.rows.reduce((t, r) => t + (r.it.sales90 || 0), 0);
  if (!sales90) {
    return `<div class="page-head"><div><h1>Rentabilidad real</h1><div class="small muted">Últimos 30 días · cargos de la facturación de Mercado Libre</div></div></div>
    <div class="notice notice-info" style="margin-bottom:14px" role="status">${I.info}<div><b>Sin ventas en los últimos 90 días: la rentabilidad aparece cuando vendas.</b> Mientras tanto podés dejar cargados los costos de tus productos, así el día que vendas ya ves cuánto te quedó.</div></div>
    <div class="card" style="max-width:640px"><h3>${I.upload} Costos de tus productos</h3>
      <p class="small muted">Descargá la plantilla con tus SKUs, completá el costo de compra y subila, o cargalos cuando tengas ventas.</p>
      <div class="help-links"><button class="btn btn-light btn-sm" id="tpl">${I.download} Descargar plantilla</button>
      <label class="btn btn-light btn-sm" for="file">${I.upload} Subir CSV o Excel</label><input type="file" id="file" class="sr" accept=".csv,.xlsx,.xls,text/csv"></div>
      <div id="upload-msg" class="small" style="margin-top:8px" role="status"></div></div>
    <div style="margin-top:16px">${helpBox()}</div>`;
  }
  const rows = profitRows();
  const money = (v) => (v == null ? '<span class="muted">—</span>' : fmtMoney(v));
  const cls = (v) => (v == null ? '' : v < 0 ? 'neg' : 'pos');
  const inputs = (p) => `<input inputmode="decimal" aria-label="Costo de compra de ${esc(p.title)}" data-cost="${esc(costKey(p.r.it))}" data-f="purchase" value="${p.purchase ?? ''}" placeholder="cargar">`;
  const inputsR = (p) => `<input inputmode="decimal" aria-label="Costo de reposición de ${esc(p.title)}" data-cost="${esc(costKey(p.r.it))}" data-f="replacement" value="${p.replacement ?? ''}" placeholder="opcional">`;
  const warn = (p) => (p.r.warning ? `<span class="tag tag-bad" title="${esc(p.r.warning)}">${I.alert} Debajo de reposición</span>` : '');
  const sortBtn = (key, label) => `<th scope="col" aria-sort="${S.sort.key === key ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${key}">${label}${S.sort.key === key ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;

  return `
  <div class="page-head"><div><h1>Rentabilidad real</h1><div class="small muted">Últimos 30 días · cargos de la facturación de Mercado Libre</div></div></div>
  <div class="kpis">
    <div class="kpi"><div class="k-label">Facturación</div><div class="k-value num">${fmtMoney(k.revenue)}</div><div class="k-sub">${k.units} unidades</div></div>
    <div class="kpi ${k.net == null ? '' : k.net < 0 ? 'is-bad' : 'is-ok'}"><div class="k-label">Ganancia neta</div><div class="k-value num">${k.net == null ? 'cargá costos' : fmtMoney(k.net)}</div><div class="k-sub">sobre ${fmtPct(k.revenueCoverage)} de la facturación con costo</div></div>
    <div class="kpi ${k.margin != null && k.margin < THRESHOLDS.MARGIN_HEALTHY_MIN ? 'is-bad' : ''}"><div class="k-label">Margen promedio</div><div class="k-value num">${fmtPct(k.margin)}</div><div class="k-sub">después de todo</div></div>
    ${S.model.hasAnyCost === false
      ? `<div class="kpi"><div class="k-label">Pierden plata</div><div class="k-value" style="font-size:1rem">Cargá tus costos para calcularlo</div><div class="k-sub">sin costos no sabemos si perdés</div></div>`
      : `<div class="kpi ${k.losing ? 'is-bad' : 'is-ok'}"><div class="k-label">Pierden plata</div><div class="k-value num">${k.losing}</div><div class="k-sub">productos con margen negativo</div></div>`}
  </div>
  <div class="grid" style="margin-top:14px">
    ${k.belowReplacement ? `<div class="notice notice-bad" role="alert">${I.alert}<div><b>Estás vendiendo por debajo de lo que te cuesta reponer</b> en ${k.belowReplacement} producto(s). Con el precio actual, cada venta te descapitaliza. Mirá la columna "Margen repos.".</div></div>` : ''}
    ${k.noCost ? `<div class="notice notice-warn">${I.info}<div><b>${k.noCost} producto(s) con ventas tienen el costo sin cargar.</b> No calculamos ganancia para esos productos. Cargalos abajo o subí la plantilla.</div></div>` : ''}
    ${k.estimated ? `<div class="notice notice-info">${I.info}<div>Algunas ventas recientes todavía no figuran en la facturación de Mercado Libre: usamos los datos de la orden y las marcamos como <b>estimado</b>.</div></div>` : ''}
    ${k.taxesUnknown ? `<div class="notice notice-info">${I.info}<div>En algunas ventas Mercado Libre no informó retenciones/impuestos: esas ventas no los incluyen.</div></div>` : ''}
  </div>

  <div class="grid" style="margin-top:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
    <div class="card">
      <h3>${I.upload} Costos de tus productos</h3>
      <p class="small muted">Descargá la plantilla con tus SKUs ya listados, completá el costo de compra y, si querés, el de reposición hoy. Después subila (CSV o Excel). También podés editarlos directo en la tabla.</p>
      <div class="help-links"><button class="btn btn-light btn-sm" id="tpl">${I.download} Descargar plantilla</button>
      <label class="btn btn-light btn-sm" for="file">${I.upload} Subir CSV o Excel</label><input type="file" id="file" class="sr" accept=".csv,.xlsx,.xls,text/csv"></div>
      <div id="upload-msg" class="small" style="margin-top:8px" role="status"></div>
    </div>
    <div class="card">
      <h3>${I.chart} Publicidad (por mes)</h3>
      <p class="small muted">${S.productAds ? 'Product Ads: tomamos el gasto real por publicación desde Mercado Libre.' : 'Product Ads: Mercado Libre no nos dio el gasto por API. Cargalo a mano.'} Lo prorrateamos sobre tus ventas.</p>
      <div class="pc-inputs">
        <div class="field"><label for="ads-ml">Product Ads (manual)</label><input id="ads-ml" inputmode="decimal" value="${S.settings.ads_manual_monthly || ''}" placeholder="$ por mes" ${S.productAds ? 'disabled' : ''}></div>
        <div class="field"><label for="ads-meta">Meta Ads</label><input id="ads-meta" inputmode="decimal" value="${S.settings.meta_ads_monthly || ''}" placeholder="$ por mes"></div>
      </div>
      <button class="btn btn-light btn-sm" style="margin-top:10px" id="save-ads">Guardar publicidad</button>
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:22px 0 8px;flex-wrap:wrap">
    <h2 style="margin:0;font-size:1.25rem">Por producto</h2>
    <div style="display:flex;gap:8px;align-items:center"><label class="small" for="msort">Ordenar</label>
      <select id="msort" class="btn btn-light btn-sm">${COLS.map(([k2, l]) => `<option value="${k2}" ${S.sort.key === k2 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-primary btn-sm" id="save-costs" ${Object.keys(S.dirtyCosts).length ? '' : 'disabled'}>Guardar costos</button></div>
  </div>

  <div class="table-wrap desktop-only"><table class="data">
    <thead><tr>${COLS.map(([k2, l]) => sortBtn(k2, l)).join('')}</tr></thead>
    <tbody>${rows.map((p) => `<tr>
      <td class="prod"><b title="${esc(p.title)}">${esc(p.title)}</b><span class="tiny muted">${esc(costKey(p.r.it))}${p.r.profit.estimated ? ' · <span class="tag tag-neutral" style="padding:0 6px">estimado</span>' : ''}</span> ${warn(p)}</td>
      <td class="num">${p.units || '<span class="muted">0</span>'}</td>
      <td class="num">${p.units ? money(p.revenue) : '—'}</td>
      <td class="num">${p.units ? money(p.fees) : '—'}</td>
      <td class="num">${p.units ? money(p.ads) : '—'}</td>
      <td>${inputs(p)}</td><td>${inputsR(p)}</td>
      <td class="num ${cls(p.net)}">${!p.r.profit.hasCost ? '<span class="muted small">costo sin cargar</span>' : p.units ? (p.net < 0 ? '▼ ' : '') + money(p.net) : '—'}</td>
      <td class="num ${cls(p.margin)}">${p.margin == null ? '—' : fmtPct(p.margin)}</td>
      <td class="num ${cls(p.marginR)}">${p.marginR == null ? '—' : fmtPct(p.marginR)}</td>
      <td class="num">${money(p.minPrice)}</td>
      <td class="num">${money(p.suggested)}</td></tr>`).join('')}</tbody>
  </table></div>

  <div class="pcards mobile-only">${rows.map((p) => `<div class="pc">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><b style="line-height:1.3">${esc(p.title)}</b>${p.r.profit.hasCost && p.units ? (p.net < 0 ? `<span class="tag tag-bad">${I.down} Pierde</span>` : `<span class="tag tag-ok">${I.up} Gana</span>`) : `<span class="tag tag-neutral">${p.r.profit.hasCost ? 'Sin ventas' : 'Costo sin cargar'}</span>`}</div>
    ${p.r.warning ? `<div class="notice notice-bad small" style="margin:8px 0;padding:8px 10px">${I.alert}<div>${esc(p.r.warning)}</div></div>` : ''}
    <div class="row"><span>Ventas 30 d</span><b>${p.units} u · ${p.units ? fmtMoney(p.revenue) : '—'}</b></div>
    <div class="row"><span>Cargos ML + publicidad</span><b>${p.units ? fmtMoney(p.fees + p.ads) : '—'}</b></div>
    <div class="row"><span>Ganancia neta</span><b class="${cls(p.net)}">${!p.r.profit.hasCost ? 'costo sin cargar' : p.units ? fmtMoney(p.net) : '—'}</b></div>
    <div class="row"><span>Margen / a reposición</span><b>${p.margin == null ? '—' : fmtPct(p.margin)} / ${p.marginR == null ? '—' : fmtPct(p.marginR)}</b></div>
    <div class="row"><span>Precio mín. / sugerido</span><b>${money(p.minPrice)} / ${money(p.suggested)}</b></div>
    <div class="pc-inputs"><div class="field"><label>Costo compra</label>${inputs(p)}</div><div class="field"><label>Costo reposición</label>${inputsR(p)}</div></div>
  </div>`).join('')}</div>
  <p class="tiny muted" style="margin-top:10px">Ganancia = precio − comisión − envío a tu cargo − cuotas − retenciones e impuestos − costo del producto − publicidad. Precio mínimo sin pérdida y sugerido (margen ${Math.round(THRESHOLDS.TARGET_MARGIN * 100)} %) se calculan con el mayor entre costo de compra y de reposición.</p>
  <div style="margin-top:16px">${helpBox('profit')}</div>`;
}

// ─────────────────────────────── Alertas ───────────────────────────────────
function alertsView() {
  if (!DEMO && !S.paid) return `<div class="page-head"><h1>Alertas</h1></div>${lockCard('Las alertas por email')}`;
  const alerts = S.model.alerts;
  const s = S.user || {};
  return `
  <div class="page-head"><div><h1>Alertas</h1><div class="small muted">Te avisamos por email solo cuando aparece algo nuevo.</div></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">
    <section class="card">
      <h3>${I.bell} Alertas activas (${alerts.length})</h3>
      <div class="grid" style="gap:8px">${alerts.map((a) => `<div class="notice ${a.severity === 'bad' ? 'notice-bad' : 'notice-warn'}" style="padding:10px 12px">${a.severity === 'bad' ? I.alert : I.info}<div><span class="tag ${a.severity === 'bad' ? 'tag-bad' : 'tag-warn'}">${a.severity === 'bad' ? 'Urgente' : 'Atención'} · ${esc(ALERT_LABELS[a.kind] || a.kind)}</span>${a.title ? `<div style="font-weight:600;margin-top:4px">${esc(a.title)}</div>` : ''}<div class="small">${esc(a.message)}</div></div></div>`).join('') || `<div class="notice notice-ok">${I.checkCircle}<div>No hay alertas. Todo en orden.</div></div>`}</div>
    </section>
    <section class="card">
      <h3>${I.mail} Configuración de email</h3>
      <form id="alert-form">
        <div class="field"><label for="al-email">Email para alertas</label><input id="al-email" type="email" autocomplete="email" value="${esc(s.alert_email || '')}" placeholder="tu@email.com" required></div>
        <div class="toggle"><label for="al-daily"><b>Alertas diarias</b><div class="small muted">Margen negativo, venta debajo de reposición, sin stock, pausadas, infracciones, preguntas sin responder +24 h y caída de reputación.</div></label><input id="al-daily" type="checkbox" ${s.alerts_enabled !== false ? 'checked' : ''}></div>
        <div class="toggle"><label for="al-weekly"><b>Resumen semanal (lunes)</b><div class="small muted">Lo más importante de la semana en un email.</div></label><input id="al-weekly" type="checkbox" ${s.weekly_enabled !== false ? 'checked' : ''}></div>
        <div class="help-links" style="margin-top:12px"><button class="btn btn-primary btn-sm" type="submit">Guardar</button><button class="btn btn-light btn-sm" type="button" id="al-test">Mandarme un email de prueba</button></div>
      </form>
      <p class="small" style="margin-top:12px">Vista previa: <a href="/api/email-preview?type=daily" target="_blank" rel="noopener">alerta diaria</a> · <a href="/api/email-preview?type=weekly" target="_blank" rel="noopener">resumen semanal</a></p>
    </section>
  </div>
  ${S.history?.length ? `<h2 style="margin:22px 0 8px;font-size:1.2rem">Historial</h2><div class="card"><ul class="small" style="margin:0;padding-left:18px">${S.history.map((h) => `<li>${new Date(h.created_at).toLocaleDateString('es-AR')} · ${esc(ALERT_LABELS[h.kind] || h.kind)} · ${esc(h.title || '')} ${h.resolved_at ? '<span class="tag tag-ok">resuelta</span>' : ''}</li>`).join('')}</ul></div>` : ''}
  <div style="margin-top:16px">${helpBox()}</div>`;
}

// ─────────────────────────────── Conectando ────────────────────────────────
const STEPS = [['list', 'Buscando tus publicaciones'], ['items', 'Analizando cada publicación'], ['orders', 'Leyendo tus ventas (90 días)'], ['billing', 'Leyendo la facturación de Mercado Libre'], ['finalize', 'Clasificando'], ['ai', 'Armando tu plan de acción']];

function connectingView(state = { phase: 'list', done: 0, total: 0 }) {
  const idx = STEPS.findIndex(([k]) => k === state.phase);
  let pctDone = 0;
  if (state.phase === 'items' && state.total) pctDone = 10 + (state.done / state.total) * 55;
  else pctDone = [3, 10, 68, 76, 84, 90][Math.max(0, idx)] + (state.phase === 'ai' && state.aiTotal ? (state.aiDone / state.aiTotal) * 9 : 0);
  const detail = state.phase === 'items' ? `Analizando ${state.done} de ${state.total} publicaciones`
    : state.phase === 'orders' ? `${state.orders || 0} ventas leídas`
    : state.phase === 'billing' ? `Facturación: ${state.billing || 0} de ${state.billingTotal || 0} ventas`
    : state.phase === 'ai' ? (state.aiTotal ? `Plan de acción: ${state.aiDone} de ${state.aiTotal} publicaciones` : 'Escribiendo el resumen de tu cuenta')
    : 'Esto tarda unos minutos según la cantidad de publicaciones.';
  $app.innerHTML = `<div class="progress-page"><div class="wrap"><div class="card progress-card" aria-live="polite">
    <a class="logo" href="/"><span class="logo-mark" data-logo></span>Rinde<span class="dot">.</span></a>
    <h1 style="font-size:1.5rem;margin-top:16px">Estamos diagnosticando tu cuenta</h1>
    <p class="muted small">${I.shield.replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px;color:var(--ok)"')} Solo lectura: no tocamos nada de tu cuenta.</p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pctDone)}"><i style="width:${pctDone}%"></i></div>
    <div class="small"><b>${esc(detail)}</b></div>
    ${state.error ? `<div class="notice notice-warn" style="margin-top:12px;text-align:left">${I.info}<div>${esc(state.error)} Seguimos intentando…</div></div>` : ''}
    <ul class="checklist">${STEPS.map(([k, l], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${i < idx ? I.checkCircle : i === idx ? I.loader.replace('<svg', '<svg class="spin"') : I.circle} ${l}</li>`).join('')}</ul>
  </div></div></div>`;
  hydrateIcons($app);
}

const CONNECT_LIMIT_MS = 4 * 60000;

function connectingFailed(msg, canShow) {
  $app.innerHTML = `<div class="progress-page"><div class="wrap"><div class="card progress-card" role="alert">
    <a class="logo" href="/"><span class="logo-mark" data-logo></span>Rinde<span class="dot">.</span></a>
    <h1 style="font-size:1.4rem;margin-top:16px">No pudimos terminar el diagnóstico</h1>
    <div class="notice notice-warn" style="margin:12px 0">${I.alert}<div>${esc(msg)} Tus datos no se pierden: lo que ya leímos queda guardado.</div></div>
    <div class="help-links"><button class="btn btn-primary" id="c-retry">${I.refresh} Reintentar</button>${canShow ? '<button class="btn btn-light" id="c-show">Ver lo que ya tenemos</button>' : ''}</div>
    <p class="tiny muted" style="margin-top:12px">Si vuelve a pasar, escribinos por <a href="${waLink('help')}" target="_blank" rel="noopener">WhatsApp</a>.</p>
  </div></div></div>`;
  hydrateIcons($app);
  document.getElementById('c-retry').addEventListener('click', () => runConnecting(false));
  document.getElementById('c-show')?.addEventListener('click', () => { location.hash = '#/diagnostico'; loadReal().catch((e) => errorView(e.message)); });
}

async function runConnecting(force = false) {
  const run = { ended: false };
  S.connectRun = run;
  location.hash = '#/conectando';
  connectingView();
  const t0 = Date.now();
  const late = () => Date.now() - t0 > CONNECT_LIMIT_MS;
  const finish = async () => {
    if (run.ended || S.connectRun !== run) return;
    run.ended = true;
    clearInterval(watch);
    document.removeEventListener('visibilitychange', onVisible);
    location.hash = '#/diagnostico';
    try { await loadReal(); } catch (e) { errorView(e.message); }
  };
  const fail = (msg, canShow = false) => {
    if (run.ended || S.connectRun !== run) return;
    run.ended = true;
    clearInterval(watch);
    document.removeEventListener('visibilitychange', onVisible);
    connectingFailed(msg, canShow);
  };
  // Control en paralelo: si el diagnóstico ya quedó guardado, lo mostramos aunque algún pedido se haya colgado.
  const check = async () => {
    if (run.ended) return;
    try {
      const me = await api('/api/me', { timeout: 10000 });
      if (me.sync?.status === 'done' && me.diagnosis && new Date(me.diagnosis.created_at) >= new Date(t0 - 5000)) finish();
      else if (late()) fail('Esto está tardando más de lo normal.', !!me.diagnosis);
    } catch (e) {
      if (e.status === 401) { run.ended = true; location.href = '/?error=sesion'; }
      else if (late()) fail('Esto está tardando más de lo normal.');
    }
  };
  const watch = setInterval(check, 8000);
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  document.addEventListener('visibilitychange', onVisible);

  let failures = 0;
  let first = true;
  // 1) Sincronización
  while (!run.ended) {
    if (late()) return fail('Mercado Libre está tardando más de lo normal en responder.');
    try {
      const { sync } = await api('/api/sync', { method: 'POST', body: first ? { start: true, force } : {}, timeout: 70000 });
      if (run.ended) return;
      first = false;
      failures = 0;
      connectingView(sync);
      if (sync.status === 'done') break;
      if (sync.status === 'error') throw new Error(sync.error || 'Mercado Libre no respondió.');
    } catch (e) {
      if (run.ended) return;
      if (e.status === 401) { run.ended = true; location.href = '/?error=sesion'; return; }
      if (e.status === 402) { toast(e.message); break; }
      failures++;
      connectingView({ phase: 'items', done: 0, total: 0, error: e.message });
      if (failures > 4) return fail(e.message);
      await new Promise((r) => setTimeout(r, 2500 * failures));
    }
  }
  // 2) Planes con IA + resumen
  let aiTotal = 0;
  let aiDone = 0;
  failures = 0;
  for (let guard = 0; guard < 60 && !run.ended; guard++) {
    if (late()) break;
    try {
      const r = await api('/api/diagnosis', { method: 'POST', timeout: 70000 });
      if (run.ended) return;
      if (r.done) break;
      aiDone += r.analyzed || 0;
      aiTotal = Math.max(aiTotal, aiDone + (r.remaining || 0));
      connectingView({ phase: 'ai', aiDone, aiTotal });
    } catch (e) {
      if (run.ended) return;
      if (e.status === 402) break;
      if (e.status === 401) { run.ended = true; location.href = '/?error=sesion'; return; }
      failures++;
      if (failures > 3) break; // si la IA falla, mostramos el diagnóstico por reglas igual
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await finish();
}

// ─────────────────────────────── Eventos ───────────────────────────────────
function bind(route) {
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    render();
    document.querySelector('.cat-filter')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.getElementById('disconnect')?.addEventListener('click', async () => {
    if (!confirm('¿Desconectar tu cuenta? Borramos tus accesos y todos tus datos de Rinde. Esta acción no se puede deshacer.')) return;
    try { await api('/api/auth/disconnect', { method: 'POST' }); location.href = '/?desconectado=1'; } catch (e) { toast(e.message); }
  });
  document.getElementById('regen')?.addEventListener('click', () => {
    if (DEMO) { toast('En el demo los datos son fijos. Con tu cuenta, esto vuelve a leer todo desde Mercado Libre.'); return; }
    runConnecting(true);
  });

  if (route === 'rentabilidad' && (DEMO || S.paid)) {
    document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.sort;
      S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === 'title' ? 1 : -1 };
      render();
    }));
    document.getElementById('msort')?.addEventListener('change', (e) => { S.sort = { key: e.target.value, dir: e.target.value === 'title' ? 1 : -1 }; render(); });
    document.querySelectorAll('input[data-cost]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.cost;
      S.dirtyCosts[k] = { ...(S.dirtyCosts[k] || {}), [inp.dataset.f]: inp.value };
      // sincronizar el gemelo (tabla/tarjeta)
      document.querySelectorAll(`input[data-cost="${CSS.escape(k)}"][data-f="${inp.dataset.f}"]`).forEach((o) => { if (o !== inp) o.value = inp.value; });
      document.getElementById('save-costs').disabled = false;
    }));
    document.getElementById('save-costs')?.addEventListener('click', saveCosts);
    document.getElementById('tpl')?.addEventListener('click', downloadTemplate);
    document.getElementById('file')?.addEventListener('change', uploadCosts);
    document.getElementById('save-ads')?.addEventListener('click', saveAds);
  }
  if (route === 'alertas' && (DEMO || S.paid)) {
    document.getElementById('alert-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { alert_email: document.getElementById('al-email').value, alerts_enabled: document.getElementById('al-daily').checked, weekly_enabled: document.getElementById('al-weekly').checked };
      if (DEMO) { Object.assign(S.user, body); return toast('Guardado (demo).'); }
      try { await api('/api/settings', { method: 'POST', body }); Object.assign(S.user, body); toast('Listo, guardamos tu configuración.'); } catch (er) { toast(er.message); }
    });
    document.getElementById('al-test')?.addEventListener('click', async () => {
      if (DEMO) return toast('En el demo no mandamos emails. Mirá la vista previa.');
      try { await api('/api/settings', { method: 'POST', body: { action: 'test' } }); toast('Te mandamos un email de prueba.'); } catch (er) { toast(er.message); }
    });
  }
}

const parseNum = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/\$/g, '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

async function applyCosts(list) {
  const bad = list.filter((c) => Number.isNaN(parseNum(c.purchase)) || Number.isNaN(parseNum(c.replacement)));
  if (bad.length) { toast(`Revisá estos SKU: ${bad.slice(0, 3).map((b) => b.sku).join(', ')} (montos inválidos).`); return false; }
  if (DEMO) {
    for (const c of list) {
      const p = parseNum(c.purchase), r = parseNum(c.replacement);
      if (p == null && r == null) delete S.demoData.costs[c.sku];
      else S.demoData.costs[c.sku] = { purchase: p, replacement: r };
    }
    S.model = buildModel(S.demoData);
    S.summary = buildRuleSummary(S.model);
    return true;
  }
  try {
    await api('/api/profit', { method: 'POST', body: { type: 'costs', costs: list.map((c) => ({ sku: c.sku, purchase: parseNum(c.purchase), replacement: parseNum(c.replacement) })) } });
    await loadReal();
    return true;
  } catch (e) { toast(e.message); return false; }
}

async function saveCosts() {
  const current = Object.fromEntries(S.model.rows.map((r) => [costKey(r.it), r.cost || {}]));
  const list = Object.entries(S.dirtyCosts).map(([sku, v]) => ({ sku, purchase: v.purchase ?? current[sku]?.purchase ?? '', replacement: v.replacement ?? current[sku]?.replacement ?? '' }));
  if (await applyCosts(list)) { S.dirtyCosts = {}; toast('Costos guardados. Recalculamos tu rentabilidad.'); render(); }
}

function downloadTemplate() {
  if (!DEMO) { location.href = '/api/profit?format=csv'; return; }
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['sku;titulo;costo_compra;costo_reposicion_hoy', ...S.model.rows.map((r) => [q(costKey(r.it)), q(r.it.title), r.cost?.purchase ?? '', r.cost?.replacement ?? ''].join(';'))];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'rinde-costos.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') inQ = false; else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function uploadCosts(e) {
  const f = e.target.files[0];
  const msg = document.getElementById('upload-msg');
  if (!f) return;
  msg.textContent = 'Leyendo archivo…';
  try {
    let rows;
    if (/\.xlsx?$/i.test(f.name)) {
      if (!window.XLSX) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('No pudimos abrir el Excel. Guardalo como CSV y subilo de nuevo.')); document.head.appendChild(s); });
      const wb = window.XLSX.read(await f.arrayBuffer());
      rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }).map((r) => r.map((c) => String(c ?? '')));
    } else {
      rows = parseCsv((await f.text()).replace(/^﻿/, ''));
    }
    const head = rows[0].map((h) => h.toLowerCase().trim());
    const iS = head.findIndex((h) => h.includes('sku'));
    const iP = head.findIndex((h) => h.includes('compra'));
    const iR = head.findIndex((h) => h.includes('reposic'));
    if (iS < 0 || iP < 0) throw new Error('La planilla tiene que tener las columnas "sku" y "costo_compra". Usá la plantilla.');
    const list = rows.slice(1).filter((r) => r[iS]?.trim()).map((r) => ({ sku: r[iS].trim(), purchase: r[iP] ?? '', replacement: iR >= 0 ? r[iR] ?? '' : '' }));
    if (await applyCosts(list)) { toast(`Cargamos ${list.length} costos.`); render(); }
    else msg.textContent = '';
  } catch (er) {
    msg.innerHTML = `<span class="tag tag-bad">${I.alert} ${esc(er.message)}</span>`;
  }
}

async function saveAds() {
  const a = parseNum(document.getElementById('ads-ml').value);
  const m = parseNum(document.getElementById('ads-meta').value);
  if (Number.isNaN(a) || Number.isNaN(m)) return toast('Revisá los montos de publicidad.');
  if (DEMO) {
    S.demoData.settings.ads_manual_monthly = a || 0;
    S.demoData.settings.meta_ads_monthly = m || 0;
    S.settings = S.demoData.settings;
    S.model = buildModel(S.demoData);
    render();
    return toast('Publicidad actualizada (demo).');
  }
  try { await api('/api/profit', { method: 'POST', body: { type: 'ads', ads_manual_monthly: a, meta_ads_monthly: m } }); await loadReal(); toast('Publicidad guardada.'); } catch (e) { toast(e.message); }
}

// ─────────────────────────────── Arranque ──────────────────────────────────
async function loadReal() {
  const d = await api('/api/diagnosis');
  S.user = d.user;
  S.paid = d.paid;
  S.model = d.model;
  S.summary = d.summary;
  S.syncedAt = d.syncedAt;
  S.settings = d.settings || {};
  S.productAds = d.productAds;
  if (S.paid) api('/api/settings').then((x) => { S.history = x.history; if (currentRoute() === 'alertas') render(); }).catch(() => {});
  render();
}

async function boot() {
  if (DEMO) {
    const { getDemoData } = await import('../shared/demo-data.js');
    S.demoData = getDemoData();
    if (new URLSearchParams(location.search).has('sinventas')) {
      S.demoData.lines = [];
      S.demoData.items.forEach((it) => { it.sales30 = 0; it.sales90 = 0; });
    }
    if (new URLSearchParams(location.search).has('sincostos')) S.demoData.costs = {};
    S.model = buildModel(S.demoData);
    S.summary = buildRuleSummary(S.model);
    S.user = { nickname: S.demoData.seller.nickname, ...S.demoData.settings, can_regenerate: true };
    S.paid = true;
    S.syncedAt = S.demoData.syncedAt;
    S.settings = S.demoData.settings;
    render();
    return;
  }
  try {
    const me = await api('/api/me');
    S.user = me.user;
    S.paid = me.user.plan === 'rinde';
    const ready = me.sync?.status === 'done' && me.diagnosis;
    if (!ready || currentRoute() === 'conectando') {
      if (me.sync?.status === 'done' && !S.user.can_regenerate && me.diagnosis) return loadReal();
      return runConnecting(false);
    }
    await loadReal();
  } catch (e) {
    if (e.status === 401) { location.href = '/?error=sesion'; return; }
    if (e.code === 'not_ready') return runConnecting(false);
    errorView(e.message);
  }
}

window.addEventListener('hashchange', () => { if (S.model && currentRoute() !== 'conectando') render(); });
boot();
