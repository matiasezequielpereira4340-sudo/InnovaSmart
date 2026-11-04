// Alertas guardadas en rinde_alerts: el cron y la app las sincronizan con el modelo de la cuenta.
// Mientras no haya emails (EMAIL_ENABLED en shared/config.js), la app las muestra como "no leídas".
import { db } from './db.js';

/** Abre las alertas nuevas y cierra las que ya no aplican. @returns { nuevas, abiertas } */
export async function syncAlerts(userId, model) {
  const open = await db.select('rinde_alerts', { user_id: userId, resolved_at: null });
  const openKeys = new Set(open.map((a) => a.key));
  const nowKeys = new Set(model.alerts.map((a) => a.key));
  const nuevas = model.alerts.filter((a) => !openKeys.has(a.key));
  const resueltas = open.filter((a) => !nowKeys.has(a.key)).map((a) => a.id);
  if (resueltas.length) await db.update('rinde_alerts', { user_id: userId, id: resueltas }, { resolved_at: new Date().toISOString() });
  if (nuevas.length) {
    await db.insert('rinde_alerts', nuevas.map((a) => ({ user_id: userId, key: a.key, kind: a.kind, item_id: a.item_id, title: a.title, message: a.message, severity: a.severity })));
  }
  return { nuevas, abiertas: open.length - resueltas.length + nuevas.length };
}

/** Alertas abiertas que el usuario todavía no vio en el panel. */
export function unreadAlerts(userId) {
  return db.select('rinde_alerts', { user_id: userId, resolved_at: null, read_at: null }, { columns: 'id,key,kind,item_id,title,message,severity,created_at', order: 'created_at.desc', limit: 100 });
}

/** Marca como leídas todas las alertas abiertas del usuario. */
export async function markAlertsRead(userId) {
  await db.update('rinde_alerts', { user_id: userId, resolved_at: null, read_at: null }, { read_at: new Date().toISOString() });
}
