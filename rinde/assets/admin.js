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
let probe = null;
let acct = null; // facturación real + estimado de la cuenta elegida
let acctBusy = '';
let acctMsg = '';

const TABS = ['usuarios', 'cobros', 'pagos', 'validacion', 'conexiones'];
const tab = () => { const h = location.hash.replace('#', ''); return TABS.includes(h) ? h : 'usuarios'; };
let billingCfg = null;
let payments = null;
let payFilter = 'pendientes';
let payMsg = '';
let health = null;
let auditData = null;
let usersError = '';
let loggedIn = false;

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
    <p class="small muted" style="margin-top:12px"><a href="/admin?demo=1">Ver con datos de ejemplo</a> · <a href="/admin?demo=1#validacion">Validación simulada</a> · <a href="/admin?demo=1#conexiones">Conexiones (ejemplo)</a></p></div>`;
  hydrateIcons(root);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = document.getElementById('k').value;
    try { await load(); try { sessionStorage.setItem('rinde_admin', key); } catch {} } catch (er) { key = ''; loginView(er.message); }
  });
}

function tabsBar() {
  const t = tab();
  return `${DEMO ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Estás viendo <b>datos de ejemplo</b>${t === 'validacion' ? ': respuestas simuladas de Mercado Libre, con casos difíciles a propósito' : ''}. Los botones no cambian nada real.</div></div>` : ''}
  <nav class="cat-filter" aria-label="Secciones del admin" style="padding-top:0">
    <a class="chip" href="#usuarios" aria-pressed="${t === 'usuarios'}">${I.user} Usuarios</a>
    <a class="chip" href="#cobros" aria-pressed="${t === 'cobros'}">${I.money} Cobros</a>
    <a class="chip" href="#pagos" aria-pressed="${t === 'pagos'}">${I.tag} Pagos por facturar</a>
    <a class="chip" href="#validacion" aria-pressed="${t === 'validacion'}">${I.checkCircle} Validación</a>
    <a class="chip" href="#conexiones" aria-pressed="${t === 'conexiones'}">${I.plug} Conexiones</a>
  </nav>`;
}

