// Rinde — app (diagnóstico, rentabilidad, alertas). Funciona en modo real (/app) y DEMO (/demo).
import { I, hydrateIcons } from './icons.js';
import { CATEGORIES, GROUPS, THRESHOLDS, waLink, PLAN_PRICE_ARS, EMAIL_ENABLED, COPY } from '../shared/config.js';
import { fmtMoney, fmtPct, conversion, LISTING_LABEL, ALERT_LABELS, competitorRef, priceGap, groupLabel, opState } from '../shared/rules.js';
import { evaluateAll, summarize, actionsByItem, splitIdle, campaignStateText, feeKey, feeFromHistory } from '../shared/campaigns.js';
import { simSources, scenarios, simulate, trialBudget, SIM_NOTE } from '../shared/simulator.js';
import { accountConversion } from '../shared/score.js';
import { regenState, planChanged } from '../shared/plans.js';
import { scoreAllows, conflictOf } from '../shared/plan-guard.js';
const MIN_VISITS_CONV = 30; // igual que la nota: con menos visitas la conversión no dice nada
import { getCampaignsDemo } from '../shared/campaigns-demo.js';
import { buildModel, buildRuleSummary, costKey } from '../shared/model.js';
import { saleRows, itemStates, searchItems } from '../shared/item-detail.js';
import { sourceOf, ruleSuggestion, NOTE_FIXED, SUGGEST_LIMITS } from '../shared/suggest.js';
import { SEASONS } from '../shared/config.js';

const DEMO = location.pathname.startsWith('/demo') || new URLSearchParams(location.search).has('demo');
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TONE_TAG = { bad: 'tag-bad', warn: 'tag-warn', ok: 'tag-ok', neutral: 'tag-neutral' };

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
  item: {},      // por publicación: { sales, suggestion, usage, loading, error }
  sugg: {},      // estado de la sugerencia por publicación: { loading, error }
  back: null,    // pantalla desde la que se abrió el detalle (para "Volver")
  scroll: {},    // posición de scroll por pantalla
  demoSugg: 0,   // demo: sugerencias generadas hoy
};

// ─────────────────────────────── API ───────────────────────────────────────
async function api(path, opts = {}) {
  const { timeout = 50000, ...rest } = opts;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Rinde-Page': (location.pathname + location.hash).slice(0, 200) }, ...rest, body: rest.body ? JSON.stringify(rest.body) : undefined, signal: ctl.signal });
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
function catTag(key, it = null) {
  const c = GROUPS[key] || CATEGORIES[key];
  const real = groupLabel(key, it); // "Abandonada · sin stock": el estado real siempre a la vista
  return `<span class="tag ${TONE_TAG[real ? 'bad' : c.tone]}">${I[real ? 'alert' : c.icon]} ${esc(real || c.label)}</span>`;
}
/** Debajo de la tarjeta de un grupo: cuántas están además sin stock o pausadas. */
function tileStates(key) {
  // "Sin stock 0" no puede contradecir a Alertas: si hay abandonadas o de temporada sin stock/pausadas, se dice acá.
  const OTHER = { SIN_STOCK: 'sin stock', PAUSADAS: 'pausada' };
  if (OTHER[key]) {
    const k = S.model.rows.filter((r) => ['ABANDONADAS', 'TEMPORADA'].includes(r.group) && opState(r.it) === OTHER[key]).length;
    return k ? `<span class="tile-sub">y ${k} abandonada${k === 1 ? '' : 's'} o de temporada ${OTHER[key] === 'pausada' ? (k === 1 ? 'pausada' : 'pausadas') : 'sin stock'}</span>` : '';
  }
  if (!['ABANDONADAS', 'TEMPORADA'].includes(key)) return '';
  const n = {};
  for (const r of S.model.rows) if (r.group === key) { const st = opState(r.it); if (st) n[st] = (n[st] || 0) + 1; }
  const txt = Object.entries(n).map(([k, v]) => `${v} ${k === 'pausada' && v > 1 ? 'pausadas' : k}`).join(' · ');
  return txt ? `<span class="tile-sub">${esc(txt)}</span>` : '';
}
const shipLabel = (it) => (it.shipping?.logistic === 'fulfillment' ? 'Full' : it.shipping?.flex ? 'Flex' : 'Normal');
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
  const unread = (S.unread || []).length;
  const tab = (r, icon, label) => `<a href="#/${r}" ${route === r ? 'aria-current="page"' : ''}>${I[icon]}<span>${label}${r === 'alertas' && unread ? ` <span class="badge-count" aria-label="${unread} alertas nuevas">${unread}</span>` : ''}</span></a>`;
  const tabs = `<nav class="tabs" aria-label="Secciones de la app">${tab('diagnostico', 'search', 'Diagnóstico')}${tab('publicaciones', 'list', 'Publicaciones')}${tab('campanas', 'tag', 'Campañas')}${tab('rentabilidad', 'money', 'Rentabilidad')}${tab('alertas', 'bell', 'Alertas')}</nav>`;
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
        <button class="btn btn-ghost btn-sm btn-block" id="disconnect">${I.logout} Desconectar Mercado Libre</button>
        <button class="btn btn-ghost btn-sm btn-block" style="color:var(--bad)" id="delete-data">${I.trash} Borrar todos mis datos</button>`}
      </div>
    </details>
  </div></header>
  <div class="mobile-tabs">${tabs.replace('class="tabs"', 'class="tabs mobile-nav"')}</div>`;
}

