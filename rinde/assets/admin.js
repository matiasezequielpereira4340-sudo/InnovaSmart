import { I, hydrateIcons } from './icons.js';
import { DEMO_ADMIN_USERS } from '../shared/demo-data.js';
import { fmtMoney } from '../shared/rules.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (d) => (d ? new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const dateTime = (d) => (d ? new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
let key = '';
try { key = sessionStorage.getItem('rinde_admin') || ''; } catch {}
let users = [];
let q = '';
let selUser = null;
let run = null;
let busy = false;
let valError = '';

const tab = () => (location.hash === '#validacion' ? 'validacion' : 'usuarios');

async function call(method, body, qs = '') {
  const r = await fetch('/api/admin' + qs, { method, headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Algo falló. Reintentá en unos minutos.'), { status: r.status });
  return d;
}

function loginView(err) {
  root.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto">
    <h1 style="font-size:1.5rem">${I.lock} Panel admin</h1>
    <form id="f"><div class="field"><label for="k">Clave de administrador</label><input id="k" type="password" autocomplete="current-password" required></div>
    ${err ? `<div class="notice notice-bad small" style="margin-top:10px">${I.alert}<div>${esc(err)}</div></div>` : ''}
    <button class="btn btn-primary btn-block" style="margin-top:12px">Entrar</button></form>
    <p class="small muted" style="margin-top:12px"><a href="/admin?demo=1">Ver con datos de ejemplo</a> · <a href="/admin?demo=1#validacion">Validación con datos simulados</a></p></div>`;
  hydrateIcons(root);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = document.getElementById('k').value;
    try { await load(); try { sessionStorage.setItem('rinde_admin', key); } catch {} } catch (er) { loginView(er.message); }
  });
}

function tabsBar() {
  const t = tab();
  return `${DEMO ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Estás viendo <b>datos de ejemplo</b>${t === 'validacion' ? ': respuestas simuladas de Mercado Libre, con casos difíciles a propósito' : ''}. Los botones no cambian nada real.</div></div>` : ''}
  <nav class="cat-filter" aria-label="Secciones del admin" style="padding-top:0">
    <a class="chip" href="#usuarios" aria-pressed="${t === 'usuarios'}">${I.user} Usuarios</a>
    <a class="chip" href="#validacion" aria-pressed="${t === 'validacion'}">${I.checkCircle} Validación</a>
  </nav>`;
}

function usersView() {
  const list = users.filter((u) => !q || `${u.nickname} ${u.alert_email || ''} ${u.meli_user_id}`.toLowerCase().includes(q.toLowerCase()));
  const paid = users.filter((u) => u.plan === 'rinde').length;
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Usuarios</h1><div class="small muted">${users.length} usuarios · ${paid} con Plan Rinde · ingreso estimado <span class="num">$${(paid * 15000).toLocaleString('es-AR')}</span>/mes</div></div>
  <div class="field" style="min-width:240px"><label for="q" class="sr">Buscar</label><input id="q" placeholder="Buscar por usuario o email" value="${esc(q)}"></div></div>
  <div class="table-wrap"><table class="data" style="min-width:720px">
  <thead><tr><th>Usuario</th><th>Plan</th><th>Alta</th><th>Diagnóstico gratis</th><th>Último ingreso</th><th>Acción</th></tr></thead>
  <tbody>${list.map((u) => `<tr>
    <td><b>${esc(u.nickname || '—')}</b><div class="tiny muted">ID MeLi ${esc(u.meli_user_id)}${u.alert_email ? ' · ' + esc(u.alert_email) : ''}</div></td>
    <td>${u.plan === 'rinde' ? `<span class="tag tag-ok">${I.check} Plan Rinde</span><div class="tiny muted">desde ${date(u.plan_activated_at)}</div>` : `<span class="tag tag-neutral">Gratis</span>`}</td>
    <td>${date(u.created_at)}</td>
    <td>${u.free_diagnosis_used_at ? `<span class="tag tag-accent">Usado ${date(u.free_diagnosis_used_at)}</span>` : '<span class="muted small">Sin usar</span>'}</td>
    <td>${date(u.last_login_at)}</td>
    <td>${u.plan === 'rinde' ? `<button class="btn btn-light btn-sm" data-id="${esc(u.id)}" data-plan="free">Desactivar plan</button>` : `<button class="btn btn-primary btn-sm" data-id="${esc(u.id)}" data-plan="rinde">Activar Plan Rinde</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Todavía no hay usuarios. Aparecen acá cuando alguien conecta su cuenta.</td></tr>'}</tbody></table></div>`;
  hydrateIcons(root);
  const qi = document.getElementById('q');
  qi.addEventListener('input', () => { q = qi.value; usersView(); const n = document.getElementById('q'); n.focus(); n.setSelectionRange(q.length, q.length); });
  root.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.find((x) => x.id === b.dataset.id);
    if (!confirm(`¿${b.dataset.plan === 'rinde' ? 'Activar' : 'Desactivar'} el Plan Rinde para ${u.nickname}?`)) return;
    if (DEMO) { u.plan = b.dataset.plan; u.plan_activated_at = b.dataset.plan === 'rinde' ? new Date().toISOString() : null; return usersView(); }
    b.disabled = true;
    try { await call('POST', { user_id: u.id, plan: b.dataset.plan }); await load(); } catch (e) { alert(e.message); b.disabled = false; }
  }));
}

// ─────────────────────────────── Validación ────────────────────────────────
const money = (v) => (v == null ? '<span class="muted">sin dato</span>' : fmtMoney(v));
function diffCell(d) {
  if (!d) return '<span class="muted">—</span>';
  const pct = (d.pct * 100).toFixed(1).replace('.', ',') + ' %';
  const amt = (d.amount > 0 ? '+' : '') + fmtMoney(d.amount);
  if (d.alert) return `<span class="tag tag-bad">${I.alert} ${amt} · ${pct}</span>`;
  return `<span class="tag tag-ok">${I.check} ${Math.abs(d.amount) < 1 ? 'igual' : amt}</span>`;
}

function saleCard(s) {
  const src = s.source === 'facturación' ? `<span class="tag tag-ok">${I.check} Usa facturación</span>` : `<span class="tag tag-warn">${I.info} Estimado con la orden</span>`;
  const al = s.alerts ? `<span class="tag tag-bad">${I.alert} ${s.alerts} diferencia(s) +2 %</span>` : `<span class="tag tag-ok">${I.check} Sin diferencias +2 %</span>`;
  const fmt = s.formatOk === false ? `<span class="tag tag-bad">${I.x} Formato distinto</span>` : '';
  return `<article class="card" style="padding:0;overflow:hidden">
    <div style="padding:14px 16px;display:grid;gap:8px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start"><b style="min-width:0">${esc(s.title)}</b><span class="num small">${fmtMoney(s.gross)}</span></div>
      <div class="tiny muted num">Venta #${esc(s.order_id)} · ${dateTime(s.date)} · ${s.qty} u${s.billingParam ? ` · facturación vía ?${esc(s.billingParam)}=` : ''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${src}${al}${fmt}</div>
      ${s.flags.length ? `<ul class="small" style="margin:2px 0 0;padding-left:18px;color:var(--ink-2)">${s.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="mobile-only" style="border-top:1px solid var(--line)">${s.rows.map((r) => `<div style="padding:10px 16px;border-bottom:1px dashed var(--line);display:grid;gap:4px${r.key === 'net' ? ';font-weight:600' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(r.label)}</span><span class="num">${money(r.rinde)}</span></div>
      <div class="tiny muted num">MeLi ${money(r.billing)} · Orden ${money(r.order)}</div>
      ${r.dRB?.alert || r.dOB?.alert ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${r.dRB?.alert ? `<span class="tiny">vs MeLi</span> ${diffCell(r.dRB)}` : ''}${r.dOB?.alert ? `<span class="tiny">orden vs MeLi</span> ${diffCell(r.dOB)}` : ''}</div>` : ''}
    </div>`).join('')}</div>
    <div class="table-wrap desktop-only" style="border:0;border-top:1px solid var(--line);border-radius:0">
      <table class="data" style="min-width:820px">
        <thead><tr><th>Concepto</th><th>Rinde</th><th>Facturación MeLi</th><th>Orden</th><th>Rinde vs facturación</th><th>Orden vs facturación</th></tr></thead>
        <tbody>${s.rows.map((r) => `<tr${r.key === 'net' ? ' style="font-weight:600"' : ''}>
          <td>${esc(r.label)}</td><td>${money(r.rinde)}</td><td>${money(r.billing)}</td><td>${money(r.order)}</td><td>${diffCell(r.dRB)}</td><td>${diffCell(r.dOB)}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    ${s.billingLines.length ? `<details style="border-top:1px dashed var(--line-strong)"><summary class="small" style="padding:10px 16px;cursor:pointer;color:var(--accent);font-weight:600">Ver líneas de la facturación (${s.billingLines.length})</summary>
      <div class="table-wrap" style="border:0;border-radius:0"><table class="data" style="min-width:620px"><thead><tr><th>Descripción</th><th>Tipo</th><th>Código</th><th>Monto</th><th>Rinde lo toma como</th></tr></thead>
      <tbody>${s.billingLines.map((l) => `<tr><td>${esc(l.desc || '—')}</td><td>${esc(l.type || '—')}</td><td>${esc(l.sub || '—')}</td><td>${fmtMoney(l.signed)}</td><td>${l.category === 'other' ? `<span class="tag tag-warn">${I.info} sin clasificar</span>` : esc({ commission: 'Comisión', shipping: 'Envío', financing: 'Cuotas', taxes: 'Retenciones' }[l.category])}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
  </article>`;
}

function validationView() {
  const connected = users.filter((u) => u.connected);
  const r = run?.report;
  const sm = r?.summary;
  const c = r?.competition;
  const kpi = (label, value, sub, tone = '') => `<div class="kpi ${tone}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`;
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Validación</h1><div class="small muted">Las últimas 10 ventas de una cuenta real: lo que calcula Rinde contra la facturación de Mercado Libre y la orden. Marcamos en rojo cuando la diferencia pasa el 2 %.</div></div></div>
  <div class="card" style="display:grid;gap:12px;margin-bottom:14px">
    ${connected.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1 1 240px"><label for="vu">Cuenta conectada</label><select id="vu">${connected.map((u) => `<option value="${esc(u.id)}" ${selUser === u.id ? 'selected' : ''}>${esc(u.nickname)} · ID ${esc(u.meli_user_id)}</option>`).join('')}</select></div>
      <button class="btn btn-primary" id="vrun" ${busy ? 'disabled' : ''}>${busy ? `${I.loader.replace('<svg', '<svg class="spin"')} Consultando Mercado Libre…` : `${I.refresh} Validar últimas 10 ventas`}</button></div>`
      : `<div class="notice notice-info">${I.info}<div>Todavía no hay cuentas conectadas. Conectá la tuya desde <a href="/">la página de inicio</a> y volvé acá.</div></div>`}
    ${valError ? `<div class="notice notice-bad" role="alert">${I.alert}<div>${esc(valError)}</div></div>` : ''}
    ${run ? `<div class="tiny muted">Corrida del ${dateTime(run.created_at || r.created_at)}${DEMO ? ' · simulada' : ''}</div>` : ''}
  </div>
  ${r ? `
  ${sm.ordersError ? `<div class="notice notice-bad" style="margin-bottom:12px">${I.alert}<div>${esc(sm.ordersError)}</div></div>` : ''}
  <div class="kpis" style="margin-bottom:12px">
    ${kpi('Ventas analizadas', sm.sales, `${sm.withBilling} con facturación · ${sm.estimated} estimadas`)}
    ${kpi('Con diferencia +2 %', sm.withAlerts, 'ventas a revisar', sm.withAlerts ? 'is-bad' : 'is-ok')}
    ${kpi('Formato distinto', sm.formatProblems, 'respuestas que no coinciden', sm.formatProblems ? 'is-bad' : 'is-ok')}
    ${kpi('Competencia sin dato', `${c.sinDato}/${c.total}`, `${Math.round(c.pct * 100)} % de las publicaciones`, c.pct > 0.3 ? 'is-bad' : '')}
  </div>
  <div class="grid" style="margin-bottom:16px">
    <div class="notice notice-info">${I.info}<div>La facturación respondió con el parámetro <b class="num">${esc(sm.billingParam)}</b>. ${sm.noTaxes ? `En ${sm.noTaxes} de ${sm.withBilling} ventas facturadas no vinieron retenciones.` : ''} Competencia sin dato: ${c.catalogoSinDato} de catálogo y ${c.busquedaSinDato} sin catálogo.</div></div>
  </div>
  <div class="grid" style="gap:12px">${r.sales.map(saleCard).join('') || '<div class="empty">Esta cuenta no tiene ventas pagas recientes.</div>'}</div>
  <details class="card" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">Respuesta cruda de Mercado Libre (sin tokens ni datos del comprador)</summary>
    <p class="small muted" style="margin:10px 0">Así devolvió los datos Mercado Libre. Sirve para revisar el formato real.</p>
    <button class="btn btn-light btn-sm" id="vcopy" type="button">Copiar</button>
    <pre id="vraw" style="margin-top:10px;max-height:420px;overflow:auto;background:var(--sunken);padding:12px;border-radius:8px;font:12px/1.5 var(--font-num);white-space:pre">${esc(JSON.stringify(run.raw, null, 2))}</pre>
  </details>` : (connected.length ? '<div class="empty">Elegí la cuenta y tocá "Validar últimas 10 ventas".</div>' : '')}`;
  hydrateIcons(root);
  document.getElementById('vu')?.addEventListener('change', async (e) => { selUser = e.target.value; run = null; await loadLastRun(); });
  document.getElementById('vrun')?.addEventListener('click', runValidation);
  document.getElementById('vcopy')?.addEventListener('click', async () => {
    const t = document.getElementById('vraw').textContent;
    try { await navigator.clipboard.writeText(t); document.getElementById('vcopy').textContent = 'Copiado'; } catch { const sel = getSelection(); const rg = document.createRange(); rg.selectNodeContents(document.getElementById('vraw')); sel.removeAllRanges(); sel.addRange(rg); }
  });
}

async function demoRun() {
  const [{ buildValidationReport, scrub }, { getValidationDemoInput }] = await Promise.all([import('../shared/validation.js'), import('../shared/validation-demo.js')]);
  const input = getValidationDemoInput();
  run = { report: buildValidationReport(input), raw: scrub({ orders_search: { status: 200, body: { results: input.orders } }, por_venta: input.calls }), created_at: new Date().toISOString() };
}

async function loadLastRun() {
  if (DEMO) { await demoRun(); return render(); }
  if (!selUser) return render();
  try { const d = await call('GET', null, `?view=validation&user_id=${encodeURIComponent(selUser)}`); run = d.run; valError = ''; } catch (e) { valError = e.message; }
  render();
}

async function runValidation() {
  if (DEMO) { await demoRun(); return render(); }
  busy = true; valError = ''; render();
  try { const d = await call('POST', { action: 'validate', user_id: selUser }); run = d.run; } catch (e) { valError = e.message; }
  busy = false; render();
}

function render() { return tab() === 'validacion' ? validationView() : usersView(); }

async function load() {
  if (DEMO) {
    users = JSON.parse(JSON.stringify(DEMO_ADMIN_USERS)).map((u, i) => ({ ...u, connected: i === 0 }));
    selUser = users[0].id;
    if (tab() === 'validacion' && !run) await demoRun();
    return render();
  }
  const d = await call('GET');
  users = d.users;
  document.getElementById('logout').hidden = false;
  if (!selUser) selUser = users.find((u) => u.connected)?.id || null;
  if (tab() === 'validacion' && selUser && !run) return loadLastRun();
  render();
}

window.addEventListener('hashchange', () => { if (!users.length && !DEMO) return; if (tab() === 'validacion' && !run) return DEMO ? demoRun().then(render) : loadLastRun(); render(); });
document.getElementById('logout').addEventListener('click', () => { try { sessionStorage.removeItem('rinde_admin'); } catch {} key = ''; loginView(); });
hydrateIcons();
if (DEMO || key) load().catch((e) => loginView(e.status === 401 ? 'Clave incorrecta.' : e.message));
else loginView();
