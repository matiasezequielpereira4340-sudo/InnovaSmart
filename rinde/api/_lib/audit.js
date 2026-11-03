// Registro permanente (tabla rinde_audit) de desconexiones, borrados, errores de token y sesiones.
// Nunca corta el flujo: si no puede escribir, solo lo avisa en el log.
import { db } from './db.js';

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Datos del pedido: IP, navegador, página de origen (header X-Rinde-Page que manda la app) y referer. */
export function requestInfo(req) {
  if (!req) return {};
  const h = req.headers || {};
  return {
    ip: cut(String(h['x-forwarded-for'] || h['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim(), 64),
    user_agent: cut(h['user-agent'], 300),
    referer: cut(h.referer || h.referrer, 300),
    page: cut(h['x-rinde-page'], 200),
  };
}

export async function audit(req, { event, user = null, userId = null, reason = null, detail = null }) {
  const row = {
    event,
    reason: cut(reason, 200),
    user_id: user?.id || userId || null,
    meli_user_id: user?.meli_user_id || null,
    nickname: cut(user?.nickname, 120),
    detail: detail || null,
    ...requestInfo(req),
  };
  try {
    if (row.user_id && !row.nickname) {
      const u = await db.one('rinde_users', { id: row.user_id }, { columns: 'meli_user_id,nickname' });
      if (u) Object.assign(row, { meli_user_id: u.meli_user_id, nickname: u.nickname });
    }
    await db.insert('rinde_audit', [row]);
  } catch (e) {
    console.error('[rinde][audit] no se pudo registrar', event, e.message);
  }
}

/** Error de token: NUNCA borra nada. Marca la cuenta como "hay que reconectar" y lo registra. */
export async function markNeedsReconnect(userId, reason, req = null, detail = null) {
  try { await db.update('rinde_users', { id: userId }, { needs_reconnect_at: new Date().toISOString(), needs_reconnect_reason: cut(reason, 120) }); } catch {}
  await audit(req, { event: 'token_error', userId, reason, detail });
}