function currentRoute() {
  const r = (location.hash || '#/diagnostico').replace('#/', '').split('?')[0];
  if (/^publicacion\/[A-Za-z0-9]+$/.test(r)) return 'publicacion';
  return ['diagnostico', 'publicaciones', 'campanas', 'rentabilidad', 'alertas', 'conectando'].includes(r) ? r : 'diagnostico';
}
const routeItemId = () => ((location.hash.match(/^#\/publicacion\/([A-Za-z0-9]+)/) || [])[1] || '').toUpperCase();
const routeParam = (k) => new URLSearchParams((location.hash.split('?')[1]) || '').get(k);
/** Link al detalle de una publicación de la cuenta (o a Mercado Libre si no está en el diagnóstico). */
function itemLink(id, title, cls = '') {
  const inModel = id && S.model?.rows?.some((r) => r.it.id === id);
  if (inModel) return `<a class="ilink ${cls}" href="#/publicacion/${esc(id)}">${esc(title)}</a>`;
  const r = S.model?.rows?.find((x) => x.it.id === id);
  const pl = r?.it.permalink;
  return pl && pl !== '#' ? `<a class="${cls}" href="${esc(pl)}" target="_blank" rel="noopener">${esc(title)}</a>` : esc(title);
}
function searchBox() {
  return `<div class="isearch" role="search"><label class="sr" for="qpub">Buscá una publicación</label>
    <span class="isearch-ico" aria-hidden="true">${I.search}</span>
    <input id="qpub" type="search" autocomplete="off" placeholder="Buscá una publicación (título o número MLA)" aria-controls="qpub-res" aria-expanded="false">
    <ul id="qpub-res" class="isearch-res" role="listbox" hidden></ul></div>`;
}

function connectionBanner() {
  const c = S.user?.connection;
  if (DEMO || !c?.connected || c.renewable) return '';
  const h = c.hours_left;
  const when = h < 1 ? 'en menos de una hora' : `en ${Math.round(h)} hora${Math.round(h) === 1 ? '' : 's'}`;
  return c.expired
    ? `<div class="wrap" style="padding-top:14px"><div class="notice notice-bad" role="alert">${I.alert}<div><b>Tu conexión con Mercado Libre venció.</b> Rinde no puede leer tu cuenta (ni mandarte alertas) hasta que vuelvas a conectar. Tus datos siguen guardados. <a href="/api/auth/login?next=/app">Volver a conectar</a></div></div></div>`
    : `<div class="wrap" style="padding-top:14px"><div class="notice notice-warn">${I.info}<div><b>Tu conexión vence ${when}, volvé a conectar</b> para que Rinde pueda seguir leyendo tu cuenta y mandarte alertas. <a href="/api/auth/login?next=/app">Volver a conectar</a></div></div></div>`;
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
  else if (route === 'publicaciones') body = listingsView();
  else if (route === 'campanas') body = campaignsView();
  else if (route === 'alertas') body = alertsView();
  else if (route === 'publicacion') body = detailView(routeItemId());
  else body = diagnosisView();
  $app.innerHTML = header() + connectionBanner() + billingBanner() + `<main class="wrap${route === 'rentabilidad' ? ' wide' : ''}">${searchBox()}${body}</main>
  <footer class="footer"><div class="wrap"><span>Rinde · un servicio de Innovasmart · solo lectura: nunca modificamos tu cuenta.</span><span><a href="/privacidad">Privacidad</a> · <a href="/terminos">Términos</a></span></div></footer>`;
  hydrateIcons($app);
  bind(route);
  bindSearch();
  if (S.scroll[location.hash] != null) { window.scrollTo(0, S.scroll[location.hash]); }
  else if (route === 'publicacion') window.scrollTo(0, 0);
}

// ─────────────────────────────── Diagnóstico ───────────────────────────────
function sortedRows() {
  return [...S.model.rows].sort((a, b) => GROUPS[a.group].order - GROUPS[b.group].order || (b.lost + Math.max(0, -(b.profit.net || 0))) - (a.lost + Math.max(0, -(a.profit.net || 0))));
}

function diagnosisView() {
  const m = S.model;
  const sum = S.summary || buildRuleSummary(m);
  const { canRegen, showFreeUsed } = regenState({ demo: DEMO, paid: S.paid, user: S.user });
  const total = m.rows.length;
  const noCosts = m.hasAnyCost === false;
  // Tarjetas = los mismos grupos que la lista; cada publicación en uno solo, suman el total.
  const gc = m.groupCounts;
  const shown = Object.values(GROUPS).filter((c) => !(c.hideEmpty && !gc[c.key]));
  const tiles = shown.map((c) => (c.key === 'PIERDE_PLATA' && noCosts)
    ? `<a class="cat-tile ${c.tone} is-pending" href="#/rentabilidad" aria-label="Pierde plata: cargá tus costos para calcularlo"><span class="n n-text">Cargá tus costos para calcularlo</span><span class="l">${I[c.icon]} ${esc(c.short)}</span></a>`
    : `<button class="cat-tile ${c.tone}" data-filter="${c.key}" aria-label="Filtrar ${esc(c.label)}: ${gc[c.key]}"><span class="n">${gc[c.key]}</span><span class="l">${I[c.icon]} ${esc(c.short)}</span>${tileStates(c.key)}</button>`).join('');
  const chips = [['TODAS', 'Todas', total, 'search'], ...shown.filter((c) => !(c.key === 'PIERDE_PLATA' && noCosts)).map((c) => [c.key, c.short, gc[c.key], c.icon])]
    .map(([k, l, n, ic]) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${I[ic]} ${esc(l)} <span class="count">${n}</span></button>`).join('');
  const rows = sortedRows().filter((r) => S.filter === 'TODAS' || r.group === S.filter);

  return `
  <div class="page-head">
    <div><h1>Diagnóstico de tu cuenta</h1><div class="small muted">${total} publicaciones activas y pausadas · datos ${ago(S.syncedAt)}</div></div>
    ${canRegen
      ? `<button class="btn btn-light btn-sm" id="regen">${I.refresh} ${DEMO ? 'Regenerar (demo)' : 'Actualizar diagnóstico'}</button>`
      : `<a class="btn btn-light btn-sm" href="/suscribirme">${I.lock} Regenerar con Plan Rinde</a>`}
  </div>
  ${showFreeUsed ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Ya usaste tu diagnóstico gratis: podés verlo siempre. Para actualizarlo cuando cambies algo, <a href="/suscribirme">suscribite al Plan Rinde</a>.</div></div>` : ''}
  ${alertsBox()}
  ${campaignsNotice()}
  ${seasonBox(m)}
  <div class="diag-grid">
    <section class="summary-card" aria-labelledby="sum-h">
      <div class="label">Resumen de la cuenta · ${total} publicaciones</div>
      <h2 id="sum-h">${esc(sum.headline)}</h2>
      ${sum.revenueNote ? `<div class="rev-note">${esc(sum.revenueNote)}</div>` : ''}
      ${sum.startPlan ? `<div class="start-plan"><b>Plan para arrancar a vender</b><ol>${sum.startPlan.map((x) => `<li><b>${esc(x.label)}.</b> <span>${esc(x.detail)}</span>${topList(x.top)}</li>`).join('')}</ol></div>` : ''}
      <div class="problems">${(sum.problems || []).map((p) => problemBlock(p)).join('') || (!sum.selling || sum.selling === 'vende' ? '<div class="problem"><b>Sin problemas graves</b><span>Tu cuenta está sana.</span></div>' : '')}</div>
      ${sum.seasonal ? `<div class="problems problems-extra">${problemBlock(sum.seasonal, 'De temporada')}</div>` : ''}
      ${sum.abandoned ? `<div class="problems problems-extra">${problemBlock(sum.abandoned, 'Abandonadas')}</div>` : ''}
      ${sum.shipNote ? `<p class="tip-line">${I.truck || I.info} ${esc(sum.shipNote)}</p>` : ''}
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
  ${shipSection()}
  <h2 style="margin:30px 0 10px;font-size:1.4rem">Publicaciones</h2>
  <div class="cat-filter" role="toolbar" aria-label="Filtrar por categoría">${chips}</div>
  <div class="items">${rows.map(itemCard).join('') || '<div class="empty">No hay publicaciones en esta categoría.</div>'}</div>`;
}

const SHIP_TAG = { ya: ['tag-ok', 'Ya tiene'], conviene: ['tag-accent', 'Conviene'], falta: ['tag-neutral', 'Todavía no'], no_conviene: ['tag-warn', 'No conviene'], no_aplica: ['tag-neutral', 'No aplica'] };
const shipTag = (st) => `<span class="tag ${SHIP_TAG[st.state][0]}" style="padding:0 7px">${SHIP_TAG[st.state][1]}</span>`;
function shipLines(ss) {
  return `<div class="ship-line"><b>Full</b> ${shipTag(ss.full)} <span class="small">${esc(ss.full.text)}</span></div><div class="ship-line"><b>Flex</b> ${shipTag(ss.flex)} <span class="small">${esc(ss.flex.text)}</span></div>`;
}
/** Diagnóstico: Full y Flex de todas las publicaciones, aunque ninguna califique. */
function shipSection() {
  const rows = S.model.rows.filter((r) => r.shipStatus);
  if (!rows.length) return '';
  const c = (k, st) => rows.filter((r) => r.shipStatus[k].state === st).length;
  const order = { conviene: 0, no_conviene: 1, falta: 2, ya: 3, no_aplica: 4 };
  const sorted = [...rows].sort((a, b) => order[a.shipStatus.full.state] - order[b.shipStatus.full.state] || (b.it.sales90 || 0) - (a.it.sales90 || 0));
  const head = [c('full', 'conviene') && `${c('full', 'conviene')} para pasar a Full`, c('flex', 'conviene') && `${c('flex', 'conviene')} para sumar Flex`, c('full', 'ya') && `${c('full', 'ya')} ya en Full`, c('flex', 'ya') && `${c('flex', 'ya')} con Flex`].filter(Boolean).join(' · ') || 'Ninguna califica todavía para Full ni Flex';
  return `<section class="card ship-sec" aria-labelledby="ship-h" style="margin-top:18px">
    <h2 id="ship-h" style="margin:0 0 4px;font-size:1.2rem">${I.truck || I.info} Full y Flex</h2>
    <p class="small" style="margin:0 0 8px"><b>${esc(head)}.</b> Full: vender 2 por semana en 4 de las últimas 6 semanas y tener stock para 4 semanas. Flex: 1 por semana en 4 de 6, en AMBA.</p>
    <details><summary class="small">Ver el estado de cada publicación (${rows.length})</summary>
      <ul class="ship-list">${sorted.map((r) => `<li><div>${itemLink(r.it.id, r.it.title)} <span class="tiny muted">· ${esc(shipLabel(r.it))}</span></div>${shipLines(r.shipStatus)}</li>`).join('')}</ul>
    </details></section>`;
}

function topList(top) {
  if (!top?.length) return '';
  const lis = top.map((t) => t.more
    ? `<li class="more">y ${t.more} más</li>`
    : `<li>${itemLink(t.id, t.title)} <span class="sold">${t.sold ? `${t.sold} vendida${t.sold === 1 ? '' : 's'} en 6 meses` : 'sin ventas en 6 meses'}</span></li>`).join('');
  return `<ol class="top-items">${lis}</ol>`;
}

function problemBlock(p, tag) {
  return `<div class="problem${tag ? ' problem-tag' : ''}">${tag ? `<span class="ptag">${esc(tag)}</span>` : ''}<b>${esc(p.label)}</b><span>${esc(p.detail)}${p.fix ? ` — ${esc(p.fix)}` : ''}</span>${topList(p.top)}</div>`;
}


// ─────────────────────────────── Campañas y publicidad ─────────────────────
const PROMO_TYPE = { DEAL: 'Campaña tradicional', MARKETPLACE_CAMPAIGN: 'Campaña de Mercado Libre', SMART: 'Co-fondeada', PRICE_MATCHING: 'Precio competitivo', DOD: 'Oferta del día', LIGHTNING: 'Oferta relámpago', VOLUME: 'Descuento por cantidad', SELLER_CAMPAIGN: 'Campaña tuya', SELLER_COUPON_CAMPAIGN: 'Cupón', PRE_NEGOTIATED: 'Pre-negociada', UNHEALTHY_STOCK: 'Stock sin rotación', PRICE_DISCOUNT: 'Descuento' };
const VERDICT_TAG = { conviene: 'tag-ok', conviene_si: 'tag-warn', no_conviene: 'tag-bad', no_ahora: 'tag-neutral', apagar: 'tag-bad', bajar: 'tag-warn', ok: 'tag-ok', subir: 'tag-ok' };
const pctTxt = (n) => (n == null ? '—' : Math.round(n * 100) + ' %');

function loadCampaigns(force = false) {
  if (S.camp && !force) return;
  if (DEMO || !S.paid) {
    S.camp = { ...getCampaignsDemo(), preview: !DEMO && !S.paid };
    if (DEMO && new URLSearchParams(location.search).has('singasto')) {
      // Variante: campaña pausada y avisos que no gastaron en 30 días.
      S.camp.ads = S.camp.ads.map((a) => (a.noMetrics ? a : { ...a, cost: 0, direct_amount: 0, indirect_amount: 0, total_amount: 0, direct_units: 0, indirect_units: 0, clicks: 0 }));
      S.camp.adsInfo = { campaigns: [{ id: 1, name: 'Campaña Libros', status: 'paused', metrics: { cost: 0, total_amount: 0, clicks: 0, missing: [] } }] };
    }
    return;
  }
  S.camp = { loading: true };
  api(`/api/campaigns${force ? '?refresh=1' : ''}`, { timeout: 70000 }).then((d) => { S.camp = d; if (currentRoute() === 'campanas') render(); })
    .catch((e) => { S.camp = { error: e.message }; if (currentRoute() === 'campanas') render(); });
}

function costInput(it, key) {
  return `<form class="camp-cost" data-sku="${esc(it.sku || key)}"><label class="small" for="cc-${esc(key)}">Costo del producto</label><input id="cc-${esc(key)}" inputmode="decimal" placeholder="$ por unidad" value="${it.cost ?? ''}"><button class="btn btn-light btn-sm" type="submit">Guardar</button></form>`;
}

const MISSING_LABEL = { cost: 'gasto', clicks: 'clics', prints: 'impresiones', total_amount: 'ventas atribuidas', direct_amount: 'ventas directas', indirect_amount: 'ventas indirectas' };
const FEE_SRC = { meli: 'según Mercado Libre para este precio', historial: 'según lo que esta publicación pagó antes' };
// Detalle de los cargos de MeLi: componentes, de dónde salen y el rango si las fuentes no coinciden.
function chargesDetail(ch) {
  const parts = [`comisión ${fmtMoney(ch.commission)}`];
  if (ch.fixed) parts.push(`fijo ${fmtMoney(ch.fixed)}`);
  if (ch.financing) parts.push(`cuotas ${fmtMoney(ch.financing)}${ch.financingWorst ? ' (el caso más caro)' : ''}`);
  if (ch.shipping) parts.push(`envío ${fmtMoney(ch.shipping)}`);
  if (ch.taxes) parts.push(`retenciones ${fmtMoney(ch.taxes)}`);
  const range = ch.range ? `<span class="tiny"><span class="camp-range">Cargos de MeLi entre ${fmtMoney(ch.range.low)} y ${fmtMoney(ch.range.high)}</span> (${esc(FEE_SRC[ch.range.lowSource] || '')} / ${esc(FEE_SRC[ch.range.highSource] || '')}). Para el veredicto usamos el más alto.</span>` : '';
  return `<span class="tiny">${esc(FEE_SRC[ch.source] || 'según Mercado Libre')} · ${parts.join(' · ')}</span>${range}`;
}

const campTitle = (x) => itemLink(x.item_id, x.item?.title || x.item_id);
function promoCard(o, e, key) {
  const it = o.item;
  const hasCost = e.cost != null;
  if (e.noFees) {
    return `<article class="camp-card">
      <div class="camp-top"><div class="camp-title">${campTitle(o)}</div><span class="tag tag-neutral">Sin veredicto</span></div>
      <div class="tiny muted">${esc(PROMO_TYPE[o.type] || o.type)} · ${esc(o.name)} · ${o.status === 'started' ? 'activa' : 'te la ofrecen'}</div>
      <div class="camp-grid"><div><span>Precio</span><b>${fmtMoney(o.price_today)} → ${fmtMoney(o.promo_price)}</b></div></div>
      <p class="small" style="margin:6px 0 0">${esc(e.note)}</p>
    </article>`;
  }
  const quedan = (x) => fmtMoney(hasCost ? x.profit : x.beforeCost);
  return `<article class="camp-card">
    <div class="camp-top"><div class="camp-title">${campTitle(o)}</div>${e.label ? `<span class="tag ${VERDICT_TAG[e.verdict] || 'tag-neutral'}">${esc(e.label)}</span>` : `<span class="tag tag-neutral">${e.noFees ? 'Sin veredicto' : 'Sin veredicto: falta el costo'}</span>`}</div>
    <div class="tiny muted">${esc(PROMO_TYPE[o.type] || o.type)} · ${esc(o.name)} · ${o.status === 'started' ? 'activa' : 'te la ofrecen'}${e.contribution ? ` · Mercado Libre aporta ${fmtMoney(e.contribution)} por venta` : ''}</div>
    <div class="camp-grid">
      <div><span>Precio</span><b>${fmtMoney(o.price_today)} → ${fmtMoney(o.promo_price)}</b></div>
      <div><span>Te queda por venta${hasCost ? '' : ' (antes del costo)'}</span><b>${quedan(e.today)} → <span class="${(hasCost ? e.promo.profit : e.promo.beforeCost) < 0 ? 'neg' : ''}">${quedan(e.promo)}</span></b></div>
      <div><span>Para ganar lo mismo que hoy</span><b>${e.moreSales == null ? (hasCost && e.promo.profit <= 0 ? 'no alcanza: perdés por venta' : hasCost ? '—' : 'cargá el costo para saberlo') : e.moreSales === 0 ? 'no hace falta vender más' : `necesitás vender un ${pctTxt(e.moreSales)} más`}</b></div>
      <div class="camp-wide"><span>Cargos con la promo</span><b>${fmtMoney(e.promo.charges.total)}</b>${chargesDetail(e.promo.charges)}</div>
    </div>
    ${e.crossings.length ? `<ul class="camp-notes">${e.crossings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${e.note ? `<p class="small muted" style="margin:6px 0 0">${esc(e.note)}</p>` : ''}
    ${costInput(it, key)}
  </article>`;
}

function adsCardNoMetrics(a) {
  const it = a.item;
  return `<article class="camp-card">
    <div class="camp-top"><div class="camp-title">${campTitle(a)}</div><span class="tag tag-neutral">Sin métricas</span></div>
    <div class="tiny muted">${esc(a.campaign || 'Product Ads')}${a.status ? ` · ${esc(a.status === 'active' ? 'activa' : a.status)}` : ''}</div>
    <p class="small" style="margin:6px 0 0">Mercado Libre no devolvió las métricas de este aviso (faltan: ${esc((a.metricsMissing || []).map((k) => MISSING_LABEL[k] || k).join(', '))}). No mostramos ceros ni damos veredicto.</p>
  </article>`;
}

function adsCard(a, e, key) {
  const it = a.item;
  const split = a.direct_amount != null && a.indirect_amount != null;
  return `<article class="camp-card">
    <div class="camp-top"><div class="camp-title">${campTitle(a)}</div>${e.label ? `<span class="tag ${VERDICT_TAG[e.verdict] || 'tag-neutral'}">${esc(e.label)}</span>` : `<span class="tag tag-neutral">${e.noFees ? 'Sin veredicto' : 'Sin veredicto: falta el costo'}</span>`}</div>
    <div class="tiny muted">${esc(a.campaign || 'Product Ads')} · últimos 30 días según Mercado Libre</div>
    <div class="camp-grid">
      <div><span>Gasto</span><b>${fmtMoney(a.cost)}</b></div>
      <div><span>Ventas atribuidas</span><b>${fmtMoney(e.sales)}</b><span class="tiny">${split ? `directas ${fmtMoney(a.direct_amount)}${a.direct_units != null ? ` (${a.direct_units} u)` : ''} · indirectas ${fmtMoney(a.indirect_amount)}${a.indirect_units != null ? ` (${a.indirect_units} u)` : ''}` : 'Mercado Libre no separó directas e indirectas'}</span></div>
      ${a.clicks != null && a.prints != null ? `<div><span>Clics / impresiones</span><b>${a.clicks} / ${a.prints}</b></div>` : a.clicks != null ? `<div><span>Clics</span><b>${a.clicks}</b></div>` : ''}
      <div><span>ACOS</span><b class="${e.losing ? 'neg' : ''}">${pctTxt(e.acos)}</b></div>
      ${e.maxAcos != null ? `<div><span>ACOS máximo que aguanta${e.cost == null ? ' (antes del costo)' : ''}</span><b>${pctTxt(e.maxAcos)}</b></div>` : ''}
      ${e.unit ? `<div class="camp-wide"><span>Cargos por venta a ${fmtMoney(e.unit.price)}</span><b>${fmtMoney(e.unit.charges.total)}</b>${chargesDetail(e.unit.charges)}</div>` : ''}
    </div>
    ${e.losing ? `<p class="small" style="margin:6px 0 0"><b>Cada venta por publicidad pierde plata:</b> el ACOS es mayor que tu margen antes de publicidad.</p>` : ''}
    ${e.note ? `<p class="small muted" style="margin:6px 0 0">${esc(e.note)}</p>` : ''}
    ${costInput(it, key)}
  </article>`;
}

// Avisos y campañas que no gastaron en el período: una sola línea con desplegable (sin tarjetas llenas de ceros).
function idleBox(sp) {
  const nA = sp.idleAds.length;
  const nC = sp.idleCampaigns.length;
  if (!nA && !nC) return '';
  const head = nA
    ? `${nA} aviso${nA === 1 ? '' : 's'} no gastaron en los últimos 30 días`.replace('1 aviso no gastaron', '1 aviso no gastó')
    : `${nC} campaña${nC === 1 ? '' : 's'} no gastaron en los últimos 30 días`.replace('1 campaña no gastaron', '1 campaña no gastó');
  const camps = sp.idleCampaigns.map((x) => { const st = campaignStateText(x); return `<li><b>${/^campa/i.test(x.name) ? '' : 'Campaña '}${esc(x.name)}</b>: gasto $0 en 30 días${st ? ` · ${esc(st)}` : ''}.</li>`; }).join('');
  const ads = sp.idleAds.map(({ a }) => `<li>${campTitle(a)}${a.status ? ` <span class="muted">· ${esc(a.status === 'active' ? 'activo' : a.status === 'paused' ? 'pausado' : a.status)}</span>` : ''}</li>`).join('');
  return `<details class="camp-idle card"><summary>${I.info}<span><b>${esc(head)}</b>${nA && nC ? ` <span class="small muted">(y ${nC} campaña${nC === 1 ? '' : 's'} sin gasto)</span>` : ''} <span class="small muted">· ver cuáles</span></span></summary>
    <p class="small muted" style="margin:8px 0 6px">Según Mercado Libre: gasto $0 y ninguna venta atribuida. No hay nada que evaluar hasta que gasten.</p>
    ${camps ? `<ul class="small">${camps}</ul>` : ''}${ads ? `<ul class="small">${ads}</ul>` : ''}</details>`;
}

function campaignsView() {
  loadCampaigns();
  const c = S.camp;
  const head = `<div class="page-head"><div><h1>Campañas y publicidad</h1><div class="small muted">¿Te conviene entrar a una promo o seguir pagando publicidad? Rinde hace la cuenta con tus cargos reales. Solo recomienda: nunca activa ni cambia nada en Mercado Libre.</div></div>
    ${!DEMO && S.paid && c && !c.loading ? `<button class="btn btn-light btn-sm" id="camp-refresh">${I.refresh} Volver a leer</button>` : ''}</div>`;
  if (!c || c.loading) return head + `<div class="card">${I.loader.replace('<svg', '<svg class="spin"')} Leyendo tus campañas y publicidad de Mercado Libre…</div>`;
  if (c.error) return head + `<div class="notice notice-bad">${I.alert}<div>${esc(c.error)}</div></div>`;
  const ev = evaluateAll(c);
  const sum = ev.summary;
  const sp = splitIdle(ev.ads, c.adsInfo?.campaigns || []);
  const errs = (c.errors || []).filter((x) => x.status);
  const body = `
  ${sum.text ? `<div class="camp-sum">${I.chart}<div><b>${esc(sum.text.charAt(0).toUpperCase() + sum.text.slice(1))}.</b></div></div>` : ''}
  ${errs.length ? `<div class="notice notice-warn small" style="margin-bottom:12px">${I.info}<div>Mercado Libre no nos dejó leer: ${errs.map((x) => `${esc(x.what)} (${x.status})`).join(', ')}. Lo que se pudo leer está abajo.</div></div>` : ''}
  <h2 class="camp-h">Promociones</h2>
  <div class="camp-list">${ev.promos.map(({ o, e }, i) => promoCard(o, e, 'p' + i)).join('') || '<div class="empty">No tenés campañas ofrecidas ni activas ahora.</div>'}</div>
  <h2 class="camp-h">Publicidad (Product Ads)</h2>
  <p class="small muted" style="margin:0 0 10px">Ventas atribuidas según Mercado Libre: algunas hubieran salido igual sin publicidad. Si el ACOS es mayor que tu margen antes de publicidad, cada venta por publicidad pierde plata.</p>
  ${sp.campaigns.length ? `<div class="camp-list" style="margin-bottom:10px">${sp.campaigns.map((x) => `<article class="camp-card"><div class="camp-top"><div class="camp-title">${esc(x.name)}</div><span class="tag tag-neutral">Campaña${campaignStateText(x) === 'está pausada' ? ' pausada' : ''}</span></div><div class="camp-grid"><div><span>Gasto</span><b>${x.metrics.cost != null ? fmtMoney(x.metrics.cost) : '—'}</b></div><div><span>Ventas atribuidas</span><b>${x.metrics.total_amount != null ? fmtMoney(x.metrics.total_amount) : '—'}</b></div><div><span>ACOS</span><b>${x.metrics.cost != null && x.metrics.total_amount ? pctTxt(x.metrics.cost / x.metrics.total_amount) : '—'}</b></div>${x.metrics.clicks != null ? `<div><span>Clics</span><b>${x.metrics.clicks}</b></div>` : ''}</div></article>`).join('')}</div>` : ''}
  ${idleBox(sp)}
  <div class="camp-list">${[...sp.ads.map(({ a, e }, i) => adsCard(a, e, 'a' + i)), ...(c.ads || []).filter((a) => a.noMetrics && a.item).map(adsCardNoMetrics)].join('') || (sp.idleAds.length || sp.idleCampaigns.length ? '' : `<div class="empty">${c.hasAdvertiser === false ? 'No usás Product Ads.' : 'Sin publicidad en los últimos 30 días.'}</div>`)}</div>
  <div style="margin-top:16px">${helpBox()}</div>`;
  const sim = `<div style="margin-bottom:18px">${simulatorCard(null, { pick: true })}</div>`;
  if (c.preview) {
    return head + sim + `<div class="locked-preview"><div class="lp-inner" aria-hidden="true">${body}</div>
      <div class="lp-cta card"><h3>${I.lock} Disponible en Plan Rinde</h3><p class="small">Para cada promo que te ofrece Mercado Libre y cada publicidad que pagás, te decimos si te deja plata o te la come. Esto es un ejemplo.</p><a class="btn btn-primary btn-sm" href="/suscribirme">Ver el Plan Rinde</a></div></div>`;
  }
  return head + sim + body;
}

function campaignsNotice() {
  let sum = S.campaigns?.summary;
  if (DEMO && !sum) { const d = getCampaignsDemo(); sum = evaluateAll(d).summary; }
  if (!sum?.text) return '';
  return `<div class="notice notice-info camp-notice">${I.tag}<div><b>Campañas y publicidad:</b> ${esc(sum.text)}. <a href="#/campanas">Ver el detalle</a></div></div>`;
}

function alertsBox() {
  const list = S.unread || [];
  if (!list.length) return '';
  const top = list.slice(0, 3);
  return `<section class="alerts-box" aria-label="Alertas nuevas">
    <div class="ab-head">${I.bell}<b>Tenés ${list.length} alerta${list.length === 1 ? '' : 's'} nueva${list.length === 1 ? '' : 's'}</b><a class="btn btn-light btn-sm" href="#/alertas">Ver alertas</a></div>
    <ul>${top.map((a) => `<li><span class="tag ${a.severity === 'bad' ? 'tag-bad' : 'tag-warn'}">${esc(ALERT_LABELS[a.kind] || a.kind)}</span> ${a.title ? `<b>${itemLink(a.item_id, a.title)}</b> · ` : ''}<span class="small">${esc(a.message)}</span></li>`).join('')}${list.length > top.length ? `<li class="small muted">y ${list.length - top.length} más</li>` : ''}</ul>
  </section>`;
}

function scoreBadge(sc) {
  if (!sc || sc.score == null) return '';
  return `<span class="score score-${sc.tone}" title="Nota de publicación (Rinde)"><b>${sc.score}</b>/100</span>`;
}

function seasonBox(m) {
  const s = m.seasonSummary;
  if (!s) return '';
  return `<section class="season-box" aria-label="Resumen de temporada">
    <div class="sb-icon">${I.calendar}</div>
    <div>
      <p><b>El ${Math.round(s.share * 100)} % de tus ventas de los últimos 6 meses son productos de ${esc(s.season)}.</b> Fuera de temporada tu cuenta vende ~${fmtMoney(s.offMonthly)}/mes. Preparate: reponé y reactivá un mes antes del ${esc(s.season)} (${esc(s.prepare)}).</p>
      <p class="small" style="margin-top:6px">¿Querés sumar productos para la otra temporada? Innovasmart te ayuda a importarlos.
      <a class="btn btn-wa btn-sm" style="margin-left:4px" href="${waLink('import')}" target="_blank" rel="noopener">${I.chat} Hablar por WhatsApp</a></p>
    </div>
  </section>`;
}

// ─────────────────────────────── Publicaciones (Nota) ──────────────────────
function listingRow(r) {
  const sc = r.score;
  return `<article class="lrow">
    <div class="lrow-top">${scoreBadge(sc)}<div class="lrow-title">${itemLink(r.it.id, r.it.title)}</div>${catTag(r.group, r.it)}</div>
    ${sc.improvements.length ? `<ol class="lrow-fix">${sc.improvements.map((x) => `<li>${esc(x.text)} <span class="muted">${x.suggestion ? 'sugerencia' : '+' + x.gain}</span>${genBtn(r.it.id, x.key)}</li>`).join('')}</ol>` : '<p class="small muted" style="margin:6px 0 0">Bien armada. Mantenela así.</p>'}
    <details class="lrow-more"><summary class="small">Cómo se calcula</summary><ul class="small">${sc.criteria.map((c) => `<li>${esc(c.label)} (peso ${Math.round(c.weight)}): ${esc(c.note)} → ${Math.round(c.value * c.weight)}/${Math.round(c.weight)}</li>`).join('')}</ul></details>
  </article>`;
}

function listingsView() {
  const m = S.model;
  const L = S.list || (S.list = { tone: 'todas', group: 'TODAS', q: '' });
  const byId = Object.fromEntries(m.rows.map((r) => [r.it.id, r]));
  const worst = (m.scores?.worst || []).map((id) => byId[id]).filter(Boolean);
  const q = L.q.trim().toLowerCase();
  const rows = m.rows
    .filter((r) => r.score?.score != null)
    .filter((r) => L.tone === 'todas' || r.score.tone === L.tone)
    .filter((r) => L.group === 'TODAS' || r.group === L.group)
    .filter((r) => !q || (r.it.title || '').toLowerCase().includes(q))
    .sort((a, b) => a.score.score - b.score.score);
  const avg = m.scores?.avg;
  const tones = [['todas', 'Todas las notas'], ['bad', 'Roja (menos de 50)'], ['warn', 'Amarilla (50 a 75)'], ['ok', 'Verde (más de 75)']];
  const groups = ['SIN_STOCK', 'PAUSADAS', 'TEMPORADA', 'ABANDONADAS', 'POCA_VISIBILIDAD', 'SIN_VENTAS', 'PIERDE_PLATA', 'BLOQUEADAS', 'SANA'].filter((k) => m.groupCounts[k]);
  return `
  <div class="page-head"><div><h1>Publicaciones</h1><div class="small muted">Nota de 0 a 100 armada por Rinde con lo que Mercado Libre sí nos da: atributos, fotos, título, descripción, video, tipo, envío, preguntas y conversión.</div></div></div>
  <div class="lgrid">
    <section class="card avg-card">
      <div class="label">Nota promedio de tu cuenta</div>
      <div class="avg-n score-${scoreToneOf(avg)}">${avg ?? '—'}<span>/100</span></div>
      ${m.scores?.provisional ? `<p class="small" style="margin:0 0 6px"><span class="tag tag-warn">${I.info} Nota provisoria: faltan atributos y descripciones</span></p>` : ''}
      <p class="small muted">Rojo menos de 50 · amarillo 50 a 75 · verde más de 75. Si un dato no se puede leer, ese criterio no cuenta.</p>
    </section>
    <section class="card">
      <h3 style="margin-top:0">${worst.length < 10 ? 'Tus publicaciones de peor a mejor' : 'Tus 10 peores publicaciones'}</h3>
      <ol class="worst">${worst.map((r) => `<li>${scoreBadge(r.score)} ${itemLink(r.it.id, r.it.title)}</li>`).join('')}</ol>
    </section>
  </div>
  <div class="lfilters">
    <label class="sr" for="lq">Buscar por título</label><input id="lq" type="search" placeholder="Buscar por título" value="${esc(L.q)}">
    <label class="sr" for="ltone">Filtrar por nota</label><select id="ltone">${tones.map(([k, l]) => `<option value="${k}" ${L.tone === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label class="sr" for="lgroup">Filtrar por grupo</label><select id="lgroup"><option value="TODAS">Todos los grupos</option>${groups.map((k) => `<option value="${k}" ${L.group === k ? 'selected' : ''}>${esc(GROUPS[k].label)} (${m.groupCounts[k]})</option>`).join('')}</select>
  </div>
  <div class="small muted" style="margin:0 0 8px">${rows.length} publicación(es) · de peor a mejor nota</div>
  <div class="lrows">${rows.slice(0, L.limit || 60).map((r) => `<div id="it-l-${esc(r.it.id)}">${listingRow(r)}</div>`).join('') || '<div class="empty">No hay publicaciones con ese filtro.</div>'}</div>
  ${rows.length > (L.limit || 60) ? `<button class="btn btn-light btn-block" id="lmore" style="margin-top:12px">Ver ${Math.min(60, rows.length - (L.limit || 60))} más</button>` : ''}`;
}
const scoreToneOf = (n) => (n == null ? 'neutral' : n < 50 ? 'bad' : n <= 75 ? 'warn' : 'ok');

function itemCard(r) {
  const { it, cls, plan, profit } = r;
  const conv = conversion(it);
  const ref = competitorRef(it);
  const gap = priceGap(it);
  const allow = scoreAllows(r.score, { ship: r.ship });
  const reasons = (cls.reasons || []).filter((x) => x.text && !conflictOf({ title: x.text }, allow));
  return `<details class="item tone-${GROUPS[r.group].tone}" id="it-${esc(it.id)}">
    <summary>
      <div class="i-top"><div class="i-title">${itemLink(it.id, it.title)}</div><span style="display:flex;gap:6px;flex-wrap:wrap">${scoreBadge(r.score)}${catTag(r.group, it)}</span></div>
      <div class="i-meta"><span>Precio <b>${fmtMoney(it.price)}</b></span>${it.visits30 != null ? `<span>Visitas 30 d <b>${it.visits30.toLocaleString('es-AR')}</b></span>` : ''}<span>Ventas 30 d <b>${it.sales30 ?? 0}</b></span>${conv != null && (it.visits30 || 0) >= MIN_VISITS_CONV ? `<span>Conversión <b>${fmtPct(conv)}</b></span>` : ''}</div>
      <div class="i-head">${plan.verdict === 'liquidar' ? `<span class="tag tag-bad">${I.x} Sin salida</span> ` : ''}${esc(plan.headline)}</div>
      <span class="i-more">Ver plan de acción ${I.chevron}</span>
    </summary>
    <div class="i-body">
      <div class="facts">
        ${it.quality?.score != null ? `<div class="fact"><span>Calidad Mercado Libre</span><b>${it.quality.score}/100</b> ${it.quality.level_wording ? `<span>${esc(it.quality.level_wording)}</span>` : ''}</div>` : ''}
        ${ref ? `<div class="fact"><span>Competencia (referencia)</span><b>${fmtMoney(ref)}</b>${gap != null ? `<span>${gap > 0 ? 'estás ' + fmtPct(gap) + ' arriba' : 'estás ' + fmtPct(-gap) + ' abajo'}</span>` : ''}</div>` : ''}
        <div class="fact"><span>Preguntas sin responder</span><b>${it.questions_unanswered ?? 0}</b>${it.oldest_question_hours ? `<span>la más vieja: ${it.oldest_question_hours} h</span>` : ''}</div>
        <div class="fact"><span>Ganancia 30 días</span><b class="${profit.net < 0 ? 'neg' : ''}">${profit.hasCost ? (profit.units ? fmtMoney(profit.net) : 'sin ventas') : '<span class="muted">costo sin cargar</span>'}</b></div>
        <div class="fact"><span>${it.listing_type ? 'Tipo / envío' : 'Envío'}</span><b>${it.listing_type ? `${esc(LISTING_LABEL[it.listing_type] || it.listing_type)} · ` : ''}${shipLabel(it)}</b></div>
        ${it.available_quantity != null ? `<div class="fact"><span>Stock</span><b>${it.available_quantity}</b></div>` : ''}
        <div class="fact"><span>Ventas 90 días</span><b>${it.sales90 ?? 0}</b></div>
        ${it.pictures_count != null ? `<div class="fact"><span>Fotos</span><b>${it.pictures_count}</b></div>` : ''}
      </div>
      ${r.score?.improvements?.length ? `<p class="sec-label">Mejoras que más suben la nota (${r.score.score}/100)</p><ul class="reasons">${r.score.improvements.map((x) => `<li>${esc(x.text)} <span class="muted small">(${x.suggestion ? 'sugerencia' : '+' + x.gain})</span>${genBtn(it.id, x.key)}</li>`).join('')}</ul>` : ''}
      ${reasons.length ? `<p class="sec-label">Qué detectamos</p><ul class="reasons">${reasons.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : ''}
      ${plan.actions?.length ? `<p class="sec-label">Plan de acción · de mayor a menor impacto</p>
      <ol class="actions">${plan.actions.map((a) => `<li><b>${esc(a.title)}<span class="impact impact-${esc(a.impact)}">impacto ${esc(a.impact)}</span></b><p>${esc(a.detail)}</p></li>`).join('')}</ol>` : ''}
      <div class="source" style="margin-bottom:12px">${plan.source === 'ia' ? 'Plan redactado con IA usando solo tus datos y las recomendaciones de Mercado Libre.' : 'Plan armado con reglas a partir de tus datos.'} · <a href="#/publicacion/${esc(it.id)}">Ver el detalle completo</a>${it.permalink && it.permalink !== '#' ? ` · <a href="${esc(it.permalink)}" target="_blank" rel="noopener">Ver en Mercado Libre</a>` : ''}</div>
      ${cls.category !== 'SANA' ? helpBox() : ''}
    </div>
  </details>`;
}

// ─────────────────────────────── Detalle de una publicación ────────────────
const TEXT_KEYS = new Set(['titulo', 'descripcion', 'atributos']);
const genBtn = (id, key) => (TEXT_KEYS.has(key) ? ` <button class="btn btn-light btn-xs" type="button" data-gen="${esc(id)}">${I.sparkle} Generar sugerencia</button>` : '');
const isMobile = () => window.matchMedia('(max-width: 759px)').matches;

/** Datos extra de la publicación: ventas de 90 días (desglose) y la última sugerencia guardada. */
function loadItem(id) {
  if (S.item[id]) return;
  if (DEMO) {
    const lines = (S.demoData.lines90 || []).filter((l) => l.item_id === id);
    S.item[id] = { sales: lines, suggestion: null, usage: demoUsage() };
    return;
  }
  S.item[id] = { loading: true };
  api(`/api/item?id=${encodeURIComponent(id)}`).then((d) => { S.item[id] = d; if (routeItemId() === id) render(); })
    .catch((e) => { S.item[id] = { error: e.message }; if (routeItemId() === id) render(); });
}
const demoUsage = () => ({ paid: true, today: S.demoSugg, limit: SUGGEST_LIMITS.PAID_PER_DAY, left: Math.max(0, SUGGEST_LIMITS.PAID_PER_DAY - S.demoSugg), allowed: S.demoSugg < SUGGEST_LIMITS.PAID_PER_DAY });

function block(key, title, body, open) {
  const isOpen = S.blkOpen?.[key] ?? open; // lo que el usuario abrió o cerró se respeta al redibujar
  return `<details class="blk" id="blk-${key}" data-blk="${key}" ${isOpen ? 'open' : ''}><summary><h2>${title}</h2>${I.chevron}</summary><div class="blk-body">${body}</div></details>`;
}

function detailView(id) {
  const r = S.model.rows.find((x) => x.it.id === id);
  const back = `<button class="btn btn-ghost btn-sm" id="back" type="button">← Volver</button>`;
  if (!r) return `<div class="d-nav">${back}</div><div class="notice notice-warn">${I.info}<div><b>No encontramos la publicación ${esc(id)} en tu cuenta.</b> Puede que ya no esté activa ni pausada, o que sea de otra cuenta. Buscala arriba por título o número.</div></div>`;
  loadItem(id);
  const { it, score: sc, plan, profit } = r;
  const x = S.item[id] || {};
  const losing = profit.hasCost && profit.units > 0 && profit.net < 0;
  const main = losing ? 'plata' : 'nota';
  const open = (k) => !isMobile() || k === main;
  const states = itemStates(it, r.group).map(([l, t]) => `<span class="tag tag-${t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : t === 'bad' ? 'bad' : 'neutral'}">${esc(l)}</span>`).join(' ');
  const pl = it.permalink && it.permalink !== '#' ? it.permalink : null;

  // a) Encabezado (siempre visible)
  const head = `<section class="d-head card">
    <div class="d-photo">${it.thumbnail ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy">` : `<span class="d-noph" aria-hidden="true">${I.tag}</span>`}</div>
    <div class="d-info">
      <h1 class="d-title">${esc(it.title)}</h1>
      <div class="d-price num">${fmtMoney(it.price)}</div>
      <div class="d-tags">${states} ${catTag(r.group, it)}</div>
      <div class="tiny muted">${esc(it.id)} · grupo del diagnóstico: ${esc(GROUPS[r.group].label)}</div>
      ${pl ? `<a class="btn btn-light btn-sm" style="margin-top:8px" href="${esc(pl)}" target="_blank" rel="noopener">Ver en Mercado Libre ↗</a>` : DEMO ? '<div class="tiny muted" style="margin-top:6px">En el demo no hay link a Mercado Libre (publicación de ejemplo).</div>' : ''}
    </div></section>`;

  // b) Nota
  const nota = sc.score == null
    ? `<p class="small muted">No pudimos calcular la nota: Mercado Libre no devolvió los datos de la ficha de esta publicación.</p>`
    : `<div class="d-score">${scoreBadge(sc)}<span class="small muted">Rojo menos de 50 · amarillo 50 a 75 · verde más de 75</span></div>
      ${sc.improvements.length ? `<p class="sec-label">Mejoras ordenadas (las que más suben la nota primero)</p><ol class="reasons">${sc.improvements.map((m) => `<li>${esc(m.text)} <span class="muted small">(${m.suggestion ? 'sugerencia' : '+' + m.gain})</span>${TEXT_KEYS.has(m.key) ? ` <button class="btn btn-light btn-xs" type="button" data-gen-here="${esc(m.key)}">${I.sparkle} Generar sugerencia</button>` : ''}</li>`).join('')}</ol>` : '<p class="small">Bien armada. Mantenela así.</p>'}
      <details class="lrow-more"><summary class="small">Cómo se calcula</summary><ul class="small">${sc.criteria.map((c) => `<li>${esc(c.label)} (peso ${Math.round(c.weight)}): ${esc(c.note)} → ${Math.round(c.value * c.weight)}/${Math.round(c.weight)}</li>`).join('')}</ul></details>`;

  // c) Números
  const conv = conversion(it);
  const fact = (l, v, sub = '') => `<div class="fact"><span>${l}</span><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const nums = `<div class="facts">
    ${it.available_quantity != null ? fact('Stock', it.available_quantity) : ''}
    ${it.visits30 != null ? fact('Visitas 30 días', it.visits30.toLocaleString('es-AR')) : ''}
    ${fact('Ventas 30 días', it.sales30 ?? 0)}${fact('Ventas 90 días', it.sales90 ?? 0)}${fact('Ventas 180 días', it.sales180 ?? it.sales90 ?? 0)}
    ${conv != null && (it.visits30 || 0) >= MIN_VISITS_CONV ? fact('Conversión', fmtPct(conv), 'ventas / visitas, 30 días') : ''}
    ${it.listing_type ? fact('Tipo de publicación', esc(LISTING_LABEL[it.listing_type] || it.listing_type)) : ''}
    ${fact('Envío', shipLabel(it), it.shipping?.free_shipping ? 'con envío gratis' : 'sin envío gratis')}
    ${it.pictures_count != null ? fact('Fotos', it.pictures_count) : ''}
    ${fact('Preguntas sin responder', it.questions_unanswered ?? 0)}
  </div>${conv != null && (it.visits30 || 0) < MIN_VISITS_CONV && it.visits30 != null ? `<p class="tiny muted">La conversión aparece con ${MIN_VISITS_CONV} visitas o más en 30 días (tiene ${it.visits30}).</p>` : ''}`;

  // d) Plata
  const plata = moneyBlock(r, x);

  // e) Publicidad y campañas
  let camp = '';
  if (DEMO || S.paid) {
    loadCampaigns();
    const c = S.camp;
    if (c && !c.loading && !c.error && !c.preview) {
      const ev = evaluateAll(c);
      const promos = ev.promos.filter(({ o }) => o.item_id === id).map(({ o, e }, i) => promoCard(o, e, 'dp' + i));
      const ads = ev.ads.filter(({ a }) => a.item_id === id).map(({ a, e }, i) => (a.noMetrics ? adsCardNoMetrics(a) : adsCard(a, e, 'da' + i)));
      if (promos.length || ads.length) camp = block('camp', 'Publicidad y campañas', `${promos.length ? `<h3 class="camp-h">Promociones</h3><div class="camp-list">${promos.join('')}</div>` : ''}${ads.length ? `<h3 class="camp-h">Publicidad (Product Ads)</h3><div class="camp-list">${ads.join('')}</div>` : ''}`, open('camp'));
    } else if (c?.loading) camp = block('camp', 'Publicidad y campañas', `<p class="small muted">${I.loader.replace('<svg', '<svg class="spin"')} Leyendo campañas y publicidad de esta publicación…</p>`, open('camp'));
  }

  // f) Full/Flex y temporada
  const extras = [];
  if (r.shipStatus) extras.push(`<div class="ship-box">${shipLines(r.shipStatus)}</div>`);
  if (r.season) { const cfg = SEASONS[r.season.season]; extras.push(`<div class="notice notice-info">${I.calendar}<div><b>Producto de ${esc(r.season.season)}.</b> Hoy está fuera de temporada: no repongas ahora. Preparala un mes antes (${esc(cfg?.prepare || '')}).</div></div>`); }

  // g) Plan
  const planB = `${plan.headline ? `<p><b>${esc(plan.headline)}</b></p>` : ''}${plan.actions?.length ? `<ol class="actions">${plan.actions.map((a) => `<li><b>${esc(a.title)}<span class="impact impact-${esc(a.impact)}">impacto ${esc(a.impact)}</span></b><p>${esc(a.detail)}</p></li>`).join('')}</ol>` : '<p class="small">No hay acciones pendientes para esta publicación.</p>'}
    <div class="source">${plan.source === 'ia' ? 'Plan redactado con IA usando solo tus datos.' : 'Plan armado con reglas a partir de tus datos.'}</div>`;

  return `<div class="d-nav">${back}<span class="tiny muted">Detalle de la publicación · link para compartir: <code>${esc(location.pathname)}#/publicacion/${esc(id)}</code></span></div>
  ${head}
  ${block('nota', `Nota de la publicación${sc.score != null ? ` · ${sc.score}/100` : ''}`, nota, open('nota'))}
  ${block('numeros', 'Números', nums, open('numeros'))}
  ${block('plata', 'Desglose de plata por venta', plata, open('plata'))}
  ${camp}
  ${block('sim', 'Simulador de campaña', simulatorCard(id).replace(/<h3[^>]*>[\s\S]*?<\/h3>/, ''), open('sim'))}
  ${extras.length ? block('envio', r.season ? 'Full / Flex y temporada' : 'Full / Flex', extras.join(''), open('envio')) : ''}
  ${block('plan', 'Plan de acción', planB, open('plan'))}
  ${block('sugerencias', 'Sugerencias para copiar y pegar', suggestionBlock(r, x), open('sugerencias'))}`;
}

function moneyBlock(r, x) {
  const { it } = r;
  if (!DEMO && !S.paid) return `<div class="notice notice-info">${I.lock}<div><b>El desglose de plata es parte del Plan Rinde.</b> Por cada venta: comisión, cargo fijo, cuotas, envío, retenciones, publicidad, costo y cuánto te quedó. <a href="/suscribirme">Ver el Plan Rinde</a></div></div>`;
  if (x.loading) return `<p class="small muted">${I.loader.replace('<svg', '<svg class="spin"')} Leyendo tus ventas de esta publicación…</p>`;
  if (x.error) return `<div class="notice notice-warn">${I.info}<div>${esc(x.error)}</div></div>`;
  const costForm = `<form class="camp-cost d-cost" data-sku="${esc(costKey(it))}"><label class="small" for="dcost">Costo del producto (por unidad)</label><input id="dcost" inputmode="decimal" placeholder="$ por unidad" value="${r.cost?.purchase ?? ''}"><button class="btn btn-light btn-sm" type="submit">Guardar costo</button></form>`;
  const adsPerUnit = r.profit.units ? (r.profit.ads || 0) / r.profit.units : 0;
  const d = saleRows(x.sales || [], { cost: r.cost, adsPerUnit });
  if (!d.units) return `<p class="small">Sin ventas en los últimos 90 días: el desglose aparece cuando vendas.</p>${!d.hasCost ? `<p class="small muted">Podés dejar cargado el costo, así el día que vendas ya ves cuánto te quedó.</p>${costForm}` : ''}`;
  const m = (v) => fmtMoney(v);
  const left = (v, bc) => (v == null ? `<span class="muted">${m(bc)} antes del costo</span>` : `<b class="${v < 0 ? 'neg' : 'pos'}">${m(v)}</b>`);
  const a = d.avg;
  const cell = (k, v) => `<div class="mrow"><span>${k}</span><b>${v}</b></div>`;
  const avgCard = `<div class="d-avg card">
    <div class="label">Promedio por unidad · ${d.units} vendida${d.units === 1 ? '' : 's'} en 90 días</div>
    <div class="mgrid">${cell('Precio', m(a.price))}${cell('Comisión', '−' + m(a.commission))}${a.fixed ? cell('Cargo fijo', '−' + m(a.fixed)) : ''}${a.financing ? cell('Cuotas', '−' + m(a.financing)) : ''}${cell('Envío', a.shipping ? '−' + m(a.shipping) : m(0))}${cell('Retenciones', a.taxes ? '−' + m(a.taxes) : m(0))}${a.other ? cell('Otros cargos', '−' + m(a.other)) : ''}${cell('Publicidad', a.ads ? '−' + m(a.ads) : m(0))}${cell('Costo del producto', a.cost != null ? '−' + m(a.cost) : 'sin cargar')}
    <div class="mrow total"><span>Te quedó</span>${left(a.left, a.beforeCost)}</div></div>
  </div>`;
  const rowsHtml = d.rows.map((s) => `<tr><td class="num">${new Date(s.date).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}${s.qty > 1 ? ` · ${s.qty} u` : ''}${s.source !== 'facturación' ? ' <span class="tag tag-neutral" style="padding:0 6px">estimado</span>' : ''}</td>
    <td class="num">${m(s.price)}</td><td class="num">${m(s.commission)}</td><td class="num">${m(s.fixed)}</td><td class="num">${m(s.financing)}</td><td class="num">${s.shippingUnknown ? '<span class="muted small">no incluido</span>' : m(s.shipping)}</td><td class="num">${m(s.taxes)}</td><td class="num">${m(s.ads)}</td><td class="num">${s.cost != null ? m(s.cost) : '<span class="muted small">sin cargar</span>'}</td><td class="num">${left(s.left, s.beforeCost)}</td></tr>`).join('');
  const cardsHtml = d.rows.slice(0, 40).map((s) => `<div class="pc"><div class="row"><span>${new Date(s.date).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}${s.qty > 1 ? ` · ${s.qty} u` : ''}${s.source !== 'facturación' ? ' · estimado' : ''}</span><b>${m(s.price)}</b></div>
    <div class="row"><span>Cargos de Mercado Libre</span><b>−${m(s.charges)}</b></div><div class="row tiny muted"><span>comisión ${m(s.commission)} · fijo ${m(s.fixed)} · cuotas ${m(s.financing)} · envío ${s.shippingUnknown ? 'no incluido' : m(s.shipping)} · retenciones ${m(s.taxes)}</span></div>
    <div class="row"><span>Publicidad</span><b>−${m(s.ads)}</b></div><div class="row"><span>Costo</span><b>${s.cost != null ? '−' + m(s.cost) : 'sin cargar'}</b></div><div class="row"><span>Te quedó</span>${left(s.left, s.beforeCost)}</div></div>`).join('');
  return `${avgCard}
    ${!d.hasCost ? `<div class="notice notice-warn" style="margin:10px 0">${I.info}<div><b>Cargá el costo para ver cuánto te quedó.</b> Sin el costo te mostramos lo que queda antes de pagar el producto.</div></div>${costForm}` : ''}
    <div class="table-wrap desktop-only" style="margin-top:12px"><table class="data"><thead><tr><th>Venta</th><th>Precio</th><th>Comisión</th><th>Cargo fijo</th><th>Cuotas</th><th>Envío</th><th>Retenciones</th><th>Publicidad</th><th>Costo</th><th>Te quedó</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div class="pcards mobile-only" style="margin-top:10px">${cardsHtml}${d.rows.length > 40 ? `<p class="tiny muted">Se muestran las 40 ventas más nuevas de ${d.rows.length}.</p>` : ''}</div>
    <p class="tiny muted" style="margin-top:8px">Cargos según la facturación de Mercado Libre. "Estimado": la venta todavía no figura en la facturación y usamos los datos de la orden${d.shippingUnknown ? '; en esas el envío no está incluido porque la orden no lo informa' : ''}. La publicidad es el gasto del último mes repartido por unidad vendida.</p>`;
}

function suggestionBlock(r, x) {
  const id = r.it.id;
  const st = S.sugg[id] || {};
  const data = st.data || x.suggestion || null;
  const usage = st.usage || x.usage || (DEMO ? demoUsage() : null);
  const locked = usage && !usage.allowed && !data;
  const lockMsg = usage && !usage.paid ? (usage.reason === 'otra_publicacion' ? 'Ya usaste la prueba gratis en otra publicación.' : usage.reason === 'agotado' ? 'Ya usaste las sugerencias de prueba.' : '') : '';
  const intro = `<p class="small muted" style="margin-top:0">Título y descripción armados solo con los datos de tu publicación (título, atributos, descripción, categoría y preguntas respondidas). La IA se usa solo cuando tocás el botón. Los atributos que faltan no se inventan: te decimos cuáles completar.</p>`;
  const fixed = `<p class="d-fixed small">${I.info} ${esc(NOTE_FIXED)}</p>`;
  const usageLine = usage ? `<p class="tiny muted">${usage.paid ? `Plan Rinde: te quedan ${usage.left} de ${usage.limit} sugerencias hoy.` : `Plan gratis: podés probarlo en 1 publicación${usage.trialItem ? '' : ' (la que elijas)'}.`}</p>` : '';
  if (st.loading) return intro + `<p>${I.loader.replace('<svg', '<svg class="spin"')} Armando la sugerencia con los datos de tu publicación…</p>` + fixed;
  if (locked) return intro + `<div class="notice notice-info">${I.lock}<div><b>Disponible en Plan Rinde</b>${lockMsg ? `<div class="small">${esc(lockMsg)}</div>` : ''} <a href="/suscribirme">Ver el Plan Rinde</a></div></div>` + fixed;
  const err = st.error ? `<div class="notice notice-warn" style="margin-bottom:10px">${I.info}<div>${st.error === 'Disponible en Plan Rinde' ? `<b>Disponible en Plan Rinde.</b> <a href="/suscribirme">Ver el Plan Rinde</a>` : esc(st.error)}</div></div>` : '';
  if (!data) return intro + err + `<button class="btn btn-primary" type="button" id="gen-go">${I.sparkle} Generar sugerencia</button>${usageLine}` + fixed;
  const out = (key, label, t, extra = '') => `<div class="sg">
    <div class="sg-head"><b>${label}</b><span class="tiny muted sg-count">${t.length} ${t.max ? `/ ${t.max} ` : ''}caracteres</span></div>
    <textarea class="sg-text" id="sg-${key}" rows="${key === 'title' ? 2 : 14}" readonly>${esc(t.text)}</textarea>${extra}
    <div class="help-links"><button class="btn btn-light btn-sm" type="button" data-copy="sg-${key}">${I.copy || '⧉'} Copiar</button><button class="btn btn-ghost btn-sm" type="button" data-again="1">${I.refresh} Generar otra</button></div></div>`;
  const title = data.title
    ? out('title', 'Título sugerido', data.title, `<div class="tiny muted">Máximo de su categoría en Mercado Libre: ${data.title.max} caracteres.</div>`)
    : `<div class="sg"><b>Título</b><div class="notice notice-info" style="margin-top:6px">${I.info}<div>${esc(data.titleNote || data.titleRule?.message || '')}</div></div></div>`;
  const desc = data.description ? out('desc', 'Descripción sugerida (texto plano)', data.description, '<div class="tiny muted">Sin HTML, links ni datos de contacto: Mercado Libre no los acepta.</div>') : '';
  const attrs = data.attributes?.length
    ? `<div class="sg"><b>Atributos que faltan según la categoría</b><ul class="sg-attrs">${data.attributes.map((a) => `<li><b>${esc(a.name)}</b>${a.required ? ' <span class="tag tag-bad" style="padding:0 6px">obligatorio</span>' : ''} — <span class="muted">${esc(a.hint)}</span></li>`).join('')}</ul><p class="tiny muted">Estos no los completa la IA: cargalos vos en Mercado Libre con el dato real.</p></div>`
    : `<div class="sg"><b>Atributos</b><p class="small">No falta ninguno de los que pide la categoría.</p></div>`;
  const notes = (data.notes || []).filter((n) => n !== NOTE_FIXED).map((n) => `<p class="small ${/corchetes/.test(n) ? 'sg-warn' : 'muted'}">${esc(n)}</p>`).join('');
  return intro + err + title + desc + attrs + notes
    + `<p class="tiny muted">${data.source === 'ia' ? 'Redactado con IA a partir de tus datos y revisado por Rinde (largo máximo, sin palabras ni números que no estén en tu publicación).' : DEMO ? 'Demo: armado con las reglas de Rinde, sin IA, con los datos de esta publicación de ejemplo.' : 'Armado con las reglas de Rinde, solo con tus datos (la IA no estaba disponible).'}${data.cached ? ' Guardada: no se volvió a generar.' : ''}</p>` + usageLine + fixed;
}

async function generateSuggestion(id, again = false) {
  const r = S.model.rows.find((x) => x.it.id === id);
  if (!r) return;
  S.sugg[id] = { ...(S.sugg[id] || {}), loading: true, error: null };
  S.blkOpen = { ...(S.blkOpen || {}), sugerencias: true };
  render();
  document.getElementById('blk-sugerencias')?.setAttribute('open', '');
  if (DEMO) {
    await new Promise((res) => setTimeout(res, 350));
    const prev = S.sugg[id]?.data;
    if (!again && prev) { S.sugg[id] = { data: prev, usage: demoUsage() }; return render(); }
    if (S.demoSugg >= SUGGEST_LIMITS.PAID_PER_DAY) { S.sugg[id] = { error: `Llegaste al máximo de ${SUGGEST_LIMITS.PAID_PER_DAY} sugerencias por día.` }; return render(); }
    const variant = again ? (S.sugg[id]?.variant || 0) + 1 : 0;
    const src = sourceOf({ item: r.it, ...(S.demoData.sources?.[id] || {}) });
    S.demoSugg++;
    S.sugg[id] = { data: { ...ruleSuggestion(src, variant), cached: false }, variant, usage: demoUsage() };
  } else {
    try {
      const d = await api('/api/item', { method: 'POST', body: { id, again }, timeout: 70000 });
      S.sugg[id] = { data: d.suggestion, usage: d.usage };
      if (S.item[id]) S.item[id] = { ...S.item[id], suggestion: d.suggestion, usage: d.usage };
    } catch (e) {
      S.sugg[id] = { ...(S.sugg[id] || {}), loading: false, error: e.message };
    }
  }
  render();
  document.getElementById('blk-sugerencias')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copyText(el) {
  try { await navigator.clipboard.writeText(el.value); }
  catch { el.removeAttribute('readonly'); el.select(); document.execCommand('copy'); el.setAttribute('readonly', ''); }
  toast('Copiado. Revisalo antes de pegarlo en Mercado Libre.');
}

function bindSearch() {
  const inp = document.getElementById('qpub');
  const list = document.getElementById('qpub-res');
  if (!inp || !S.model) return;
  const go = (id) => { location.hash = `#/publicacion/${id}`; };
  const show = () => {
    const res = searchItems(S.model.rows, inp.value);
    list.hidden = !inp.value.trim();
    inp.setAttribute('aria-expanded', String(!list.hidden));
    list.innerHTML = res.length
      ? res.map((r, i) => `<li role="option" id="qr-${i}" data-go="${esc(r.it.id)}">${scoreBadge(r.score)}<span><b>${esc(r.it.title)}</b><span class="tiny muted">${esc(r.it.id)} · ${fmtMoney(r.it.price)}</span></span></li>`).join('')
      : `<li class="muted small" style="cursor:default">No hay publicaciones con "${esc(inp.value)}" en tu cuenta.</li>`;
    list.querySelectorAll('[data-go]').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); go(li.dataset.go); }));
  };
  inp.addEventListener('input', show);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = searchItems(S.model.rows, inp.value)[0]; if (first) go(first.it.id); }
    if (e.key === 'Escape') { inp.value = ''; list.hidden = true; }
  });
  inp.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
}

function bindDetail() {
  const id = routeItemId();
  document.querySelectorAll('details[data-blk]').forEach((d) => d.addEventListener('toggle', () => { S.blkOpen = { ...(S.blkOpen || {}), [d.dataset.blk]: d.open }; }));
  document.getElementById('back')?.addEventListener('click', () => {
    if (S.back) { history.back(); } else location.hash = '#/diagnostico';
  });
  document.getElementById('gen-go')?.addEventListener('click', () => generateSuggestion(id));
  document.querySelectorAll('[data-again]').forEach((b) => b.addEventListener('click', () => generateSuggestion(id, true)));
  document.querySelectorAll('[data-gen-here]').forEach((b) => b.addEventListener('click', () => {
    const d = document.getElementById('blk-sugerencias'); d?.setAttribute('open', '');
    if ((S.sugg[id]?.data || S.item[id]?.suggestion)) d?.scrollIntoView({ behavior: 'smooth', block: 'start' }); else generateSuggestion(id);
  }));
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(document.getElementById(b.dataset.copy))));
  document.querySelector('.d-cost')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = f.querySelector('input').value;
    const cur = S.model.rows.find((x) => x.it.id === id)?.cost || {};
    if (await applyCosts([{ sku: f.dataset.sku, purchase: v, replacement: cur.replacement ?? '' }])) { toast('Costo guardado. Recalculamos.'); render(); }
  });
  if (routeParam('generar') === '1' && !S.sugg[id]) { history.replaceState(null, '', `#/publicacion/${id}`); generateSuggestion(id); }
}

