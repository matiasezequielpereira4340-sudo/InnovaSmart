import { I, hydrateIcons } from './icons.js';
import { DEMO_ADMIN_USERS } from '../shared/demo-data.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (d) => (d ? new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
let key = '';
try { key = sessionStorage.getItem('rinde_admin') || ''; } catch {}
let users = [];
let q = '';

async function call(method, body) {
  const r = await fetch('/api/admin', { method, headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Error'), { status: r.status });
  return d;
}

function loginView(err) {
  root.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto">
    <h1 style="font-size:1.4rem">${I.lock} Panel admin</h1>
    <form id="f"><div class="field"><label for="k">Clave de administrador</label><input id="k" type="password" autocomplete="current-password" required></div>
    ${err ? `<div class="notice notice-bad small" style="margin-top:10px">${I.alert}<div>${esc(err)}</div></div>` : ''}
    <button class="btn btn-primary btn-block" style="margin-top:12px">Entrar</button></form>
    <p class="small muted" style="margin-top:12px"><a href="/admin?demo=1">Ver con datos de ejemplo</a></p></div>`;
  hydrateIcons(root);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = document.getElementById('k').value;
    try { await load(); try { sessionStorage.setItem('rinde_admin', key); } catch {} } catch (er) { loginView(er.message); }
  });
}

function listView() {
  const list = users.filter((u) => !q || `${u.nickname} ${u.alert_email || ''} ${u.meli_user_id}`.toLowerCase().includes(q.toLowerCase()));
  const paid = users.filter((u) => u.plan === 'rinde').length;
  root.innerHTML = `${DEMO ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Vista previa con <b>usuarios de ejemplo</b>. Los botones no cambian nada real.</div></div>` : ''}
  <div class="page-head" style="padding-top:0"><div><h1>Usuarios</h1><div class="small muted">${users.length} usuarios · ${paid} con Plan Rinde · ingreso estimado $${(paid * 15000).toLocaleString('es-AR')}/mes</div></div>
  <div class="field" style="min-width:240px"><label for="q" class="sr">Buscar</label><input id="q" placeholder="Buscar por usuario o email" value="${esc(q)}"></div></div>
  <div class="table-wrap"><table class="data" style="min-width:680px">
  <thead><tr><th>Usuario</th><th>Plan</th><th>Alta</th><th>Diagnóstico gratis</th><th>Último ingreso</th><th>Acción</th></tr></thead>
  <tbody>${list.map((u) => `<tr>
    <td><b>${esc(u.nickname || '—')}</b><div class="tiny muted">ID MeLi ${esc(u.meli_user_id)}${u.alert_email ? ' · ' + esc(u.alert_email) : ''}</div></td>
    <td>${u.plan === 'rinde' ? `<span class="tag tag-ok">${I.check} Plan Rinde</span><div class="tiny muted">desde ${date(u.plan_activated_at)}</div>` : `<span class="tag tag-neutral">Gratis</span>`}</td>
    <td>${date(u.created_at)}</td>
    <td>${u.free_diagnosis_used_at ? `<span class="tag tag-accent">Usado ${date(u.free_diagnosis_used_at)}</span>` : '<span class="muted small">Sin usar</span>'}</td>
    <td>${date(u.last_login_at)}</td>
    <td>${u.plan === 'rinde' ? `<button class="btn btn-light btn-sm" data-id="${esc(u.id)}" data-plan="free">Desactivar plan</button>` : `<button class="btn btn-primary btn-sm" data-id="${esc(u.id)}" data-plan="rinde">Activar Plan Rinde</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Sin usuarios.</td></tr>'}</tbody></table></div>`;
  hydrateIcons(root);
  const qi = document.getElementById('q');
  qi.addEventListener('input', () => { q = qi.value; listView(); const n = document.getElementById('q'); n.focus(); n.setSelectionRange(q.length, q.length); });
  root.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.find((x) => x.id === b.dataset.id);
    if (!confirm(`¿${b.dataset.plan === 'rinde' ? 'Activar' : 'Desactivar'} el Plan Rinde para ${u.nickname}?`)) return;
    if (DEMO) { u.plan = b.dataset.plan; u.plan_activated_at = b.dataset.plan === 'rinde' ? new Date().toISOString() : null; return listView(); }
    b.disabled = true;
    try { await call('POST', { user_id: u.id, plan: b.dataset.plan }); await load(); } catch (e) { alert(e.message); b.disabled = false; }
  }));
}

async function load() {
  if (DEMO) { users = JSON.parse(JSON.stringify(DEMO_ADMIN_USERS)); return listView(); }
  const d = await call('GET');
  users = d.users;
  document.getElementById('logout').hidden = false;
  listView();
}

document.getElementById('logout').addEventListener('click', () => { try { sessionStorage.removeItem('rinde_admin'); } catch {} key = ''; loginView(); });
hydrateIcons();
if (DEMO || key) load().catch((e) => loginView(e.status === 401 ? 'Clave incorrecta.' : e.message));
else loginView();
