// Emails de Rinde (HTML simple, compatible con clientes de correo) y envío por Resend.
import { waLink } from '../../shared/config.js';
import { ALERT_LABELS, fmtMoney, fmtPct } from '../../shared/rules.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout({ title, preheader, body, appUrl }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f2f4f0;font-family:Arial,Helvetica,sans-serif;color:#16201b">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f0;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e5ee">
<tr><td style="background:#16201b;padding:18px 24px;color:#fff;font-size:20px;font-weight:bold;letter-spacing:-0.3px">Rinde<span style="color:#dff57a">.</span> <span style="font-size:12px;font-weight:normal;color:#a9b6ae">por Innovasmart</span></td></tr>
<tr><td style="padding:24px">${body}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="background:#2540d4;border-radius:10px"><a href="${esc(appUrl)}" style="display:inline-block;padding:12px 20px;color:#fff;text-decoration:none;font-weight:bold">Ver en Rinde</a></td></tr></table>
<div style="margin-top:20px;padding:16px;background:#eefcf6;border-radius:10px;border:1px solid #c7f0de">
<div style="font-weight:bold;margin-bottom:6px">¿No tenés tiempo de arreglarlo?</div>
<div style="font-size:14px;color:#3d4466;margin-bottom:10px">Lo hacemos nosotros: optimizamos tus publicaciones por vos.</div>
<a href="${waLink('optimize')}" style="display:inline-block;padding:10px 16px;background:#0f8a5f;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">¿Querés que lo optimicemos por vos?</a>
</div>
</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#6b7194;border-top:1px solid #eceef5">Rinde solo lee tu cuenta: nunca modifica nada en Mercado Libre. Podés desactivar estos emails desde <a href="${esc(appUrl)}/app#/alertas" style="color:#2540d4">Alertas</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

const SEV = { bad: { bg: '#fdecec', fg: '#a1251b', icon: '⛔', text: 'Urgente' }, warn: { bg: '#fff5e0', fg: '#8a5300', icon: '⚠️', text: 'Atención' } };

export function dailyAlertEmail({ nickname, alerts, appUrl }) {
  const rows = alerts.map((a) => {
    const s = SEV[a.severity] || SEV.warn;
    return `<tr><td style="padding:12px;border-bottom:1px solid #eceef5;vertical-align:top">
<div style="display:inline-block;font-size:12px;font-weight:bold;color:${s.fg};background:${s.bg};padding:3px 8px;border-radius:999px">${s.icon} ${s.text} · ${esc(ALERT_LABELS[a.kind] || a.kind)}</div>
${a.title ? `<div style="font-weight:bold;margin:6px 0 2px">${esc(a.title)}</div>` : ''}
<div style="font-size:14px;color:#3d4466">${esc(a.message)}</div></td></tr>`;
  }).join('');
  const body = `<h1 style="font-size:22px;margin:0 0 6px">Tenés ${alerts.length} alerta${alerts.length === 1 ? '' : 's'} nueva${alerts.length === 1 ? '' : 's'}</h1>
<p style="margin:0 0 16px;color:#3d4466">Hola ${esc(nickname || '')}, esto cambió en tu cuenta desde ayer:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef5;border-radius:10px">${rows}</table>`;
  return { subject: `Rinde: ${alerts.length} alerta${alerts.length === 1 ? '' : 's'} nueva${alerts.length === 1 ? '' : 's'} en tu cuenta`, html: layout({ title: 'Alertas de Rinde', preheader: alerts[0]?.message || '', body, appUrl: appUrl + '/app' }) };
}

export function weeklyEmail({ nickname, model, summary, appUrl }) {
  const k = model.kpis;
  const kpi = (label, value) => `<td style="padding:10px;background:#f6f7fb;border-radius:10px;text-align:center;width:33%"><div style="font-size:12px;color:#6b7194">${label}</div><div style="font-size:18px;font-weight:bold">${value}</div></td>`;
  const probs = (summary?.problems || []).map((p, i) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eceef5"><b>${i + 1}. ${esc(p.label)}</b><br><span style="font-size:14px;color:#3d4466">${esc(p.detail)} — ${esc(p.fix)}</span></td></tr>`).join('');
  const body = `<h1 style="font-size:22px;margin:0 0 6px">Tu semana en Mercado Libre</h1>
<p style="margin:0 0 16px;color:#3d4466">Hola ${esc(nickname || '')}, ${esc(summary?.headline || '')}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${kpi('Facturación 30 d', fmtMoney(k.revenue))}${kpi('Ganancia neta', k.net == null ? 'cargá costos' : fmtMoney(k.net))}${kpi('Margen', fmtPct(k.margin))}</tr></table>
<h2 style="font-size:16px;margin:20px 0 4px">Lo que más ventas te está costando</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${probs}</table>
<p style="margin:16px 0 0;font-size:14px"><b>Qué arreglar primero:</b> ${esc(summary?.first || '')}</p>
<p style="margin:8px 0 0;font-size:14px;color:#3d4466">${k.losing} producto(s) pierden plata · ${model.alerts.length} alerta(s) activas.</p>`;
  return { subject: 'Rinde: tu resumen semanal', html: layout({ title: 'Resumen semanal de Rinde', preheader: summary?.headline || '', body, appUrl: appUrl + '/app' }) };
}

export async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY no configurada');
  const from = process.env.RINDE_EMAIL_FROM || 'Rinde <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
