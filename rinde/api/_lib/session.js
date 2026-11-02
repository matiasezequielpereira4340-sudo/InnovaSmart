// Sesión en cookie firmada con SESSION_SECRET. Contiene solo el id interno del usuario.
import { sign, unsign } from './crypto.js';
import { parseCookies, appendCookie, cookie, AppError } from './http.js';

const NAME = 'rinde_s';
const DAYS = 30;

export function setSession(res, userId) {
  const exp = Date.now() + DAYS * 86400000;
  appendCookie(res, cookie(NAME, sign(`${userId}|${exp}`), { maxAge: DAYS * 86400 }));
}

export function clearSession(res) {
  appendCookie(res, cookie(NAME, '', { maxAge: 0 }));
}

export function getSession(req) {
  const raw = parseCookies(req)[NAME];
  const v = unsign(raw);
  if (!v) return null;
  const [uid, exp] = v.split('|');
  if (!uid || Number(exp) < Date.now()) return null;
  return { userId: uid };
}

export function requireSession(req) {
  const s = getSession(req);
  if (!s) throw new AppError(401, 'Tu sesión expiró. Volvé a conectar tu cuenta de Mercado Libre.', 'no_session');
  return s;
}