// ─── Simulador de campaña (solo Plan Rinde) ──────────────────────────────────
// Visitas estimadas = clics. Mercado Libre no informa a cuánta gente se muestra el aviso: eso no se calcula.
function demoFeeFor(it) {
  const fixed = it.price >= 33000 ? 0 : it.price < 15000 ? 1115 : it.price < 26000 ? 2300 : 2810;
  return it.listing_type === 'gold_pro' ? { percentage: 14.5, fixed, financing: it.price * 0.115, source: 'meli' } : it.listing_type === 'free' ? null : { percentage: 13.5, fixed, financing: 0, source: 'meli' };
}
function demoSimCtx(id) {
  const r = S.model.rows.find((x) => x.it.id === id);
  if (!r) return null;
  const it = r.it;
  const ad = getCampaignsDemo().ads.find((a) => a.item_id === id && !a.noMetrics);
  const all = getCampaignsDemo().ads.filter((a) => !a.noMetrics);
  return {
    id, price: it.price, listing_type: it.listing_type, offersFreeShipping: !!it.shipping?.free_shipping, shipCost: it.price >= 33000 ? 7900 : 4200, taxRate: 0.035,
    fees: { demo: demoFeeFor(it) }, feeHistory: null, maxFinancingPct: it.listing_type === 'gold_pro' ? 0.115 : 0,
    cost: r.cost?.purchase ?? null,
    adsItem: ad ? { cost: ad.cost, clicks: ad.clicks, direct_units: ad.direct_units, indirect_units: ad.indirect_units } : null,
    adsAccount: { cost: all.reduce((t, a) => t + a.cost, 0), clicks: all.reduce((t, a) => t + a.clicks, 0) },
    item: { visits30: it.visits30, sales30: it.sales30 }, avgConv: accountConversion(S.model.rows.map((x) => x.it)),
  };
}
function loadSim(id) {
  if (DEMO) return demoSimCtx(id);
  S.sim = S.sim || {};
  if (!S.sim[id]) {
    S.sim[id] = { loading: true };
    api(`/api/item?id=${encodeURIComponent(id)}&sim=1`).then((d) => { S.sim[id] = d; renderSim(); }).catch((e) => { S.sim[id] = { error: e.message }; renderSim(); });
  }
  return S.sim[id];
}
const simItems = () => S.model.rows.filter((r) => r.it.status === 'active').sort((a, b) => (b.it.sales90 || 0) - (a.it.sales90 || 0) || a.it.title.localeCompare(b.it.title));

