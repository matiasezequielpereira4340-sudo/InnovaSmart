// Página /suscribirme: elegir plan y pagar con tarjeta (Mercado Pago, con prueba gratis) o por transferencia.
import { I, hydrateIcons } from './icons.js';
import { fmtMoney } from '../shared/rules.js';
import { DEFAULT_BILLING } from '../shared/plans.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fdate = (iso) => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const waShown = (n) => String(n).replace(/^549?11/, '11 ').replace(/(\d{4})(\d{4})$/, '$1 $2');

let cfg = null;
let interval = params.get('plan') === 'annual' ? 'annual' : 'monthly';
let method = 'card';
let busy = false;
let err = '';

const price = () => (interval === 'annual' ? cfg.annual_price : cfg.monthly_price);
const STATUS_TEXT = {
  trial: (m) => `Estás en la prueba gratis hasta el ${fdate(m.expires_at)}.`,
  active: (m) => `Tu Plan Rinde está al día. Próximo vencimiento: ${fdate(m.expires_at)}.`,
  manual: (m) => `Tu Plan Rinde (transferencia) vence el ${fdate(m.expires_at)}.`,
  past_due: (m) => `No pudimos cobrar tu plan. Tenés hasta el ${fdate(m.grace_until)} para pagar sin perder nada.`,
  canceled: (m) => `Cancelaste la suscripción. Seguís con el plan hasta el ${fdate(m.expires_at)}.`,
  lapsed: () => 'Tu plan se cortó por falta de pago. Pagá y se reactiva solo: no borramos nada.',
};

function planCard(id, title, amount, per, note) {
  const sel = interval === id;
  return `<label class="card price ${sel ? 'featured' : ''}" style="cursor:pointer;gap:4px" for="pl-${id}">
    ${id === 'annual' ? '<span class="badge-top">12 meses al precio de 10</span>' : ''}
    <span style="display:flex;justify-content:space-between;align-items:center;gap:10px"><h3 style="margin:0">${title}</h3><input type="radio" name="plan" id="pl-${id}" value="${id}" ${sel ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></span>
    <span class="amount">${fmtMoney(amount)} <span class="small muted" style="font-family:var(--font-body);font-weight:500">${per}</span></span>
    <span class="small muted">${note}</span>
  </label>`;
}