function usersView() {
  const list = users.filter((u) => !q || `${u.nickname} ${u.alert_email || ''} ${u.meli_user_id}`.toLowerCase().includes(q.toLowerCase()));
  const paid = users.filter((u) => u.plan === 'rinde').length;
  root.innerHTML = `${tabsBar()}
  ${usersError ? `<div class="notice notice-bad" style="margin-bottom:12px">${I.alert}<div>${esc(usersError)} Mirá la pestaña <a href="#conexiones">Conexiones</a>.</div></div>` : ''}
  <div class="page-head" style="padding-top:4px"><div><h1>Usuarios</h1><div class="small muted">${users.length} usuarios · ${paid} con Plan Rinde · ingreso estimado <span class="num">$${(paid * 15000).toLocaleString('es-AR')}</span>/mes</div></div>
  <div class="field" style="min-width:240px"><label for="q" class="sr">Buscar</label><input id="q" placeholder="Buscar por usuario o email" value="${esc(q)}"></div></div>
  <div class="table-wrap"><table class="data" style="min-width:720px">
  <thead><tr><th>Usuario</th><th>Plan</th><th>Cobro</th><th>Alta</th><th>Diagnóstico gratis</th><th>Último ingreso</th><th>Acción</th></tr></thead>
  <tbody>${list.map((u) => `<tr>
    <td><b>${esc(u.nickname || '—')}</b><div class="tiny muted">ID MeLi ${esc(u.meli_user_id)}${u.alert_email ? ' · ' + esc(u.alert_email) : ''}</div></td>
    <td>${u.plan === 'rinde' ? `<span class="tag tag-ok">${I.check} Plan Rinde</span><div class="tiny muted">desde ${date(u.plan_activated_at)}</div>` : `<span class="tag tag-neutral">Gratis</span>`}</td>
    <td>${billingTag(u)}</td>
    <td>${date(u.created_at)}</td>
    <td>${u.free_diagnosis_used_at ? `<span class="tag tag-accent">Usado ${date(u.free_diagnosis_used_at)}</span>` : '<span class="muted small">Sin usar</span>'}</td>
    <td>${date(u.last_login_at)}</td>
    <td>${u.plan === 'rinde' ? `<button class="btn btn-light btn-sm" data-id="${esc(u.id)}" data-plan="free">Desactivar plan</button>` : `<button class="btn btn-primary btn-sm" data-id="${esc(u.id)}" data-plan="rinde">Activar Plan Rinde</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="empty">Todavía no hay usuarios. Aparecen acá cuando alguien conecta su cuenta.</td></tr>'}</tbody></table></div>`;
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

const STATUS = { trial: ['tag-accent', 'Prueba gratis'], active: ['tag-ok', 'Al día'], manual: ['tag-ok', 'Transferencia'], past_due: ['tag-warn', 'En gracia'], canceled: ['tag-neutral', 'Cancelada'], lapsed: ['tag-bad', 'Cortado'] };
function billingTag(u) {
  if (!u.billing_status) return '<span class="muted small">—</span>';
  const [cls, label] = STATUS[u.billing_status] || ['tag-neutral', u.billing_status];
  const until = u.billing_status === 'past_due' ? `gracia hasta ${date(u.grace_until)}` : u.plan_expires_at ? `vence ${date(u.plan_expires_at)}` : '';
  return `<span class="tag ${cls}">${esc(label)}</span><div class="tiny muted">${u.plan_interval === 'annual' ? 'Anual' : u.plan_interval === 'monthly' ? 'Mensual' : ''}${until ? ' · ' + until : ''}</div>`;
}

// ─────────────────────────────── Cobros ────────────────────────────────────
const DEMO_CFG = { monthly_price: 15000, annual_price: 150000, annual_valid_until: '2026-12-31', trial_days: 3, grace_days: 5, remind_days_before: 5, whatsapp: '5491160374306', bank: { holder: 'Matías Ezequiel Pereira', cuit: '20-00000000-0', bank: 'Banco de ejemplo', cbu: '0000000000000000000000', alias: 'RINDE.EJEMPLO' } };

// ─────────────────────────────── Cobros: guía de prueba, avisos y paso a producción ───
let billingEnv = null;
let billingEvents = null;
const TEST_CARDS = [
  ['Mastercard', '5031 7557 3453 0604', '123', '11/30'],
  ['Visa', '4509 9535 6623 3704', '123', '11/30'],
  ['American Express', '3711 803032 57522', '1234', '11/30'],
];
const checkKey = 'rinde_prod_checklist';
function checklistState() { try { return JSON.parse(localStorage.getItem(checkKey) || '{}'); } catch { return {}; } }
function saveChecklist(st) { try { localStorage.setItem(checkKey, JSON.stringify(st)); } catch {} }

function eventsCard() {
  const rows = billingEvents;
  const okOf = (r) => !r.error && !/^(error|rechazado)$/.test(r.result || '');
  const TOPIC = { subscription_preapproval: 'Suscripción', preapproval: 'Suscripción', subscription_authorized_payment: 'Cobro de la suscripción', authorized_payment: 'Cobro de la suscripción', payment: 'Pago' };
  return `<section class="card" aria-labelledby="ev-h" style="display:grid;gap:10px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><h3 id="ev-h" style="margin:0">${I.bell} Avisos del webhook de Mercado Pago</h3><button class="btn btn-light btn-sm" id="ev-reload" type="button">${I.refresh} Actualizar</button></div>
    <p class="small muted" style="margin:0">Cada aviso que manda Mercado Pago a <span class="num">/api/mp-webhook</span>: cuándo llegó, de qué es, qué hizo Rinde y si salió bien. Si probás y acá no aparece nada, el aviso no llegó (revisá la URL y los eventos del webhook en Mercado Pago).</p>
    ${!rows ? '<div class="small muted">Cargando…</div>' : rows.error ? `<div class="notice notice-bad small">${I.alert}<div>${esc(rows.error)}</div></div>` : !rows.length ? '<div class="empty" style="padding:12px">Todavía no llegó ningún aviso.</div>'
      : `<div style="display:grid;gap:6px">${rows.map((r) => `<div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;align-items:center;border-bottom:1px dashed var(--line);padding:6px 0">
        <span style="display:grid;gap:2px;min-width:0"><b class="small">${esc(TOPIC[r.topic] || r.topic || 'sin tipo')}</b><span class="tiny muted num" style="overflow-wrap:anywhere">${dateTime(r.created_at)} · id ${esc(r.resource_id || '—')}</span></span>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="small">${esc(r.result || '')}${r.error ? ` · ${esc(r.error)}` : ''}</span>${okOf(r) ? `<span class="tag tag-ok">${I.check} OK</span>` : `<span class="tag tag-bad">${I.x} Falló</span>`}</span></div>`).join('')}</div>`}
  </section>`;
}

function guideCard() {
  const env = billingEnv || {};
  const step = (n, title, body, see) => `<li class="gstep"><b>${n}. ${title}</b><div class="small">${body}</div>${see ? `<div class="gsee small"><b>Qué tenés que ver en Rinde:</b> ${see}</div>` : ''}</li>`;
  return `<section class="card guide" aria-labelledby="gp-h" style="display:grid;gap:10px">
    <h3 id="gp-h" style="margin:0">${I.checkCircle} Guía de prueba (Mercado Pago en modo prueba)</h3>
    <div class="notice ${env.mpConfigured && env.mpTest && env.webhookSecret ? 'notice-ok' : 'notice-warn'} small">${env.mpConfigured && env.mpTest && env.webhookSecret ? I.checkCircle : I.info}<div>Estado hoy: ${env.mpConfigured ? 'credencial de Mercado Pago cargada' : '<b>falta MP_ACCESS_TOKEN</b>'}${env.mpConfigured ? (env.mpTest ? ' (modo prueba)' : ' (<b>parece de producción</b>: para probar usá credenciales de prueba)') : ''} · ${env.webhookSecret ? 'clave del webhook cargada' : '<b>falta MP_WEBHOOK_SECRET</b>'}. Lo mismo lo ves en Conexiones.</div></div>
    <ol class="gsteps">
      ${step(1, 'Creá los usuarios de prueba en Mercado Pago', `Entrá a <a href="https://www.mercadopago.com.ar/developers/panel/app" target="_blank" rel="noopener">mercadopago.com.ar/developers/panel/app</a> → elegí tu aplicación → <b>Cuentas de prueba</b> → <b>+ Crear cuenta de prueba</b>. Creá una de tipo <b>Vendedor</b> y otra de tipo <b>Comprador</b>, país Argentina. Anotá usuario y contraseña de cada una (los muestra el panel).`, null)}
      ${step(2, 'Cargá las credenciales y el webhook de prueba', `En Vercel (proyecto rinde → Settings → Environment Variables) <b>MP_ACCESS_TOKEN</b> tiene que ser una credencial de prueba. Si al pagar Mercado Pago dice que el comprador y el vendedor tienen que ser los dos de prueba, usá el Access Token de <b>producción de la cuenta vendedora de prueba</b> (entrá con esa cuenta en incógnito y copialo de sus credenciales). En Mercado Pago → tu aplicación → <b>Webhooks</b> → <b>Modo de prueba</b>: URL <span class="num">https://rinde-orcin.vercel.app/api/mp-webhook</span>, eventos <b>Planes y suscripciones</b> y <b>Pagos</b>. Guardá y copiá la clave secreta en <b>MP_WEBHOOK_SECRET</b>. Después de cambiar variables, en Vercel → Deployments → el último → <b>Redeploy</b>.`, 'en Conexiones, "Mercado Pago" en verde y "MODO PRUEBA".')}
      ${step(3, 'Abrí una ventana de incógnito', `Chrome: <b>Ctrl+Shift+N</b> (en Mac <b>Cmd+Shift+N</b>). Así no se mezcla con tu Mercado Pago real. Entrá a <a href="https://www.mercadopago.com.ar" target="_blank" rel="noopener">mercadopago.com.ar</a> con el <b>usuario comprador de prueba</b> (si pide un código de verificación, en el panel de cuentas de prueba figura cómo obtenerlo).`, null)}
      ${step(4, 'Suscribite en Rinde', `En la misma ventana de incógnito abrí <a href="https://rinde-orcin.vercel.app" target="_blank" rel="noopener">rinde-orcin.vercel.app</a>, conectá una cuenta de Mercado Libre de prueba o la tuya (MATYPERE, que está en plan gratis) y andá a <b>/suscribirme</b> → Mensual → poné el <b>email del comprador de prueba</b> → Pagar con tarjeta.`, null)}
      ${step(5, 'Pagá con la tarjeta de prueba (aprobado)', `Usá una tarjeta de prueba con titular <b>APRO</b> y DNI <b>12345678</b> (tabla de abajo).`, 'vuelve a /suscribirme con "listo"; en <b>Usuarios</b> la cuenta pasa a Plan Rinde en <b>prueba gratis de 3 días</b>; en <b>Avisos del webhook</b> aparece "Suscripción · suscripción autorizada (trial)" con OK.')}
      ${step(6, 'Probá el cobro sin esperar 3 días', `El primer cobro real llega cuando termina la prueba gratis. Para verlo hoy: en esta pantalla poné <b>Días de prueba gratis = 0</b> y guardá, en Usuarios pasá la cuenta a gratis y repetí los pasos 4 y 5.`, 'en <b>Avisos del webhook</b> "Cobro de la suscripción · cobro aprobado"; en Usuarios plan <b>activo</b>; en <b>Pagos por facturar</b> el pago con el monto del plan, sin facturar.')}
      ${step(7, 'Probá un pago rechazado', `Repetí con titular <b>OTHE</b> (rechazo general) o <b>FUND</b> (fondos insuficientes).`, 'Mercado Pago muestra el rechazo y no se crea la suscripción; o, si ya existía, en Avisos aparece "cobro rechazado: empieza la gracia" y en Usuarios queda "en gracia" 5 días sin cortar el plan.')}
      ${step(8, 'Dejá todo como estaba', `Volvé <b>Días de prueba gratis</b> a 3, pasá la cuenta de prueba a gratis en Usuarios y marcá como facturados (o ignorá) los pagos de prueba en Pagos por facturar.`, null)}
    </ol>
    <div class="label">Tarjetas de prueba</div>
    <ul class="cards-test">${TEST_CARDS.map(([b, n, c, v]) => `<li><b>${b}</b><span class="num">${n}</span><span class="small">código <span class="num">${c}</span> · vence <span class="num">${v}</span></span></li>`).join('')}</ul>
    <p class="small" style="margin:0"><b>Titular (define el resultado):</b> <span class="num">APRO</span> = aprobado · <span class="num">OTHE</span> = rechazado por error general · <span class="num">FUND</span> = fondos insuficientes · <span class="num">SECU</span> = código de seguridad inválido. Documento: DNI <span class="num">12345678</span>.</p>
    <p class="tiny muted" style="margin:0">Datos según la documentación de tarjetas de prueba de Mercado Pago Argentina; si cambian, valen los de <a href="https://www.mercadopago.com.ar/developers/es/docs/your-integrations/test/cards" target="_blank" rel="noopener">esa página</a>.</p>
  </section>`;
}

function prodChecklistCard() {
  const st = checklistState();
  const items = [
    ['cred', 'Credenciales de producción', 'En Mercado Pago → tu aplicación → <b>Credenciales de producción</b> (de la cuenta real de Innovasmart), copiá el Access Token (empieza con APP_USR-).'],
    ['var_token', 'Vercel: MP_ACCESS_TOKEN', 'Proyecto rinde → Settings → Environment Variables → <b>MP_ACCESS_TOKEN</b> (Production): reemplazá el valor por el Access Token de producción. No lo pegues en ningún otro lado.'],
    ['var_mode', 'Vercel: MP_MODE', 'Si existe la variable <b>MP_MODE</b> con "test", borrala.'],
    ['webhook', 'Webhook en modo productivo', 'Mercado Pago → tu aplicación → <b>Webhooks</b> → <b>Modo productivo</b>: URL <span class="num">https://rinde-orcin.vercel.app/api/mp-webhook</span>, eventos <b>Planes y suscripciones</b> y <b>Pagos</b>. Guardar.'],
    ['var_secret', 'Vercel: MP_WEBHOOK_SECRET', 'Copiá la <b>clave secreta</b> del webhook productivo y ponela en <b>MP_WEBHOOK_SECRET</b> (Production).'],
    ['redeploy', 'Redeploy', 'Vercel → Deployments → el último de producción → <b>Redeploy</b> (las variables nuevas solo se toman al volver a publicar).'],
    ['check_conn', 'Verificar en Conexiones', 'Admin → <b>Conexiones</b>: "Mercado Pago" en verde, con tu cuenta real y <b>sin</b> "MODO PRUEBA".'],
    ['check_hook', 'Verificar el webhook', 'En Mercado Pago → Webhooks → <b>Simular notificación</b>. En esta pantalla, en <b>Avisos del webhook</b>, tiene que aparecer el aviso (si dice "firma inválida", la clave secreta de Vercel no es la del modo productivo).'],
    ['check_prices', 'Precios y prueba gratis', 'En esta pantalla: precios mensual y anual correctos, <b>Días de prueba gratis = 3</b> y datos bancarios cargados.'],
    ['check_real', 'Una suscripción real chica', 'Suscribite vos con tu tarjeta real: tiene que quedar en prueba gratis, el aviso en verde y, al cobrar, el pago en <b>Pagos por facturar</b>. Después cancelala desde Mercado Pago.'],
  ];
  const done = items.filter(([k]) => st[k]).length;
  return `<section class="card" aria-labelledby="pp-h" style="display:grid;gap:10px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><h3 id="pp-h" style="margin:0">${I.tag} Lista de chequeo: pasar Mercado Pago a producción</h3><span class="tag ${done === items.length ? 'tag-ok' : 'tag-neutral'}">${done}/${items.length}</span></div>
    <p class="small muted" style="margin:0">Para el día que pases a cobrar de verdad. Nada de esto se hace solo: los tildes se guardan solo en este navegador.</p>
    <ul class="checklist">${items.map(([k, t, d]) => `<li><label><input type="checkbox" data-chk="${k}" ${st[k] ? 'checked' : ''}><span><b>${t}</b><span class="small" style="display:block">${d}</span></span></label></li>`).join('')}</ul>
  </section>`;
}

async function loadBillingEvents() {
  if (DEMO) {
    const now = Date.now();
    billingEvents = [
      { created_at: new Date(now - 60e3).toISOString(), topic: 'subscription_authorized_payment', resource_id: '7000123', result: 'cobro aprobado' },
      { created_at: new Date(now - 3600e3).toISOString(), topic: 'subscription_preapproval', resource_id: '2c938084', result: 'suscripción autorizada (trial)' },
      { created_at: new Date(now - 7200e3).toISOString(), topic: 'payment', resource_id: '123456', result: 'rechazado', error: 'firma inválida' },
    ];
  } else {
    try { billingEvents = (await call('GET', null, '?view=billing_events')).rows; } catch (e) { billingEvents = { error: e.message }; }
  }
  if (tab() === 'cobros') cobrosView();
}

function cobrosView() {
  const c = billingCfg;
  const plus30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const f = (id, label, value, type = 'text', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value ?? '')}" ${extra}></div>`;
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Cobros</h1><div class="small muted">Precios, prueba gratis, datos bancarios y activación manual por transferencia.</div></div></div>
  ${payMsg ? `<div class="notice notice-ok" role="status" style="margin-bottom:12px">${I.checkCircle}<div>${esc(payMsg)}</div></div>` : ''}
  ${!c ? '<div class="card">Cargando…</div>' : `
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start">
    <form class="card" id="cfgf" style="display:grid;gap:12px">
      <h3>${I.money} Precios y prueba</h3>
      <div class="pc-inputs" style="margin:0">${f('c_m', 'Mensual ($)', c.monthly_price, 'text', 'inputmode="numeric"')}${f('c_a', 'Anual ($)', c.annual_price, 'text', 'inputmode="numeric"')}</div>
      <div class="pc-inputs" style="margin:0">${f('c_until', 'Precio anual vigente hasta', c.annual_valid_until, 'date')}${f('c_trial', 'Días de prueba gratis', c.trial_days, 'number', 'min="0" max="30"')}</div>
      <p class="tiny muted" style="margin:0">Los cambios de precio valen para las suscripciones nuevas. Las que ya están activas en Mercado Pago siguen con el precio con el que se suscribieron.</p>
      <h3 style="margin-top:6px">${I.tag} Datos para transferencia</h3>
      ${f('b_holder', 'Titular', c.bank.holder)}${f('b_cuit', 'CUIT', c.bank.cuit)}${f('b_bank', 'Banco', c.bank.bank)}${f('b_cbu', 'CBU / CVU', c.bank.cbu, 'text', 'inputmode="numeric"')}${f('b_alias', 'Alias', c.bank.alias)}
      <button class="btn btn-primary" type="submit">Guardar</button>
    </form>
    <form class="card" id="trf" style="display:grid;gap:12px">
      <h3>${I.checkCircle} Activar por transferencia</h3>
      <p class="small muted" style="margin:0">Cuando te llegue la transferencia, elegí el usuario y hasta cuándo queda activo. Le mandamos un email 5 días antes de vencer y el día que vence.</p>
      <div class="field"><label for="t_user">Usuario</label><select id="t_user">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.nickname)}${u.billing_email || u.alert_email ? ' · ' + esc(u.billing_email || u.alert_email) : ''}</option>`).join('')}</select></div>
      <div class="pc-inputs" style="margin:0">
        <div class="field"><label for="t_int">Plan</label><select id="t_int"><option value="monthly">Mensual</option><option value="annual">Anual</option></select></div>
        ${f('t_until', 'Activo hasta', plus30, 'date', 'required')}
      </div>
      <div class="pc-inputs" style="margin:0">${f('t_amount', 'Monto cobrado ($)', c.monthly_price, 'text', 'inputmode="numeric"')}${f('t_note', 'Nota (opcional)', '', 'text', 'placeholder="ej. transf. 12/11"')}</div>
      <button class="btn btn-primary" type="submit" ${users.length ? '' : 'disabled'}>Activar plan</button>
    </form>
  </div>
  <div class="grid" style="margin-top:14px;gap:14px">${eventsCard()}${guideCard()}${prodChecklistCard()}</div>`}`;
  hydrateIcons(root);
  document.getElementById('ev-reload')?.addEventListener('click', () => { billingEvents = null; cobrosView(); loadBillingEvents(); });
  document.querySelectorAll('[data-chk]').forEach((el) => el.addEventListener('change', () => { const st = checklistState(); st[el.dataset.chk] = el.checked; saveChecklist(st); cobrosView(); }));
  document.getElementById('t_int')?.addEventListener('change', (e) => {
    document.getElementById('t_amount').value = e.target.value === 'annual' ? c.annual_price : c.monthly_price;
    const d = new Date(); d.setMonth(d.getMonth() + (e.target.value === 'annual' ? 12 : 1));
    document.getElementById('t_until').value = d.toISOString().slice(0, 10);
  });
  document.getElementById('cfgf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value.trim();
    const config = { ...c, monthly_price: v('c_m'), annual_price: v('c_a'), annual_valid_until: v('c_until'), trial_days: v('c_trial'), bank: { holder: v('b_holder'), cuit: v('b_cuit'), bank: v('b_bank'), cbu: v('b_cbu'), alias: v('b_alias') } };
    if (DEMO) { billingCfg = { ...config, monthly_price: Number(config.monthly_price), annual_price: Number(config.annual_price) }; payMsg = 'Guardado (ejemplo).'; return cobrosView(); }
    try { const d = await call('POST', { action: 'billing_config', config }); billingCfg = d.config; payMsg = 'Listo, guardamos precios y datos bancarios.'; } catch (er) { alert(er.message); }
    cobrosView();
  });
  document.getElementById('trf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value.trim();
    const u = users.find((x) => x.id === v('t_user'));
    const body = { action: 'transfer', user_id: v('t_user'), interval: v('t_int'), until: v('t_until'), amount: v('t_amount'), note: v('t_note') };
    if (!confirm(`¿Activar el Plan Rinde de ${u?.nickname} hasta el ${body.until}?`)) return;
    if (DEMO) { Object.assign(u, { plan: 'rinde', billing_status: 'manual', payment_method: 'transfer', plan_interval: body.interval, plan_expires_at: body.until + 'T23:59:00-03:00' }); payMsg = `Activado ${u.nickname} hasta el ${body.until} (ejemplo).`; return cobrosView(); }
    try { await call('POST', body); payMsg = `Activado ${u?.nickname} hasta el ${body.until}. El pago quedó en "Pagos por facturar".`; await load(); } catch (er) { alert(er.message); }
  });
}