/** Tarjeta del simulador. pick: muestra el selector de publicación (pestaña Campañas). */
function simulatorCard(id, { pick = false } = {}) {
  if (!DEMO && !S.paid) return `<section class="card sim" id="simwrap"><h3 style="margin-top:0">${I.chart} Simulador de campaña</h3><div class="notice notice-info">${I.lock}<div><b>Disponible en Plan Rinde.</b> Elegís una publicación, un presupuesto por día y los días, y Rinde te dice cuánto vendés, qué ACOS te deja y cuánto te queda. <a href="/suscribirme">Ver el Plan Rinde</a></div></div></section>`;
  const items = simItems();
  if (!id) id = S.simPick || items[0]?.it.id;
  if (!id) return `<section class="card sim" id="simwrap"><h3 style="margin-top:0">${I.chart} Simulador de campaña</h3><p class="small">No tenés publicaciones activas para simular.</p></section>`;
  const f = (S.simForm ||= {})[id] ||= { budget: '', days: 7, cpc: '', conv: '' };
  return `<section class="card sim" id="simwrap" data-sim="${esc(id)}">
    <h3 style="margin-top:0">${I.chart} Simulador de campaña</h3>
    <p class="small muted" style="margin-top:0">Elegí cuánto querés gastar por día y cuántos días. Rinde hace la cuenta con tus cargos reales de Mercado Libre. No activa nada.</p>
    <div class="sim-form">
      ${pick ? `<div class="field sim-pick"><label for="sim-item">Publicación</label><select id="sim-item">${items.map((r) => `<option value="${esc(r.it.id)}" ${r.it.id === id ? 'selected' : ''}>${esc(r.it.title.slice(0, 70))} · ${fmtMoney(r.it.price)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="sim-budget">Presupuesto por día</label><input id="sim-budget" inputmode="decimal" placeholder="$" value="${esc(f.budget)}"></div>
      <div class="field"><label for="sim-days">Días</label><input id="sim-days" inputmode="numeric" value="${esc(f.days)}"></div>
      <div class="field"><label for="sim-cpc">Costo por clic <span class="muted">(opcional)</span></label><input id="sim-cpc" inputmode="decimal" placeholder="lo calculamos" value="${esc(f.cpc)}"></div>
      <div class="field"><label for="sim-conv">Conversión % <span class="muted">(opcional)</span></label><input id="sim-conv" inputmode="decimal" placeholder="la calculamos" value="${esc(f.conv)}"></div>
    </div>
    <div id="sim-res" aria-live="polite">${simResults(id)}</div>
    <p class="d-fixed small">${I.info} ${esc(SIM_NOTE)}</p>
  </section>`;
}

function simResults(id) {
  const ctxData = loadSim(id);
  if (!ctxData || ctxData.loading) return `<p class="small muted">${I.loader.replace('<svg', '<svg class="spin"')} Leyendo los cargos de Mercado Libre para esta publicación…</p>`;
  if (ctxData.error) return `<div class="notice notice-warn">${I.info}<div>${esc(ctxData.error)}</div></div>`;
  const r = S.model.rows.find((x) => x.it.id === id);
  const f = S.simForm[id];
  const src = simSources(ctxData);
  const manual = { cpc: parseNum(f.cpc) || null, conv: (parseNum(f.conv) || 0) / 100 || null };
  const sc = scenarios(src, manual);
  const medio = sc.list[sc.single ? 0 : 1];
  const trial = trialBudget(medio.cpc);
  const budget = parseNum(f.budget) || trial;
  const days = Math.max(1, Math.min(90, Math.round(parseNum(f.days) || 7)));
  const cost = r?.cost?.purchase ?? ctxData.cost ?? null;
  const ctx = { listingType: ctxData.listing_type, maxFinancingPct: ctxData.maxFinancingPct, offersFreeShipping: ctxData.offersFreeShipping, shipCost: ctxData.shipCost, taxRate: ctxData.taxRate,
    feeAt: (p) => [DEMO ? ctxData.fees.demo : ctxData.fees?.[feeKey(ctxData.listing_type, ctxData.category_id, p)], feeFromHistory(ctxData.feeHistory, p)].filter(Boolean) };
  const runs = sc.list.map((x) => ({ x, s: simulate({ price: ctxData.price, budget, days, cpc: x.cpc, conv: x.conv, ctx, cost }) }));
  const m = (v) => fmtMoney(v);
  const n1 = (v) => (Math.round(v * 10) / 10).toLocaleString('es-AR');
  const srcLine = (label, s, fmtV) => (s ? `<li><b>${label}:</b> ${fmtV(s.value)} · sale ${s.source.startsWith('el ') ? 'del ' + esc(s.source.slice(3)) : 'de ' + esc(s.source)} (${esc(s.detail)}).</li>` : '');
  const sources = `<ul class="small sim-src">${srcLine('Costo por clic', sc.cpc, (v) => m(v))}${srcLine('Conversión', sc.conv, (v) => fmtPct(v))}${sc.explain.map((t) => `<li>${esc(t)}</li>`).join('')}
    <li><b>Presupuesto:</b> ${m(budget)} por día × ${days} día${days === 1 ? '' : 's'}${f.budget ? '' : ' (sugerido: junta ~100 clics para medir)'}. Suponemos que Mercado Libre gasta todo el presupuesto.</li></ul>`;
  if (runs[0].s.noFees) return sources + `<div class="notice notice-warn">${I.info}<div>No pudimos calcular los cargos de Mercado Libre para este precio: sin eso no simulamos el resultado.</div></div>`;
  const u = runs[0].s.unit;
  const head = `<tr><th></th>${runs.map(({ x }) => `<th>${esc(x.label)}<div class="tiny muted">${m(x.cpc)} por clic · ${fmtPct(x.conv)} conv.</div></th>`).join('')}</tr>`;
  // Mismas filas para la tabla (escritorio) y para las tarjetas por escenario (celular).
  const ROWS = [
    ['Gasto en publicidad', (s) => m(s.spend)],
    ['Visitas estimadas (clics)', (s) => Math.round(s.visits).toLocaleString('es-AR')],
    ['Ventas', (s) => n1(s.sales)],
    ['Facturación', (s) => m(s.revenue)],
    ['Cargos de Mercado Libre', (s) => '−' + m(s.charges)],
    ['ACOS', (s) => (s.acos == null ? 'sin ventas' : fmtPct(s.acos)), (s) => (s.acosOverMargin ? 'neg' : '')],
    ['Te queda antes del costo', (s) => m(s.beforeCost), (s) => (s.beforeCost < 0 ? 'neg' : '')],
    ...(cost != null ? [
      ['Costo del producto', (s) => '−' + m(s.productCost)],
      ['<b>Te queda</b>', (s) => `<b>${m(s.left)}</b>`, (s) => (s.left < 0 ? 'neg' : 'pos')],
      ['Resultado', (s) => (s.verdict === 'gana' ? '<span class="tag tag-ok">Te deja plata</span>' : '<span class="tag tag-bad">Pierde plata</span>')],
    ] : []),
  ];
  const table = `<div class="table-wrap desktop-only"><table class="data sim-table"><thead>${head}</thead><tbody>${ROWS.map(([l, fn, cls = () => '']) => `<tr><td class="sim-lbl">${l}</td>${runs.map(({ s }) => `<td class="num ${cls(s)}">${fn(s)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="pcards mobile-only">${runs.map(({ x, s }) => `<div class="pc sim-pc"><div class="row"><b>${esc(x.label)}</b><span class="tiny">${m(x.cpc)} por clic · ${fmtPct(x.conv)} conv.</span></div>${ROWS.map(([l, fn, cls = () => '']) => `<div class="row"><span>${l}</span><b class="${cls(s)}">${fn(s)}</b></div>`).join('')}</div>`).join('')}</div>`;
  const s0 = runs[0].s;
  const acosBox = cost != null
    ? (s0.maxAcos > 0
      ? `<div class="notice notice-info sim-acos">${I.tag}<div><b>ACOS máximo que aguanta sin perder plata: ${fmtPct(s0.maxAcos)}.</b> Cargá en Mercado Libre un ACOS objetivo de <b>${Math.round(s0.targetAcos * 100)} %</b> (dejamos un 20 % de colchón por si sube el clic o los cargos).${runs.some((x) => x.s.acosOverMargin) ? ' En los escenarios en rojo el ACOS pasa ese máximo: cada venta por publicidad pierde plata.' : ''}</div></div>`
      : `<div class="notice notice-bad sim-acos">${I.alert}<div><b>Esta publicación ya pierde plata sin publicidad</b> (cargos + costo superan el precio). No le pongas publicidad hasta ajustar el precio o el costo.</div></div>`)
    : `<div class="notice notice-warn sim-acos">${I.info}<div><b>Sin costo no hay veredicto.</b> Antes del costo, el ACOS máximo es ${fmtPct(s0.maxAcosBeforeCost)}; con el costo va a ser menor. Cargalo y te decimos qué ACOS objetivo poner en Mercado Libre.
      <form class="camp-cost sim-cost" data-sku="${esc(r ? costKey(r.it) : id)}"><label class="small" for="sim-costin">Costo del producto</label><input id="sim-costin" inputmode="decimal" placeholder="$ por unidad"><button class="btn btn-light btn-sm" type="submit">Guardar</button></form></div></div>`;
  const tryIt = !sc.single ? `<p class="sim-try"><b>Probá 7 días con ${m(trial)} por día y volvé a mirar:</b> con ~100 clics ya vas a tener tu costo por clic y tu conversión reales, y este simulador los usa solos.</p>` : '';
  return sources + table + `<p class="tiny muted">Cargos por venta a ${m(ctxData.price)}: ${m(u.charges.total)}. ${chargesDetail(u.charges)}${ctxData.shipEstimated && u.charges.shipping ? ' · envío: promedio de tus ventas' : ''}</p>` + acosBox + tryIt;
}

function renderSim() {
  const w = document.getElementById('simwrap');
  if (!w) return;
  const id = w.dataset.sim;
  const res = document.getElementById('sim-res');
  if (res && id) { res.innerHTML = simResults(id); hydrateIcons(res); bindSimCost(); }
}
function bindSimCost() {
  document.querySelector('.sim-cost')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = e.target.querySelector('input').value;
    if (await applyCosts([{ sku: e.target.dataset.sku, purchase: v, replacement: '' }])) { if (S.sim) for (const k of Object.keys(S.sim)) delete S.sim[k]; toast('Costo guardado. Recalculamos.'); render(); }
  });
}
function bindSim() {
  const w = document.getElementById('simwrap');
  if (!w?.dataset.sim) return;
  const id = w.dataset.sim;
  const set = (k, el) => el?.addEventListener('input', () => { S.simForm[id][k] = el.value; renderSim(); });
  set('budget', document.getElementById('sim-budget'));
  set('days', document.getElementById('sim-days'));
  set('cpc', document.getElementById('sim-cpc'));
  set('conv', document.getElementById('sim-conv'));
  document.getElementById('sim-item')?.addEventListener('change', (e) => { S.simPick = e.target.value; render(); document.getElementById('simwrap')?.scrollIntoView({ block: 'start' }); });
  bindSimCost();
}
// ─── Fin simulador ──────────────────────────────────────────────────────────

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
  // Un solo período para toda la pestaña (el del cálculo): últimos 30 días. Se dice una vez, en el título.
  const units30 = S.model.rows.reduce((t, r) => t + (r.profit.units || 0), 0);
  if (!units30) {
    return `<div class="page-head"><div><h1>Rentabilidad real</h1><div class="small muted">Últimos 30 días · cargos de la facturación de Mercado Libre</div></div></div>
    <div class="notice notice-info" style="margin-bottom:14px" role="status">${I.info}<div><b>Sin ventas en este período: la rentabilidad aparece cuando vendas.</b> Mientras tanto podés dejar cargados los costos de tus productos, así el día que vendas ya ves cuánto te quedó.</div></div>
    <div class="card" style="max-width:640px"><h3>${I.upload} Costos de tus productos</h3>
      <p class="small muted">Descargá la plantilla con tus SKUs, completá el costo de compra y subila, o cargalos cuando tengas ventas.</p>
      <div class="help-links"><button class="btn btn-light btn-sm" id="tpl">${I.download} Descargar plantilla</button>
      <label class="btn btn-light btn-sm" for="file">${I.upload} Subir CSV o Excel</label><input type="file" id="file" class="sr" accept=".csv,.xlsx,.xls,text/csv"></div>
      <div id="upload-msg" class="small" style="margin-top:8px" role="status"></div></div>
    <div style="margin-top:16px">${costList()}</div>
    <div style="margin-top:16px">${helpBox()}</div>`;
  }
  const rows = profitRows();
  const money = (v) => (v == null ? '<span class="muted">—</span>' : fmtMoney(v));
  const cls = (v) => (v == null ? '' : v < 0 ? 'neg' : 'pos');
  const inputs = (p) => `<input inputmode="decimal" aria-label="Costo de compra de ${esc(p.title)}" data-cost="${esc(costKey(p.r.it))}" data-f="purchase" value="${p.purchase ?? ''}" placeholder="cargar">`;
  const inputsR = (p) => `<input inputmode="decimal" aria-label="Costo de reposición de ${esc(p.title)}" data-cost="${esc(costKey(p.r.it))}" data-f="replacement" value="${p.replacement ?? ''}" placeholder="opcional">`;
  const eats = (p) => (p.r.profit.shipEats ? `<span class="tag tag-bad" title="Envío ${fmtMoney(p.r.profit.fees.shipping)} + cargo fijo ${fmtMoney(p.r.profit.fixedFee)} = ${fmtPct(p.r.profit.shipFixedShare)} del precio">${I.alert} El envío gratis te come esta venta</span>` : '');
  const warn = (p) => (p.r.warning ? `<span class="tag tag-bad" title="${esc(p.r.warning)}">${I.alert} Debajo de reposición</span>` : '') + eats(p);
  const eatsN = S.model.rows.filter((r) => r.profit.shipEats).length;
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
    ${eatsN ? `<div class="notice notice-bad" role="alert">${I.alert}<div><b>El envío gratis te come la venta en ${eatsN} producto(s):</b> el envío y el cargo fijo se llevan más de la mitad del precio. Subí el precio, armá packs o dejá de ofrecer envío gratis en esos productos.</div></div>` : ''}
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

  <div style="margin-top:16px">${costList()}</div>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:22px 0 8px;flex-wrap:wrap">
    <h2 style="margin:0;font-size:1.25rem">Por producto</h2>
    <div style="display:flex;gap:8px;align-items:center"><label class="small" for="msort">Ordenar</label>
      <select id="msort" class="btn btn-light btn-sm">${COLS.map(([k2, l]) => `<option value="${k2}" ${S.sort.key === k2 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-primary btn-sm" id="save-costs" ${Object.keys(S.dirtyCosts).length ? '' : 'disabled'}>Guardar costos</button></div>
  </div>

  <div class="table-wrap desktop-only"><table class="data">
    <thead><tr>${COLS.map(([k2, l]) => sortBtn(k2, l)).join('')}</tr></thead>
    <tbody>${rows.map((p) => `<tr${p.r.profit.shipEats ? ' class="row-bad"' : ''}>
      <td class="prod"><b title="${esc(p.title)}">${itemLink(p.r.it.id, p.title)}</b><span class="tiny muted">${esc(costKey(p.r.it))}${p.r.profit.estimated ? ' · <span class="tag tag-neutral" style="padding:0 6px">estimado</span>' : ''}</span> ${warn(p)}</td>
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
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><b style="line-height:1.3">${itemLink(p.r.it.id, p.title)}</b>${p.r.profit.hasCost && p.units ? (p.net < 0 ? `<span class="tag tag-bad">${I.down} Pierde</span>` : `<span class="tag tag-ok">${I.up} Gana</span>`) : `<span class="tag tag-neutral">${p.r.profit.hasCost ? 'Sin ventas' : 'Costo sin cargar'}</span>`}</div>
    ${p.r.warning ? `<div class="notice notice-bad small" style="margin:8px 0;padding:8px 10px">${I.alert}<div>${esc(p.r.warning)}</div></div>` : ''}
    ${p.r.profit.shipEats ? `<div class="notice notice-bad small" style="margin:8px 0;padding:8px 10px">${I.alert}<div><b>El envío gratis te come esta venta:</b> envío ${fmtMoney(p.r.profit.fees.shipping)} + cargo fijo ${fmtMoney(p.r.profit.fixedFee)} = ${fmtPct(p.r.profit.shipFixedShare)} del precio.</div></div>` : ''}
    <div class="row"><span>Ventas</span><b>${p.units} u · ${p.units ? fmtMoney(p.revenue) : '—'}</b></div>
    <div class="row"><span>Cargos ML + publicidad</span><b>${p.units ? fmtMoney(p.fees + p.ads) : '—'}</b></div>
    <div class="row"><span>Ganancia neta</span><b class="${cls(p.net)}">${!p.r.profit.hasCost ? 'costo sin cargar' : p.units ? fmtMoney(p.net) : '—'}</b></div>
    <div class="row"><span>Margen / a reposición</span><b>${p.margin == null ? '—' : fmtPct(p.margin)} / ${p.marginR == null ? '—' : fmtPct(p.marginR)}</b></div>
    <div class="row"><span>Precio mín. / sugerido</span><b>${money(p.minPrice)} / ${money(p.suggested)}</b></div>
    <div class="pc-inputs"><div class="field"><label>Costo compra</label>${inputs(p)}</div><div class="field"><label>Costo reposición</label>${inputsR(p)}</div></div>
  </div>`).join('')}</div>
  <p class="tiny muted" style="margin-top:10px">Ganancia = precio − comisión − envío a tu cargo − cuotas − retenciones e impuestos − costo del producto − publicidad. Precio mínimo sin pérdida y sugerido (margen ${Math.round(THRESHOLDS.TARGET_MARGIN * 100)} %) se calculan con el mayor entre costo de compra y de reposición.</p>
  <div style="margin-top:16px">${helpBox('profit')}</div>`;
}

/** Lista de todas las publicaciones con su costo por unidad (guarda al salir del campo). Funciona sin SKU. */
function costList() {
  const byKey = new Map();
  for (const r of S.model.rows) { const k = costKey(r.it); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }
  const groups = [...byKey.entries()].sort((a, b) => (a[1][0].cost?.purchase != null) - (b[1][0].cost?.purchase != null) || (b[1][0].it.sales90 || 0) - (a[1][0].it.sales90 || 0));
  const missing = groups.filter(([, rs]) => rs[0].cost?.purchase == null).length;
  return `<section class="card cost-list" id="cost-list">
    <h3 style="margin-top:0">${I.money} Costo por unidad de cada publicación</h3>
    <p class="small cost-left" id="cost-left" role="status">${missing ? `<b>Te faltan cargar ${missing} costo${missing === 1 ? '' : 's'}.</b>` : `<b>${I.check} Tenés todos los costos cargados.</b>`} Se guarda solo cuando salís del campo. No hace falta SKU.</p>
    <ul class="cl">${groups.map(([k, rs]) => { const r = rs[0]; return `<li class="cl-row">
      <span class="cl-ph">${r.it.thumbnail ? `<img src="${esc(r.it.thumbnail)}" alt="" loading="lazy">` : I.tag}</span>
      <span class="cl-t">${itemLink(r.it.id, r.it.title)}<span class="tiny muted">${fmtMoney(r.it.price)}${rs.length > 1 ? ` · mismo SKU que ${rs.length - 1} publicación${rs.length > 2 ? 'es' : ''} más` : ''}</span></span>
      <span class="cl-in"><label class="tiny muted" for="cl-${esc(k)}">Costo por unidad</label><input id="cl-${esc(k)}" inputmode="decimal" placeholder="$" data-cl="${esc(k)}" value="${r.cost?.purchase ?? ''}"><span class="cl-ok tiny" aria-live="polite"></span></span>
    </li>`; }).join('')}</ul>
  </section>`;
}

let costReload = null;
async function saveOneCost(inp) {
  const k = inp.dataset.cl;
  const r = S.model.rows.find((x) => costKey(x.it) === k);
  const prev = r?.cost?.purchase ?? null;
  const v = parseNum(inp.value);
  const ok = inp.parentElement.querySelector('.cl-ok');
  if (Number.isNaN(v)) { ok.textContent = 'Poné un número'; ok.className = 'cl-ok tiny neg'; return; }
  if (v === prev || (v == null && prev == null)) return;
  ok.textContent = 'Guardando…'; ok.className = 'cl-ok tiny muted';
  const replacement = r?.cost?.replacement ?? null;
  try {
    if (DEMO) { if (v == null && replacement == null) delete S.demoData.costs[k]; else S.demoData.costs[k] = { purchase: v, replacement }; }
    else await api('/api/profit', { method: 'POST', body: { type: 'costs', costs: [{ sku: k, purchase: v, replacement }] } });
    for (const x of S.model.rows) if (costKey(x.it) === k) x.cost = v == null && replacement == null ? null : { purchase: v, replacement };
    ok.textContent = v == null ? 'Borrado' : 'Guardado'; ok.className = 'cl-ok tiny pos';
    const missing = new Set(S.model.rows.filter((x) => x.cost?.purchase == null).map((x) => costKey(x.it))).size;
    document.getElementById('cost-left').innerHTML = `${missing ? `<b>Te faltan cargar ${missing} costo${missing === 1 ? '' : 's'}.</b>` : '<b>Tenés todos los costos cargados.</b>'} Se guarda solo cuando salís del campo. No hace falta SKU.`;
    // Los números de ganancia se recalculan cuando dejás de cargar (sin perder el campo en el que estás).
    clearTimeout(costReload);
    costReload = setTimeout(async function again() {
      if (document.activeElement?.dataset?.cl) { costReload = setTimeout(again, 2500); return; }
      const y = window.scrollY;
      if (DEMO) { S.model = buildModel(S.demoData); S.summary = buildRuleSummary(S.model); render(); } else await loadReal().catch(() => {});
      window.scrollTo(0, y);
    }, 2500);
  } catch (e) { ok.textContent = e.message; ok.className = 'cl-ok tiny neg'; }
}

// ─────────────────────────────── Alertas ───────────────────────────────────
function alertsView() {
  if (!DEMO && !S.paid) return `<div class="page-head"><h1>Alertas</h1></div>${lockCard(COPY.alertsLock)}`;
  const alerts = S.model.alerts;
  const s = S.user || {};
  return `
  <div class="page-head"><div><h1>Alertas</h1><div class="small muted">${EMAIL_ENABLED ? 'Te avisamos por email solo cuando aparece algo nuevo.' : 'Las revisamos todos los días y te las mostramos acá, en tu panel. Las nuevas aparecen marcadas.'}</div></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">
    <section class="card">
      <h3>${I.bell} Alertas activas (${alerts.length})</h3>
      <div class="grid" style="gap:8px">${alerts.map((a) => `<div class="notice ${a.severity === 'bad' ? 'notice-bad' : 'notice-warn'}" style="padding:10px 12px">${a.severity === 'bad' ? I.alert : I.info}<div>${(S.seenUnread || []).includes(a.key) ? '<span class="tag tag-accent">Nueva</span> ' : ''}<span class="tag ${a.severity === 'bad' ? 'tag-bad' : 'tag-warn'}">${a.severity === 'bad' ? 'Urgente' : 'Atención'} · ${esc(ALERT_LABELS[a.kind] || a.kind)}</span>${a.title ? `<div style="font-weight:600;margin-top:4px">${itemLink(a.item_id, a.title)}</div>` : ''}<div class="small">${esc(a.message)}</div></div></div>`).join('') || `<div class="notice notice-ok">${I.checkCircle}<div>No hay alertas. Todo en orden.</div></div>`}</div>
    </section>
    ${EMAIL_ENABLED ? `    <section class="card">
      <h3>${I.mail} Configuración de email</h3>
      <form id="alert-form">
        <div class="field"><label for="al-email">Email para alertas</label><input id="al-email" type="email" autocomplete="email" value="${esc(s.alert_email || '')}" placeholder="tu@email.com" required></div>
        <div class="toggle"><label for="al-daily"><b>Alertas diarias</b><div class="small muted">Margen negativo, venta debajo de reposición, sin stock, pausadas, infracciones, preguntas sin responder +24 h y caída de reputación.</div></label><input id="al-daily" type="checkbox" ${s.alerts_enabled !== false ? 'checked' : ''}></div>
        <div class="toggle"><label for="al-weekly"><b>Resumen semanal (lunes)</b><div class="small muted">Lo más importante de la semana en un email.</div></label><input id="al-weekly" type="checkbox" ${s.weekly_enabled !== false ? 'checked' : ''}></div>
        <div class="help-links" style="margin-top:12px"><button class="btn btn-primary btn-sm" type="submit">Guardar</button><button class="btn btn-light btn-sm" type="button" id="al-test">Mandarme un email de prueba</button></div>
      </form>
      <p class="small" style="margin-top:12px">Vista previa: <a href="/api/email-preview?type=daily" target="_blank" rel="noopener">alerta diaria</a> · <a href="/api/email-preview?type=weekly" target="_blank" rel="noopener">resumen semanal</a></p>
    </section>` : `<section class="card">
      <h3>${I.mail} Alertas por email</h3>
      <div class="notice notice-info">${I.info}<div><b>Pronto: alertas por email.</b> Mientras tanto, las alertas y el resumen los ves acá, en tu panel, y en la pestaña Alertas aparece un número cuando hay nuevas.</div></div>
      <div class="toggle" style="opacity:.55"><label for="al-daily-off"><b>Alertas diarias por email</b><div class="small muted">Pronto</div></label><input id="al-daily-off" type="checkbox" disabled></div>
      <div class="toggle" style="opacity:.55"><label for="al-weekly-off"><b>Resumen semanal (lunes)</b><div class="small muted">Pronto</div></label><input id="al-weekly-off" type="checkbox" disabled></div>
    </section>`}
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
  if (route === 'publicacion') bindDetail();
  document.querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); location.hash = `#/publicacion/${b.dataset.gen}?generar=1`; }));
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    render();
    document.querySelector('.cat-filter')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.getElementById('disconnect')?.addEventListener('click', async () => {
    if (!confirm('¿Desconectar Mercado Libre? Rinde deja de leer tu cuenta. Tu diagnóstico, tus costos y tu suscripción quedan guardados para cuando vuelvas a conectar.')) return;
    try { await api('/api/auth/disconnect', { method: 'POST', body: { via: 'menu', confirmed: true } }); location.href = '/?desconectado=1'; } catch (e) { toast(e.message); }
  });
  document.getElementById('delete-data')?.addEventListener('click', async () => {
    const t = prompt('Esto borra para siempre tu diagnóstico, costos, alertas y conexión. No se puede deshacer.\n\nPara confirmar escribí BORRAR:');
    if (t == null) return;
    if (t.trim() !== 'BORRAR') { toast('No borramos nada: tenías que escribir BORRAR.'); return; }
    try { await api('/api/auth/delete', { method: 'POST', body: { confirm: 'BORRAR', via: 'menu' } }); location.href = '/?borrado=1'; } catch (e) { toast(e.message); }
  });
  document.getElementById('regen')?.addEventListener('click', () => {
    if (DEMO) { toast('En el demo los datos son fijos. Con tu cuenta, esto vuelve a leer todo desde Mercado Libre.'); return; }
    runConnecting(true);
  });

  if (route === 'campanas' || route === 'publicacion') bindSim();
  if (route === 'campanas') {
    document.getElementById('camp-refresh')?.addEventListener('click', () => { loadCampaigns(true); render(); });
    document.querySelectorAll('.camp-cost').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sku = f.dataset.sku;
      const raw = f.querySelector('input').value.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
      const val = raw === '' ? null : Number(raw);
      if (val != null && !(val >= 0)) return toast('Poné un número.');
      if (S.camp?.preview) return toast('Disponible en Plan Rinde.');
      if (!DEMO) {
        try { await api('/api/profit', { method: 'POST', body: { type: 'costs', costs: [{ sku, purchase: val }] } }); } catch (er) { return toast(er.message); }
      }
      for (const x of [...(S.camp.offers || []), ...(S.camp.ads || [])]) if ((x.item?.sku || '') === sku) x.item.cost = val;
      toast(val == null ? 'Costo borrado.' : 'Costo guardado. Recalculamos.');
      render();
    }));
  }

  if (route === 'publicaciones') {
    const L = S.list;
    const q = document.getElementById('lq');
    q?.addEventListener('input', () => { L.q = q.value; L.limit = 60; const pos = q.selectionStart; render(); const n = document.getElementById('lq'); n.focus(); n.setSelectionRange(pos, pos); });
    document.getElementById('ltone')?.addEventListener('change', (e) => { L.tone = e.target.value; L.limit = 60; render(); });
    document.getElementById('lgroup')?.addEventListener('change', (e) => { L.group = e.target.value; L.limit = 60; render(); });
    document.getElementById('lmore')?.addEventListener('click', () => { L.limit = (L.limit || 60) + 60; render(); });
    document.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.jump;
      Object.assign(L, { tone: 'todas', group: 'TODAS', q: '', limit: 1000 });
      render();
      document.getElementById(`it-l-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

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
    document.querySelectorAll('input[data-cl]').forEach((inp) => {
      inp.addEventListener('change', () => saveOneCost(inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
  }
  if (route === 'alertas' && (DEMO || S.paid) && (S.unread || []).length) {
    // Se marcan como leídas al abrir la pestaña; en esta visita siguen marcadas como "Nueva".
    S.seenUnread = S.unread.map((x) => x.key);
    S.unread = [];
    if (!DEMO) api('/api/settings', { method: 'POST', body: { action: 'alerts_read' } }).catch(() => {});
    setTimeout(render, 0);
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
    { // Demo: el plan de cada publicación suma lo que dicen Campañas y publicidad.
      const acts = actionsByItem(evaluateAll(getCampaignsDemo()));
      for (const r of S.model.rows) if (acts[r.it.id] && r.plan) r.plan = { ...r.plan, actions: [...acts[r.it.id], ...(r.plan.actions || [])].slice(0, 6) };
    }
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
  S.unread = d.unreadAlerts || [];
  S.campaigns = d.campaigns || null;
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
    if (new URLSearchParams(location.search).has('cuentanueva')) {
      // Variante: cuenta chica que no vende (4 publicaciones sin ventas en 6 meses).
      S.demoData.items = S.demoData.items.slice(0, 4).map((it, k) => ({ ...it, status: k % 2 ? 'paused' : 'active', sales30: 0, sales90: 0, sales180: 0, revenue180: 0, visits30: k ? 0 : 1, hist: undefined }));
      S.demoData.lines = [];
      S.demoData.revenue = { ...S.demoData.revenue, d30: 0, d90: 0, d180: 0, orders30: 0, months: {} };
    }
    if (new URLSearchParams(location.search).has('temporada')) {
      // Variante de ejemplo: una tienda que vende sobre todo productos de invierno.
      const winter = ['Campera Polar Mujer Abrigo Invierno Capucha Corderito Talles', 'Frazada Polar Doble Faz Corderito 2 Plazas Invierno', 'Estufa Halógena 1200W 3 Velas Bajo Consumo', 'Pantuflas Corderito Mujer Invierno Suela Antideslizante', 'Bufanda Tejida Lana Invierno Unisex Colores', 'Pijama Polar Enterito Adulto Invierno Capucha', 'Guantes Térmicos Touch Invierno Moto Bici'];
      const top = [...S.demoData.items].sort((a, b) => (b.sales90 || 0) - (a.sales90 || 0)).slice(0, winter.length);
      top.forEach((it, k) => { it.title = winter[k]; it.hist = { ...it.hist, months: { 5: 12, 6: 18, 7: 15, 8: 9, 9: 2, 10: 1 } }; });
      const d30 = S.demoData.revenue.d30;
      S.demoData.revenue.months = { '2026-05': { amount: d30 * 1.4 }, '2026-06': { amount: d30 * 2.1 }, '2026-07': { amount: d30 * 2.0 }, '2026-08': { amount: d30 * 1.3 }, '2026-09': { amount: d30 * 0.5 }, '2026-10': { amount: d30 * 0.45 }, '2026-11': { amount: d30 * 0.05 } };
    }
    S.model = buildModel(S.demoData);
    S.summary = buildRuleSummary(S.model);
    S.unread = S.model.alerts.slice(0, 4).map((x) => ({ ...x, created_at: new Date().toISOString() })); // demo: algunas sin leer
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

// El plan se relee del servidor: si lo activaron (o se venció) con la página abierta, se actualiza sin recargar.
let planCheckAt = 0;
async function refreshPlan(force = false) {
  if (DEMO || !S.model || (!force && Date.now() - planCheckAt < 20000)) return;
  planCheckAt = Date.now();
  try {
    const me = await api('/api/me');
    if (planChanged(S.paid, me)) { S.camp = null; await loadReal(); }
    else S.user = { ...S.user, ...me.user };
  } catch { /* sin conexión: se reintenta en el próximo cambio */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshPlan(); });
// Antes de cambiar de pantalla se guarda el scroll; al abrir un detalle se recuerda de dónde se vino (para "Volver").
let lastHash = location.hash;
window.addEventListener('scroll', () => { if (S.model) S.scroll[location.hash] = window.scrollY; }, { passive: true });
window.addEventListener('hashchange', () => {
  const was = lastHash; lastHash = location.hash;
  if (currentRoute() === 'publicacion') { if (!/^#\/publicacion\//.test(was || '')) S.back = was || '#/diagnostico'; delete S.scroll[location.hash]; S.blkOpen = {}; }
  else S.back = null;
  if (S.model && currentRoute() !== 'conectando') { render(); refreshPlan(); }
});
boot();