function render() {
  if (!cfg) return;
  const me = cfg.me;
  const done = params.get('estado') === 'listo';
  const b = cfg.bank || {};
  const bankRows = [['Titular', b.holder], ['CUIT', b.cuit], ['Banco', b.bank], ['CBU / CVU', b.cbu], ['Alias', b.alias]].filter(([, v]) => v);
  const nick = me?.nickname || 'tu usuario';
  const waMsg = `Hola, soy ${nick}. Transferí ${fmtMoney(price())} por el Plan Rinde ${interval === 'annual' ? 'Anual' : 'Mensual'}. Te paso el comprobante.`;
  const wa = `https://wa.me/${cfg.whatsapp || '5491160374306'}?text=${encodeURIComponent(waMsg)}`;
  const monthsEq = cfg.monthly_price > 0 ? Math.round(cfg.annual_price / cfg.monthly_price) : 10;

  root.innerHTML = `
  ${DEMO ? `<div class="notice notice-info" style="margin-bottom:14px">${I.info}<div>Estás viendo un <b>ejemplo</b>. Los botones no cobran nada.</div></div>` : ''}
  ${cfg.mp_test ? `<div class="notice notice-warn" style="margin-bottom:14px">${I.alert}<div><b>Mercado Pago en modo prueba.</b> Usá un usuario y una tarjeta de prueba: no se cobra plata real.</div></div>` : ''}
  ${done ? `<div class="notice notice-ok" style="margin-bottom:16px" role="status">${I.checkCircle}<div><b>¡Listo!</b> Mercado Pago está confirmando tu suscripción. En unos minutos se activa tu Plan Rinde y te llega un email. <a href="/app">Ir a mi cuenta</a></div></div>` : ''}
  <span class="label">Plan Rinde</span>
  <h1 style="font-size:clamp(1.9rem,6vw,2.8rem);margin:8px 0 6px">Elegí cómo pagar</h1>
  <p class="lead" style="margin-bottom:18px">Diagnóstico ilimitado, rentabilidad real por producto y alertas diarias. <b>${cfg.trial_days} días gratis</b> con tarjeta. Cancelás cuando quieras.</p>
  ${me?.status && STATUS_TEXT[me.status] ? `<div class="notice ${me.status === 'past_due' || me.status === 'lapsed' ? 'notice-bad' : 'notice-ok'}" style="margin-bottom:16px">${me.status === 'past_due' || me.status === 'lapsed' ? I.alert : I.checkCircle}<div>${esc(STATUS_TEXT[me.status](me))}</div></div>` : ''}

  <div class="prices two" style="margin-bottom:18px" role="radiogroup" aria-label="Plan">
    ${planCard('monthly', 'Mensual', cfg.monthly_price, '/ mes', 'Se renueva todos los meses.')}
    ${planCard('annual', 'Anual', cfg.annual_price, '/ año', `Equivale a ${monthsEq} meses. Precio vigente hasta el ${fdate(cfg.annual_valid_until)}.`)}
  </div>

  ${!me ? `<div class="card" style="display:grid;gap:10px">
    <h3>${I.plug} Primero conectá tu cuenta de Mercado Libre</h3>
    <p class="small muted" style="margin:0">Así sabemos a qué cuenta activarle el plan. Es solo lectura: Rinde nunca modifica nada.</p>
    <a class="btn btn-primary" href="/api/auth/login?next=/suscribirme">Conectar mi cuenta de Mercado Libre</a>
  </div>` : `
  <nav class="cat-filter" aria-label="Medio de pago" style="flex-wrap:wrap">
    <button class="chip" data-m="card" aria-pressed="${method === 'card'}">${I.money} Tarjeta (Mercado Pago)</button>
    <button class="chip" data-m="transfer" aria-pressed="${method === 'transfer'}">${I.tag} Pagar por transferencia</button>
  </nav>
  ${method === 'card' ? `<form class="card" id="cardf" style="display:grid;gap:12px">
    <h3>${I.sparkle} ${cfg.trial_days} días gratis, después ${fmtMoney(price())} ${interval === 'annual' ? 'por año' : 'por mes'}</h3>
    ${!cfg.mp_enabled ? `<div class="notice notice-warn">${I.info}<div>El pago con tarjeta todavía no está habilitado. Mientras tanto podés pagar por transferencia.</div></div>` : ''}
    <div class="field"><label for="em">Email de tu cuenta de Mercado Pago</label><input id="em" type="email" autocomplete="email" required value="${esc(me.email || '')}" placeholder="tu@email.com"></div>
    <ul class="small" style="margin:0;padding-left:18px;color:var(--ink-2)">
      <li>Cargás la tarjeta en Mercado Pago. Hoy no se cobra nada.</li>
      <li>El día ${cfg.trial_days + 1} se cobra ${fmtMoney(price())} y se renueva ${interval === 'annual' ? 'cada año' : 'cada mes'}.</li>
      <li>Si un cobro falla, tenés ${cfg.grace_days} días para regularizar sin perder nada.</li>
    </ul>
    ${err ? `<div class="notice notice-bad" role="alert">${I.alert}<div>${esc(err)}</div></div>` : ''}
    <button class="btn btn-primary" type="submit" ${busy || !cfg.mp_enabled ? 'disabled' : ''}>${busy ? 'Abriendo Mercado Pago…' : `Empezar ${cfg.trial_days} días gratis`}</button>
    <p class="tiny muted" style="margin:0">Te llevamos a Mercado Pago para cargar la tarjeta. Rinde nunca ve tus datos de tarjeta.</p>
  </form>` : `<div class="card" style="display:grid;gap:12px">
    <h3>${I.tag} Transferí ${fmtMoney(price())}</h3>
    ${bankRows.length ? `<div style="border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden">${bankRows.map(([k, v], i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;${i ? 'border-top:1px solid var(--line)' : ''}"><span class="small muted">${k}</span><span style="display:flex;gap:8px;align-items:center;min-width:0"><b class="num" style="overflow-wrap:anywhere">${esc(v)}</b><button class="btn btn-light btn-sm" type="button" data-copy="${esc(v)}" aria-label="Copiar ${k}">Copiar</button></span></div>`).join('')}</div>`
      : `<div class="notice notice-warn">${I.info}<div>Todavía no cargamos los datos bancarios. Escribinos por WhatsApp y te los pasamos.</div></div>`}
    <p class="small" style="margin:0">Después mandanos el comprobante por WhatsApp al <b class="num">${esc(waShown(cfg.whatsapp || '5491160374306'))}</b> y activamos tu plan en el día. Por transferencia no hay prueba gratis.</p>
    <a class="btn btn-wa" href="${wa}" target="_blank" rel="noopener">${I.chat} Mandar comprobante por WhatsApp</a>
  </div>`}`}
  <p class="tiny muted" style="margin-top:18px">Precios finales en pesos argentinos. Te facturamos como monotributista.</p>`;

  hydrateIcons(root);
  root.querySelectorAll('input[name="plan"]').forEach((r) => r.addEventListener('change', () => { interval = r.value; err = ''; render(); }));
  root.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { method = b.dataset.m; err = ''; render(); }));
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copiado'; } catch { b.textContent = 'Seleccioná y copiá'; }
  }));
  document.getElementById('cardf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('em').value.trim();
    if (DEMO) { err = 'En el ejemplo no abrimos Mercado Pago.'; return render(); }
    busy = true; err = ''; render();
    try {
      const r = await fetch('/api/billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'checkout', interval, email }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No pudimos abrir Mercado Pago. Reintentá.');
      location.href = d.init_point;
    } catch (er) { busy = false; err = er.message; render(); }
  });
}

async function boot() {
  if (DEMO) {
    cfg = { ...DEFAULT_BILLING, bank: { holder: 'Matías Ezequiel Pereira', cuit: '20-00000000-0', bank: 'Banco de ejemplo', cbu: '0000000000000000000000', alias: 'RINDE.EJEMPLO' }, mp_enabled: true, mp_test: true, me: { nickname: 'TIENDA.EJEMPLO', email: 'vos@tutienda.com.ar', status: null } };
    if (params.get('metodo') === 'transferencia') method = 'transfer';
    return render();
  }
  try {
    const r = await fetch('/api/billing', { credentials: 'same-origin' });
    cfg = await r.json();
    if (!r.ok) throw new Error(cfg.error);
  } catch {
    cfg = { ...DEFAULT_BILLING, mp_enabled: false, me: null };
    err = '';
  }
  if (params.get('metodo') === 'transferencia') method = 'transfer';
  render();
}
hydrateIcons(document);
boot();
