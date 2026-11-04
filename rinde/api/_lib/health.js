// Chequeo de conexiones para el admin: dice si cada servicio responde, sin mostrar ninguna clave.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { mpHealth } from './mp.js';

export const ENV_KEYS = [
  'RINDE_MELI_APP_ID', 'RINDE_MELI_SECRET', 'RINDE_MELI_REDIRECT_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SESSION_SECRET', 'TOKEN_ENC_KEY', 'CRON_SECRET', 'ADMIN_KEY', 'RINDE_APP_URL', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET',
];

const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('No respondió a tiempo')), ms))]);
const has = (k) => !!(process.env[k] && String(process.env[k]).trim());

function envChecks() {
  const out = ENV_KEYS.map((k) => ({ key: k, ok: has(k), note: has(k) ? 'cargada' : 'vacía o falta' }));
  const enc = process.env.TOKEN_ENC_KEY || '';
  const t = out.find((x) => x.key === 'TOKEN_ENC_KEY');
  if (t.ok && !/^[0-9a-f]{64}$/i.test(enc)) Object.assign(t, { ok: false, note: 'tiene que tener 64 caracteres 0-9/a-f' });
  const s = out.find((x) => x.key === 'SESSION_SECRET');
  if (s.ok && (process.env.SESSION_SECRET || '').length < 32) Object.assign(s, { ok: false, note: 'muy corta (mínimo 32)' });
  const r = out.find((x) => x.key === 'RINDE_MELI_REDIRECT_URI');
  const expected = (process.env.RINDE_APP_URL || '').replace(/\/$/, '') + '/api/auth/callback';
  if (r.ok && process.env.RINDE_APP_URL && process.env.RINDE_MELI_REDIRECT_URI !== expected) Object.assign(r, { ok: false, note: `no coincide con ${expected}` });
  return out;
}

async function checkSupabase() {
  if (!has('SUPABASE_URL') || !has('SUPABASE_SERVICE_KEY')) return { ok: false, detail: 'Falta SUPABASE_URL o SUPABASE_SERVICE_KEY.' };
  await withTimeout(db.select('rinde_users', {}, { columns: 'id', limit: 1 }));
  return { ok: true, detail: 'Conecta y encuentra las tablas de Rinde.' };
}

async function checkAnthropic() {
  if (!has('ANTHROPIC_API_KEY')) return { ok: false, detail: 'Falta ANTHROPIC_API_KEY. Sin IA, los planes salen por reglas.' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 8000 });
  try {
    await client.models.retrieve('claude-haiku-5-5');
    return { ok: true, detail: 'Clave válida y el modelo claude-haiku-5-5 está disponible.' };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, detail: 'La clave no es válida.' };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, detail: 'La clave anda, pero la cuenta no tiene acceso a claude-haiku-5-5.' };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, detail: 'La clave no tiene permiso (revisá créditos o la organización).' };
    return { ok: false, detail: 'Anthropic no respondió. Reintentá en unos minutos.' };
  }
}

async function checkResend() {
  if (!has('RESEND_API_KEY')) return { ok: false, detail: 'Falta RESEND_API_KEY. Sin esto no salen los emails.' };
  const r = await withTimeout(fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }));
  const body = await r.json().catch(() => ({}));
  if (r.ok) {
    const verified = (body.data || []).filter((d) => d.status === 'verified').length;
    return { ok: true, detail: verified ? `Clave válida · ${verified} dominio(s) verificado(s).` : 'Clave válida · sin dominio verificado: los emails solo te llegan a vos.' };
  }
  if (r.status === 401 && /restricted/i.test(JSON.stringify(body))) return { ok: true, detail: 'Clave válida (de solo envío).' };
  return { ok: false, detail: r.status === 401 || r.status === 403 ? 'La clave no es válida.' : `Resend respondió ${r.status}.` };
}

async function checkMeli() {
  if (!has('RINDE_MELI_APP_ID') || !has('RINDE_MELI_SECRET')) return { ok: false, detail: 'Falta el App ID o la Clave secreta de Mercado Libre.' };
  // Pedimos un token de aplicación: solo verifica que App ID + Clave secreta sean correctos. No toca ninguna cuenta.
  const r = await withTimeout(fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.RINDE_MELI_APP_ID, client_secret: process.env.RINDE_MELI_SECRET }),
  }));
  let last = null;
  try { last = (await db.one('rinde_settings', { key: 'last_auth_error' }))?.value || null; } catch {}
  const lastTxt = last ? ` Último error al conectar una cuenta: ${last.reason}${last.status ? ` (${last.status})` : ''} el ${new Date(last.at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}.` : '';
  let perf = null;
  try { perf = (await db.one('rinde_settings', { key: 'last_perf_probe' }))?.value || null; } catch {}
  const perfTxt = perf ? ` Calidad de publicaciones (última sincronización): ${Object.entries(perf.counts || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'sin datos'}${perf.sample ? ` · ejemplo: ${JSON.stringify(perf.sample).slice(0, 300)}` : ''}.` : '';
  let conns = [];
  try { conns = await db.select('rinde_connections', {}, { columns: 'refresh_token_enc,scope' }); } catch {}
  const noRefresh = conns.filter((c) => !c.refresh_token_enc).length;
  const refreshTxt = conns.length ? ` Conexiones: ${conns.length - noRefresh} renovables, ${noRefresh} sin refresh token${noRefresh ? ' (MeLi no está dando refresh token: activá "offline_access" en la app de Mercado Libre y que los usuarios vuelvan a conectar)' : ''}.` : '';
  if (r.ok && noRefresh) return { ok: false, detail: 'App ID y Clave secreta correctos.' + refreshTxt + lastTxt + perfTxt };
  if (r.ok) return { ok: true, detail: 'App ID y Clave secreta correctos.' + refreshTxt + lastTxt + perfTxt };
  const b = await r.json().catch(() => ({}));
  if (b.error === 'invalid_client' || r.status === 401) return { ok: false, detail: 'App ID o Clave secreta incorrectos (Mercado Libre responde invalid_client).' + lastTxt };
  return { ok: false, detail: `Mercado Libre respondió ${r.status}${b.error ? ` (${b.error})` : ''}.` };
}

export async function runHealth() {
  const run = async (name, fn) => {
    try { return { name, ...(await fn()) }; } catch (e) { return { name, ok: false, detail: e.message === 'No respondió a tiempo' ? 'No respondió a tiempo.' : 'No pudimos conectar.' }; }
  };
  const checks = await Promise.all([run('Supabase', checkSupabase), run('Mercado Libre', checkMeli), run('Anthropic (IA)', checkAnthropic), run('Resend (emails)', checkResend), run('Mercado Pago (cobros)', mpHealth)]);
  return {
    env: envChecks(),
    checks,
    deploy: {
      environment: process.env.VERCEL_ENV || 'local',
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    },
    checked_at: new Date().toISOString(),
  };
}