async function loadCobros() {
  loadBillingEvents();
  if (DEMO) { billingCfg = billingCfg || JSON.parse(JSON.stringify(DEMO_CFG)); billingEnv = { mpConfigured: true, mpTest: true, webhookSecret: true }; return cobrosView(); }
  try { const d = await call('GET', null, '?view=billing'); billingCfg = d.config; billingEnv = d.env; } catch (e) { billingCfg = null; payMsg = ''; root.innerHTML = `${tabsBar()}<div class="notice notice-bad">${I.alert}<div>${esc(e.message)}</div></div>`; return hydrateIcons(root); }
  cobrosView();
}

// ─────────────────────────────── Pagos por facturar ────────────────────────
const DEMO_PAYMENTS = [
  { id: 'p1', customer_name: 'Juan Pérez (TIENDA.EJEMPLO)', customer_email: 'ventas@tiendaejemplo.com.ar', customer_doc: 'DNI 30123456', amount: 15000, paid_at: '2026-11-01T13:10:00Z', source: 'mp', plan_interval: 'monthly', invoiced_at: null },
  { id: 'p2', customer_name: 'MOTOPARTS.BA', customer_email: 'motoparts@gmail.com', customer_doc: null, amount: 150000, paid_at: '2026-10-28T15:30:00Z', source: 'transfer', plan_interval: 'annual', invoiced_at: null },
  { id: 'p3', customer_name: 'Laura Gómez (HOGAR-Y-DECO)', customer_email: 'hogarydeco@gmail.com', customer_doc: 'CUIT 27-28999888-4', amount: 15000, paid_at: '2026-10-04T12:00:00Z', source: 'mp', plan_interval: 'monthly', invoiced_at: '2026-10-05T10:00:00Z' },
];
function pagosView() {
  const d = payments;
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Pagos por facturar</h1><div class="small muted">Para hacer la factura en ARCA. Marcá "Facturado" cuando la hagas.</div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="pf" class="btn btn-light btn-sm"><option value="pendientes" ${payFilter === 'pendientes' ? 'selected' : ''}>Sin facturar</option><option value="todos" ${payFilter === 'todos' ? 'selected' : ''}>Todos</option></select>
  <button class="btn btn-light btn-sm" id="pcsv">${I.download} Exportar CSV</button></div></div>
  ${!d ? '<div class="card">Cargando…</div>' : `
  <div class="kpis" style="margin-bottom:14px">
    <div class="kpi"><div class="k-label">Cobrado en ${new Date().getFullYear()}</div><div class="k-value">${fmtMoney(d.yearTotal)}</div><div class="k-sub">${d.yearCount} pago(s) en el año calendario</div></div>
    <div class="kpi ${d.pending ? 'is-bad' : 'is-ok'}"><div class="k-label">Sin facturar</div><div class="k-value">${d.pending}</div><div class="k-sub">pago(s) pendientes</div></div>
  </div>
  <div class="table-wrap desktop-only"><table class="data" style="min-width:860px"><thead><tr><th>Cliente</th><th>Email</th><th>Documento</th><th>Monto</th><th>Fecha</th><th>Medio</th><th>Estado</th></tr></thead>
  <tbody>${d.payments.map((p) => `<tr><td><b>${esc(p.customer_name || '—')}</b><div class="tiny muted">${p.plan_interval === 'annual' ? 'Anual' : 'Mensual'}</div></td><td>${esc(p.customer_email || '—')}</td><td>${esc(p.customer_doc || '—')}</td><td>${fmtMoney(p.amount)}</td><td>${date(p.paid_at)}</td><td>${p.source === 'mp' ? 'Mercado Pago' : 'Transferencia'}</td>
    <td>${p.invoiced_at ? `<span class="tag tag-ok">${I.check} Facturado ${date(p.invoiced_at)}</span>` : `<button class="btn btn-primary btn-sm" data-inv="${esc(p.id)}">Facturado</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No hay pagos sin facturar.</td></tr>'}</tbody></table></div>
  <div class="pcards mobile-only">${d.payments.map((p) => `<div class="pc"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(p.customer_name || '—')}</b><b class="num">${fmtMoney(p.amount)}</b></div>
    <div class="row"><span>Email</span><b style="font-family:var(--font-body)">${esc(p.customer_email || '—')}</b></div><div class="row"><span>Documento</span><b>${esc(p.customer_doc || '—')}</b></div>
    <div class="row"><span>Fecha · medio</span><b>${date(p.paid_at)} · ${p.source === 'mp' ? 'MP' : 'Transf.'}</b></div>
    <div style="margin-top:10px">${p.invoiced_at ? `<span class="tag tag-ok">${I.check} Facturado ${date(p.invoiced_at)}</span>` : `<button class="btn btn-primary btn-sm btn-block" data-inv="${esc(p.id)}">Marcar como facturado</button>`}</div></div>`).join('') || '<div class="empty">No hay pagos sin facturar.</div>'}</div>`}`;
  hydrateIcons(root);
  document.getElementById('pf')?.addEventListener('change', (e) => { payFilter = e.target.value; loadPagos(); });
  root.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', async () => {
    if (DEMO) { const p = DEMO_PAYMENTS.find((x) => x.id === b.dataset.inv); p.invoiced_at = new Date().toISOString(); return loadPagos(); }
    b.disabled = true;
    try { await call('POST', { action: 'invoiced', payment_id: b.dataset.inv }); await loadPagos(); } catch (e) { alert(e.message); b.disabled = false; }
  }));
  document.getElementById('pcsv')?.addEventListener('click', async () => {
    let text;
    if (DEMO) {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      text = '\uFEFF' + ['cliente;email;documento;monto;fecha;medio;plan;facturado', ...d.payments.map((p) => [p.customer_name, p.customer_email, p.customer_doc, p.amount, date(p.paid_at), p.source === 'mp' ? 'Mercado Pago' : 'Transferencia', p.plan_interval === 'annual' ? 'Anual' : 'Mensual', p.invoiced_at ? 'sí' : 'no'].map(q).join(';'))].join('\n');
    } else {
      const r = await fetch(`/api/admin?view=payments&format=csv&filter=${payFilter}`, { headers: { 'x-admin-key': key } });
      if (!r.ok) return alert('No pudimos exportar. Reintentá.');
      text = await r.text();
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), download: `rinde-pagos-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

async function loadPagos() {
  if (DEMO) {
    const ys = `${new Date().getFullYear()}-01-01`;
    const list = payFilter === 'todos' ? DEMO_PAYMENTS : DEMO_PAYMENTS.filter((p) => !p.invoiced_at);
    payments = { payments: list, yearTotal: DEMO_PAYMENTS.filter((p) => p.paid_at >= ys).reduce((t, p) => t + p.amount, 0), yearCount: DEMO_PAYMENTS.length, pending: DEMO_PAYMENTS.filter((p) => !p.invoiced_at).length };
    return pagosView();
  }
  try { payments = await call('GET', null, `?view=payments&filter=${payFilter}`); } catch (e) { root.innerHTML = `${tabsBar()}<div class="notice notice-bad">${I.alert}<div>${esc(e.message)}</div></div>`; return hydrateIcons(root); }
  pagosView();
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

function settlementTable(r) {
  const rows = r.sales.filter((s) => s.settlement);
  if (!rows.length) return '';
  const pct = (v) => (v == null ? '' : ` · ${(v * 100).toFixed(1).replace('.', ',')} %`);
  const cell = (st) => (st.diff == null ? '<span class="muted">sin dato</span>' : st.alert ? `<span class="tag tag-bad">${I.alert} ${(st.diff > 0 ? '+' : '') + fmtMoney(st.diff)}${pct(st.pct)}</span>` : `<span class="tag tag-ok">${I.check} ${Math.abs(st.diff) < 1 ? 'igual' : (st.diff > 0 ? '+' : '') + fmtMoney(st.diff)}${pct(st.pct)}</span>`);
  const notes = rows.filter((s) => s.settlement.explain);
  return `<section class="card" style="padding:0;overflow:hidden;margin-bottom:16px" aria-labelledby="liq-h">
    <div style="padding:14px 16px"><h2 id="liq-h" style="font-size:1.15rem;margin:0">"Te quedó" de Rinde vs lo que liquidó Mercado Libre</h2>
    <div class="small muted">Por venta: precio, lo que muestra Rinde, lo que realmente se acreditó (neto del pago en Mercado Pago, sin el envío que pagó el comprador) y la diferencia. Rojo = más de 2 %.</div></div>
    <div class="mobile-only" style="border-top:1px solid var(--line)">${rows.map((s, i) => `<div style="padding:10px 16px;border-bottom:1px dashed var(--line);display:grid;gap:4px">
      <div class="small"><b>${i + 1}.</b> ${esc(s.title.length > 46 ? s.title.slice(0, 44) + '…' : s.title)}</div>
      <div class="tiny muted num">Precio ${fmtMoney(s.settlement.gross)} · Rinde ${fmtMoney(s.settlement.rindeNet)} · MeLi ${s.settlement.meliNet == null ? 'sin dato' : fmtMoney(s.settlement.meliNet)}</div>
      <div>${cell(s.settlement)}</div></div>`).join('')}</div>
    <div class="table-wrap desktop-only" style="border:0;border-top:1px solid var(--line);border-radius:0">
      <table class="data liq-table"><thead><tr><th>Venta</th><th>Precio</th><th>Rinde: te quedó</th><th>MeLi liquidó</th><th>Diferencia</th></tr></thead>
      <tbody>${rows.map((s, i) => `<tr><td><b>${i + 1}.</b> <span class="small">${esc(s.title.length > 42 ? s.title.slice(0, 40) + '…' : s.title)}</span><div class="tiny muted num">#${esc(s.order_id)}</div></td><td class="num">${fmtMoney(s.settlement.gross)}</td><td class="num">${fmtMoney(s.settlement.rindeNet)}</td><td class="num">${s.settlement.meliNet == null ? '<span class="muted">sin dato</span>' : fmtMoney(s.settlement.meliNet)}</td><td>${cell(s.settlement)}</td></tr>`).join('')}</tbody></table>
    </div>
    ${notes.length ? `<ul class="small" style="margin:0;padding:12px 16px 14px 34px;border-top:1px dashed var(--line);display:grid;gap:6px">${notes.map((s) => `<li><b>Venta ${rows.indexOf(s) + 1}:</b> ${esc(s.settlement.explain)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function accountCard() {
  const a = acct;
  const money2 = (v) => (v == null ? 'sin dato' : fmtMoney(v));
  return `<section class="card" style="display:grid;gap:10px;margin-bottom:14px" aria-labelledby="acc-h">
    <h2 id="acc-h" style="font-size:1.15rem;margin:0">Facturación real y diagnóstico de esta cuenta</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-light btn-sm" id="acc-load" ${acctBusy ? 'disabled' : ''}>${I.chart} Ver facturación real</button>

      <button class="btn btn-light btn-sm" id="acc-stored" ${acctBusy ? 'disabled' : ''}>${I.refresh} Regenerar con datos guardados</button>
      <button class="btn btn-light btn-sm" id="acc-regen" ${acctBusy ? 'disabled' : ''}>${acctBusy === 'regen' ? `${I.loader.replace('<svg', '<svg class="spin"')} Releyendo la cuenta…` : `${I.refresh} Releer y regenerar diagnóstico (no gasta el gratis)`}</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn btn-light btn-sm" id="probe-c" type="button" ${acctBusy ? 'disabled' : ''}>${I.search} Probar acceso a campañas y publicidad</button><span class="tiny muted">Solo lectura: no cambia nada en Mercado Libre.</span></div>
    ${probe?.feeChecks?.length ? `<div class="small"><b>Cargos de MeLi (listing_prices) contra lo facturado de verdad:</b><ul style="margin:4px 0 0;padding-left:18px">${probe.feeChecks.map((f) => `<li class="num">${fmtMoney(f.price)} · ${esc(f.listing_type)} · ${esc(f.category_id)}: MeLi dice ${f.meli == null ? 'sin dato' : fmtMoney(f.meli)} · facturado ${fmtMoney(f.real)}${f.diffPct == null ? '' : Math.abs(f.diffPct) <= 0.02 ? ' ✓ coincide' : ` ✗ difiere ${(f.diffPct * 100).toFixed(1).replace('.', ',')} %`}</li>`).join('')}</ul></div>` : ''}
    ${probe ? `<div class="table-wrap"><table class="data"><thead><tr><th>Lectura</th><th>Respuesta</th><th>Detalle</th></tr></thead><tbody>${probe.rows.map((r) => `<tr><td>${esc(r.name)}<div class="tiny muted num">${esc(r.path)}</div></td><td>${r.status == null ? '<span class="tag tag-neutral">no probado</span>' : r.status === 200 ? `<span class="tag tag-ok">${I.check} 200${r.count === 0 ? ' vacío' : r.count != null ? ` · ${r.count}` : ''}</span>` : `<span class="tag tag-bad">${I.x} ${r.status}</span>`}</td><td class="small">${esc([r.message, r.types?.length ? 'tipos: ' + r.types.join(', ') : '', r.boost != null ? (r.boost ? 'trae campos de aporte de MeLi/boost' : 'sin campos de boost') : '', r.fields?.length ? 'campos: ' + r.fields.join(', ') : '', r.advertiser === false ? 'no es anunciante de Product Ads' : ''].filter(Boolean).join(' · ') || '—')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <form id="ex-f" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1 1 220px;margin:0"><label for="ex-to">Mandarme un ejemplo real del email diario y del semanal a</label><input id="ex-to" type="email" required value="${esc(users.find((u) => u.id === selUser)?.alert_email || '')}"></div>
      <button class="btn btn-light btn-sm" type="submit" ${acctBusy ? 'disabled' : ''}>${I.bell} Mandar ejemplos</button>
    </form>
    ${acctMsg ? `<div class="small" role="status">${esc(acctMsg)}</div>` : ''}
    ${users.find((u) => u.id === selUser && !u.connected) ? `<div class="notice notice-info small">${I.info}<div>Esta cuenta está desconectada: se ve con los datos guardados. Para la nota completa, esta cuenta tiene que volver a conectar.</div></div>` : ''}
    ${a?.ready ? `<div class="kpis">
      <div class="kpi"><div class="k-label">Facturación 30 días</div><div class="k-value num">${money2(a.revenue.d30)}</div><div class="k-sub">${a.revenue.orders30 ?? '—'} ventas pagadas</div></div>
      <div class="kpi"><div class="k-label">Facturación 90 días</div><div class="k-value num">${money2(a.revenue.d90)}</div><div class="k-sub">${a.has180 ? 'órdenes pagadas' : 'falta releer la cuenta'}</div></div>
      <div class="kpi ${a.sanity.exceedsAvg ? 'is-bad' : 'is-ok'}"><div class="k-label">Estimado del titular</div><div class="k-value num">${fmtMoney(a.lostTotal)}</div><div class="k-sub">${a.sanity.exceedsAvg ? 'MAYOR que el promedio mensual de 6 meses: revisar' : 'dentro del promedio mensual de 6 meses'}</div></div>
      <div class="kpi"><div class="k-label">Promedio mensual 6 meses</div><div class="k-value num">${money2(a.revenue.monthlyAvg180)}</div><div class="k-sub">techo del estimado</div></div>
    </div>
    ${a.revenue.cancelled30 != null ? `<div class="small">Últimos 30 días: ${a.revenue.orders30} ventas cobradas${a.revenue.cancelled30 ? ` + ${a.revenue.cancelled30} cancelada(s) por ${fmtMoney(a.revenue.cancelled30_amount)} (Mercado Libre las suma en "ventas brutas"; Rinde no las cuenta como facturación)` : ' · sin canceladas'}.${a.revenue.statuses30 ? ` Estados: ${Object.entries(a.revenue.statuses30).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}.` : ''}</div>` : '<div class="small muted">Para ver canceladas y meses, tocá "Releer y regenerar".</div>'}
    ${a.revenue.months ? `<div class="table-wrap"><table class="data"><thead><tr><th>Mes (hora AR)</th><th>Ventas cobradas</th><th>Facturación</th><th>Canceladas</th></tr></thead><tbody>${Object.entries(a.revenue.months).sort((x, y) => y[0].localeCompare(x[0])).map(([k, v]) => `<tr><td class="num">${esc(k)}</td><td class="num">${v.orders}</td><td class="num">${fmtMoney(v.amount)}</td><td class="num">${v.cancelled ? `${v.cancelled} · ${fmtMoney(v.cancelled_amount)}` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${a.counts ? `<div class="small">Tarjetas: ${Object.entries(a.counts).filter(([, v]) => v).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} · total ${Object.values(a.counts).reduce((x, y) => x + y, 0)}</div>` : ''}
    ${a.scores ? `<div class="small"><b>Nota promedio: ${a.scores.avg ?? '—'}/100${a.scores.provisional ? ' (Nota provisoria: faltan atributos y descripciones)' : ''}</b>${a.scores.withAttrs < a.scores.total ? ` · atributos leídos en ${a.scores.withAttrs} de ${a.scores.total}` : ''}. Peores: ${a.scores.worst.map((w) => `${esc(w.title)} (${w.score}): ${w.improvements.map(esc).join(' · ')}`).join(' — ')}</div>` : ''}
    ${a.season ? `<div class="small">Temporada: ${Math.round(a.season.share * 100)} % de ${esc(a.season.season)} · fuera de temporada ~${fmtMoney(a.season.offMonthly)}/mes.</div>` : ''}
    <div class="small muted">Titular: ${esc(a.headline)} · Abandonadas: ${a.abandoned}${a.problems.length ? ` · ${a.problems.map((p) => `${esc(p.label)}: ${esc(p.detail)}`).join(' · ')}` : ''}</div>` : a && !a.ready ? '<div class="small muted">La cuenta todavía se está leyendo. Probá "Releer y regenerar".</div>' : ''}
  </section>`;
}

async function loadAccount() {
  if (DEMO) {
    const [{ buildModel, buildRuleSummary }, { getDemoData }] = await Promise.all([import('../shared/model.js'), import('../shared/demo-data.js')]);
    const m = buildModel(getDemoData());
    const rule = buildRuleSummary(m);
    acct = { ready: true, has180: false, revenue: m.revenue, lostTotal: m.lostTotal, sanity: m.sanity, counts: m.counts, headline: rule.headline, problems: rule.problems.map((p) => ({ label: p.label, detail: p.detail })), abandoned: m.abandoned?.count || 0 };
    acctMsg = 'Datos de ejemplo.';
    return render();
  }
  acctBusy = 'load'; acctMsg = ''; render();
  try { acct = await call('GET', null, `?view=account&user_id=${encodeURIComponent(selUser)}`); } catch (e) { acctMsg = e.message; }
  acctBusy = ''; render();
}

async function regenStored() {
  if (DEMO) { acctMsg = 'En el modo ejemplo no hay cuenta real.'; return render(); }
  acctBusy = 'stored'; acctMsg = 'Regenerando con los datos guardados (no lee Mercado Libre)…'; render();
  try {
    const d = await call('POST', { action: 'resync', user_id: selUser, stored: true });
    acctMsg = d.done ? `Listo. Titular: ${d.headline}` : 'No se pudo regenerar.';
    await loadAccount();
    acctMsg = d.done ? `Listo. Titular: ${d.headline}` : acctMsg;
    return render();
  } catch (e) { acctMsg = e.message; }
  acctBusy = ''; render();
}

async function regenAccount() {
  if (DEMO) { acctMsg = 'En el modo ejemplo no hay cuenta real.'; return render(); }
  acctBusy = 'regen'; acctMsg = 'Leyendo publicaciones y ventas de Mercado Libre (solo lectura). Puede tardar unos minutos en cuentas grandes: no cierres esta pestaña.'; render();
  try {
    let d = await call('POST', { action: 'resync', user_id: selUser, start: true });
    for (let i = 0; i < 60 && !d.done; i++) {
      const sp = d.sync || {};
      acctMsg = `${sp.label || 'Leyendo'}… ${sp.phase === 'items' ? `${sp.done}/${sp.total} publicaciones` : sp.phase === 'orders' ? `${sp.orders} ventas` : sp.phase === 'billing' ? `${sp.billing}/${sp.billingTotal} cargos` : ''}`;
      render();
      d = await call('POST', { action: 'resync', user_id: selUser });
    }
    acctMsg = d.done ? 'Listo: diagnóstico regenerado con la fórmula nueva. No se usó el diagnóstico gratis.' : 'Sigue leyendo: tocá el botón de nuevo para continuar.';
    await loadAccount();
    return;
  } catch (e) { acctMsg = e.message; }
  acctBusy = ''; render();
}

function validationView() {
  const connected = users; // también las desconectadas: sus datos siguen guardados
  const r = run?.report;
  const sm = r?.summary;
  const c = r?.competition;
  const kpi = (label, value, sub, tone = '') => `<div class="kpi ${tone}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`;
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Validación</h1><div class="small muted">Las últimas 10 ventas de una cuenta real: lo que calcula Rinde contra la facturación de Mercado Libre y la orden. Marcamos en rojo cuando la diferencia pasa el 2 %.</div></div></div>
  <div class="card" style="display:grid;gap:12px;margin-bottom:14px">
    ${connected.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1 1 240px"><label for="vu">Cuenta conectada</label><select id="vu">${connected.map((u) => `<option value="${esc(u.id)}" ${selUser === u.id ? 'selected' : ''}>${esc(u.nickname)} · ID ${esc(u.meli_user_id)}${u.connected ? '' : ' · desconectada'}</option>`).join('')}</select></div>
      <button class="btn btn-primary" id="vrun" ${busy ? 'disabled' : ''}>${busy ? `${I.loader.replace('<svg', '<svg class="spin"')} Consultando Mercado Libre…` : `${I.refresh} Validar últimas 10 ventas`}</button></div>`
      : `<div class="notice notice-info">${I.info}<div>Todavía no hay cuentas conectadas. Conectá la tuya desde <a href="/">la página de inicio</a> y volvé acá.</div></div>`}
    ${valError ? `<div class="notice notice-bad" role="alert">${I.alert}<div>${esc(valError)}</div></div>` : ''}
    ${run ? `<div class="tiny muted">Corrida del ${dateTime(run.created_at || r.created_at)}${DEMO ? ' · simulada' : ''}</div>` : ''}
  </div>
  ${connected.length || DEMO ? accountCard() : ''}
  ${r ? `
  ${sm.ordersError ? `<div class="notice notice-bad" style="margin-bottom:12px">${I.alert}<div>${esc(sm.ordersError)}</div></div>` : ''}
  <div class="kpis" style="margin-bottom:12px${r.sales.length ? '' : ';display:none'}">
    ${kpi('Ventas analizadas', sm.sales, `${sm.withBilling} con facturación · ${sm.estimated} estimadas`)}
    ${kpi('Con diferencia +2 %', sm.withAlerts, 'ventas a revisar', sm.withAlerts ? 'is-bad' : 'is-ok')}
    ${kpi('Formato distinto', sm.formatProblems, 'respuestas que no coinciden', sm.formatProblems ? 'is-bad' : 'is-ok')}
    ${kpi('Liquidación leída', `${sm.settled ?? 0}/${sm.sales}`, `${sm.settledAlerts ?? 0} con diferencia +2 %`, sm.settledAlerts ? 'is-bad' : 'is-ok')}
  </div>
  <div class="grid" style="margin-bottom:16px${r.sales.length ? '' : ';display:none'}">
    <div class="notice notice-info">${I.info}<div>La facturación respondió con el parámetro <b class="num">${esc(sm.billingParam)}</b>. ${sm.noTaxes ? `En ${sm.noTaxes} de ${sm.withBilling} ventas facturadas no vinieron retenciones.` : ''}</div></div>
  </div>
  ${settlementTable(r)}
  ${r.sales.length ? `<h2 style="font-size:1.15rem;margin:0 0 8px">Detalle por venta (cargos)</h2><div class="grid" style="gap:12px">${r.sales.map(saleCard).join('')}</div>` : `<div class="notice notice-info" role="status">${I.info}<div><b>Sin ventas en los últimos 90 días: la rentabilidad aparece cuando vendas.</b> Cuando esta cuenta tenga ventas, acá vas a ver cada una comparada contra la facturación de Mercado Libre.</div></div>`}
  <details class="card" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">Respuesta cruda de Mercado Libre (sin tokens ni datos del comprador)</summary>
    <p class="small muted" style="margin:10px 0">Así devolvió los datos Mercado Libre. Sirve para revisar el formato real.</p>
    <button class="btn btn-light btn-sm" id="vcopy" type="button">Copiar</button>
    <pre id="vraw" style="margin-top:10px;max-height:420px;overflow:auto;background:var(--sunken);padding:12px;border-radius:8px;font:12px/1.5 var(--font-num);white-space:pre">${esc(JSON.stringify(run.raw, null, 2))}</pre>
  </details>` : (connected.length ? '<div class="empty">Elegí la cuenta y tocá "Validar últimas 10 ventas".</div>' : '')}`;
  hydrateIcons(root);
  document.getElementById('vu')?.addEventListener('change', async (e) => { selUser = e.target.value; run = null; acct = null; acctMsg = ''; await loadLastRun(); });
  document.getElementById('vrun')?.addEventListener('click', runValidation);
  document.getElementById('acc-load')?.addEventListener('click', loadAccount);
  document.getElementById('acc-regen')?.addEventListener('click', regenAccount);
  document.getElementById('acc-stored')?.addEventListener('click', regenStored);
  document.getElementById('probe-c')?.addEventListener('click', async () => {
    if (DEMO) { acctMsg = 'En el modo ejemplo no se consulta Mercado Libre.'; return render(); }
    acctBusy = 'probe'; acctMsg = 'Probando acceso a campañas y publicidad (solo lectura)…'; render();
    try { probe = await call('POST', { action: 'probe_campaigns', user_id: selUser }); acctMsg = 'Listo: abajo ves qué respondió Mercado Libre en cada lectura.'; } catch (er) { acctMsg = er.message; }
    acctBusy = ''; render();
  });
  document.getElementById('ex-f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (DEMO) { acctMsg = 'En el modo ejemplo no se mandan emails.'; return render(); }
    acctBusy = 'mail'; acctMsg = 'Mandando…'; render();
    try {
      const d = await call('POST', { action: 'send_examples', user_id: selUser, to: document.getElementById('ex-to')?.value || '' });
      acctMsg = `${d.sent.map((x) => `Email ${x.kind}: ${x.ok ? 'enviado' : 'no salió (' + x.error + ')'}`).join(' · ')}. Alertas incluidas: ${d.alerts}. Remitente: ${d.from}. Sin dominio propio, Resend solo entrega al email dueño de la cuenta de Resend.`;
    } catch (er) { acctMsg = er.message; }
    acctBusy = ''; render();
  });
  document.getElementById('vcopy')?.addEventListener('click', async () => {
    const t = document.getElementById('vraw').textContent;
    try { await navigator.clipboard.writeText(t); document.getElementById('vcopy').textContent = 'Copiado'; } catch { const sel = getSelection(); const rg = document.createRange(); rg.selectNodeContents(document.getElementById('vraw')); sel.removeAllRanges(); sel.addRange(rg); }
  });
}

async function demoRun() {
  const [{ buildValidationReport, attachSettlements, scrub }, { getValidationDemoInput }] = await Promise.all([import('../shared/validation.js'), import('../shared/validation-demo.js')]);
  const input = getValidationDemoInput();
  if (new URLSearchParams(location.search).has('sinventas')) { input.orders = []; input.calls = {}; }
  run = { report: attachSettlements(buildValidationReport(input), input.calls), raw: scrub({ orders_search: { status: 200, body: { results: input.orders } }, por_venta: input.calls }), created_at: new Date().toISOString() };
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

// ─────────────────────────────── Conexiones ────────────────────────────────
const okTag = (ok, yes = 'Conecta', no = 'No conecta') => (ok ? `<span class="tag tag-ok">${I.check} ${yes}</span>` : `<span class="tag tag-bad">${I.x} ${no}</span>`);

const EVENT_LABEL = { public_refresh: 'Relectura de datos públicos', admin_regen: 'Diagnóstico regenerado', disconnect: 'Desconectó MeLi', delete: 'Borró sus datos', delete_rejected: 'Intento de borrar (sin BORRAR)', token_error: 'Error de token', logout: 'Salió', login: 'Conectó', login_error: 'Error al conectar' };
const EVENT_TONE = { public_refresh: 'neutral', admin_regen: 'neutral', disconnect: 'warn', delete: 'bad', delete_rejected: 'warn', token_error: 'bad', logout: 'neutral', login: 'ok', login_error: 'bad' };
function shortUA(ua) {
  if (!ua) return 'sin dato';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.slice(0, 24);
  return [br, os].filter(Boolean).join(' · ');
}
function auditCard() {
  const a = auditData;
  if (!a) return `<div class="card">${I.loader.replace('<svg', '<svg class="spin"')} Cargando registro…</div>`;
  if (a.error) return `<div class="notice notice-bad">${I.alert}<div>${esc(a.error)}</div></div>`;
  const tag = (e) => `<span class="tag tag-${EVENT_TONE[e] || 'neutral'}">${esc(EVENT_LABEL[e] || e)}</span>`;
  return `${a.needsReconnect?.length ? `<div class="notice notice-warn" style="margin-bottom:10px">${I.alert}<div><b>Hay que reconectar:</b> ${a.needsReconnect.map((u) => `${esc(u.nickname)} (${esc(u.needs_reconnect_reason || 'token')}, ${dateTime(u.needs_reconnect_at)})`).join(' · ')}. No se borró nada: solo tienen que volver a conectar.</div></div>` : ''}
  <div class="card" style="padding:0;overflow:hidden">
    ${a.rows.length ? a.rows.map((r) => `<div style="padding:10px 16px;border-bottom:1px solid var(--line);display:grid;gap:4px">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${tag(r.event)}<b class="small">${esc(r.nickname || 'usuario borrado')}</b></span><span class="tiny muted num">${dateTime(r.created_at)}</span></div>
      <div class="tiny muted" style="overflow-wrap:anywhere">Motivo: ${esc(r.reason || '—')} · IP ${esc(r.ip || 'sin dato')} · ${esc(shortUA(r.user_agent))} · desde ${esc(r.page || r.referer || 'sin dato')}</div>
    </div>`).join('') : '<div class="empty" style="padding:16px">Todavía no hay eventos registrados.</div>'}
  </div>`;
}

async function loadAudit() {
  if (DEMO) {
    const now = Date.now();
    auditData = { needsReconnect: [{ nickname: 'TIENDA.EJEMPLO', needs_reconnect_at: new Date(now - 3600e3).toISOString(), needs_reconnect_reason: 'refresh_invalid_grant' }], rows: [
      { event: 'token_error', nickname: 'TIENDA.EJEMPLO', reason: 'refresh_invalid_grant', created_at: new Date(now - 3600e3).toISOString(), ip: null, user_agent: null, page: 'cron diario' },
      { event: 'disconnect', nickname: 'OTRA.TIENDA', reason: 'boton_desconectar', created_at: new Date(now - 7200e3).toISOString(), ip: '181.0.0.1', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1', page: '/app#/diagnostico' },
      { event: 'login', nickname: 'OTRA.TIENDA', reason: null, created_at: new Date(now - 9000e3).toISOString(), ip: '181.0.0.1', user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', referer: 'https://auth.mercadolibre.com.ar/' },
    ] };
  } else {
    try { auditData = await call('GET', null, '?view=audit'); } catch (e) { auditData = { error: e.message }; }
  }
  if (tab() === 'conexiones') healthView();
}

function healthView() {
  const h = health;
  const allOk = h && h.checks.every((c) => c.ok) && h.env.every((e) => e.ok);
  root.innerHTML = `${tabsBar()}
  <div class="page-head" style="padding-top:4px"><div><h1>Conexiones</h1><div class="small muted">Probamos cada servicio en vivo. Nunca mostramos las claves.</div></div>
  <button class="btn btn-light btn-sm" id="hrun">${I.refresh} Volver a probar</button></div>
  ${!h ? `<div class="card">${I.loader.replace('<svg', '<svg class="spin"')} Probando conexiones…</div>` : `
  <div class="notice ${allOk ? 'notice-ok' : 'notice-warn'}" style="margin-bottom:14px">${allOk ? I.checkCircle : I.alert}<div><b>${allOk ? 'Todo conectado.' : 'Hay cosas para arreglar.'}</b> Versión publicada: <span class="num">${esc(h.deploy.environment)}${h.deploy.branch ? ' · ' + esc(h.deploy.branch) : ''}${h.deploy.commit ? ' · ' + esc(h.deploy.commit) : ''}</span> · probado ${dateTime(h.checked_at)}</div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));margin-bottom:16px">
    ${h.checks.map((c) => `<div class="card" style="display:grid;gap:8px;border-left:4px solid ${c.ok ? 'var(--ok)' : 'var(--bad)'}"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${esc(c.name)}</b>${okTag(c.ok)}</div><div class="small muted">${esc(c.detail)}</div></div>`).join('')}
  </div>
  <h2 style="font-size:1.2rem;margin:0 0 8px">Variables de entorno</h2>
  <div class="card" style="padding:0;overflow:hidden">${h.env.map((e) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap"><span class="num small">${esc(e.key)}</span><span style="display:flex;gap:8px;align-items:center"><span class="tiny muted">${esc(e.note)}</span>${okTag(e.ok, 'OK', 'Falta')}</span></div>`).join('')}</div>`}
  <h2 style="font-size:1.2rem;margin:20px 0 8px">Registro: desconexiones, borrados y errores de token</h2>
  <p class="small muted" style="margin:0 0 8px">Últimos 100 eventos. Queda guardado aunque el usuario se borre.</p>
  ${auditCard()}`;
  hydrateIcons(root);
  document.getElementById('hrun')?.addEventListener('click', loadHealth);
}

async function loadHealth() {
  health = null;
  auditData = null;
  loadAudit();
  if (tab() === 'conexiones') healthView();
  if (DEMO) {
    health = {
      deploy: { environment: 'demo', branch: 'rinde-v1', commit: 'ejemplo' },
      checked_at: new Date().toISOString(),
      checks: [
        { name: 'Supabase', ok: true, detail: 'Conecta y encuentra las tablas de Rinde.' },
        { name: 'Mercado Libre', ok: false, detail: 'Falta el App ID o la Clave secreta de Mercado Libre.' },
        { name: 'Anthropic (IA)', ok: true, detail: 'Clave válida y el modelo claude-haiku-5-5 está disponible.' },
        { name: 'Resend (emails)', ok: true, detail: 'Clave válida · sin dominio verificado: los emails solo te llegan a vos.' },
        { name: 'Mercado Pago (cobros)', ok: true, detail: 'Cuenta TESTUSER123456 (MLA) · MODO PRUEBA' },
      ],
      env: ['RINDE_MELI_APP_ID', 'RINDE_MELI_SECRET', 'RINDE_MELI_REDIRECT_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SESSION_SECRET', 'TOKEN_ENC_KEY', 'CRON_SECRET', 'ADMIN_KEY', 'RINDE_APP_URL', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET']
        .map((k) => ({ key: k, ok: !k.startsWith('RINDE_MELI_A') && k !== 'RINDE_MELI_SECRET', note: !k.startsWith('RINDE_MELI_A') && k !== 'RINDE_MELI_SECRET' ? 'cargada' : 'vacía o falta' })),
    };
  } else {
    try { health = await call('GET', null, '?view=health'); } catch (e) { health = { deploy: {}, checked_at: new Date().toISOString(), checks: [{ name: 'Admin', ok: false, detail: e.message }], env: [] }; }
  }
  if (tab() === 'conexiones') healthView();
}

function render() {
  const t = tab();
  if (t === 'conexiones') { if (!health) loadHealth(); return healthView(); }
  if (t === 'cobros') { if (!billingCfg) return loadCobros(); return cobrosView(); }
  if (t === 'pagos') { if (!payments) return loadPagos(); return pagosView(); }
  return t === 'validacion' ? validationView() : usersView();
}

async function load() {
  if (DEMO) {
    users = JSON.parse(JSON.stringify(DEMO_ADMIN_USERS)).map((u, i) => ({ ...u, connected: i === 0 }));
    selUser = users[0].id;
    if (tab() === 'validacion' && !run) await demoRun();
    if (!acct) await loadAccount();
    return render();
  }
  try {
    const d = await call('GET');
    users = d.users;
    usersError = '';
  } catch (e) {
    if (e.status === 401 || e.status === 429) throw e;
    users = [];
    usersError = e.message;
  }
  loggedIn = true;
  document.getElementById('logout').hidden = false;
  if (!selUser) selUser = users.find((u) => u.connected)?.id || null;
  if (tab() === 'validacion' && selUser && !run) return loadLastRun();
  render();
}

window.addEventListener('hashchange', () => { if (!loggedIn && !DEMO) return; if (tab() === 'validacion' && !run) return DEMO ? demoRun().then(render) : loadLastRun(); render(); });
document.getElementById('logout').addEventListener('click', () => { try { sessionStorage.removeItem('rinde_admin'); } catch {} key = ''; loginView(); });
hydrateIcons();
if (DEMO || key) load().catch((e) => { try { sessionStorage.removeItem('rinde_admin'); } catch {} loginView(e.message); });
else loginView();
