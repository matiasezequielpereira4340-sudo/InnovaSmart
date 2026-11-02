// /api/auth/login · /api/auth/callback · /api/auth/logout · /api/auth/disconnect
import { handler, redirect, json, query, requireEnv, appendCookie, cookie, parseCookies, method, AppError } from './_lib/http.js';
import { sign, unsign, randomToken, pkceChallenge } from './_lib/crypto.js';
import { setSession, clearSession, requireSession } from './_lib/session.js';
import { AUTH_URL, exchangeCode, getMe, saveTokens } from './_lib/meli.js';
import { db } from './_lib/db.js';

export default handler(async (req, res) => {
  const { action, code, state, error, next } = query(req);
  const safeNext = (n) => (typeof n === 'string' && !n.startsWith('//') && /^\/[a-z0-9/_-]*$/i.test(n) ? n : '');

  if (action === 'login') {
    try {
      requireEnv('RINDE_MELI_APP_ID', 'RINDE_MELI_SECRET', 'RINDE_MELI_REDIRECT_URI', 'SESSION_SECRET', 'TOKEN_ENC_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    } catch {
      return redirect(res, '/?error=config');
    }
    const st = randomToken(16);
    const verifier = randomToken(48);
    appendCookie(res, cookie('rinde_oauth', sign(`${st}|${verifier}|${safeNext(next)}`), { maxAge: 600 }));
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.RINDE_MELI_APP_ID,
      redirect_uri: process.env.RINDE_MELI_REDIRECT_URI,
      state: st,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return redirect(res, u.toString());
  }

  if (action === 'callback') {
    if (error) return redirect(res, '/?error=cancelado');
    const raw = unsign(parseCookies(req).rinde_oauth);
    const [st, verifier, nextPath] = (raw || '').split('|');
    if (!st || st !== state || !code) return redirect(res, '/?error=estado');
    appendCookie(res, cookie('rinde_oauth', '', { maxAge: 0 }));
    try {
      const tokens = await exchangeCode(code, verifier);
      const me = await getMe(tokens.access_token);
      if (me.site_id && me.site_id !== 'MLA') return redirect(res, '/?error=sitio');
      const nowIso = new Date().toISOString();
      const [user] = await db.upsert('rinde_users', [{ meli_user_id: me.id, nickname: me.nickname, email: me.email || null, last_login_at: nowIso }], 'meli_user_id');
      if (!user.alert_email && me.email) await db.update('rinde_users', { id: user.id }, { alert_email: me.email });
      await saveTokens(user.id, tokens);
      setSession(res, user.id);
      return redirect(res, safeNext(nextPath) || '/app#/conectando');
    } catch (e) {
      console.error('[rinde][auth]', e);
      return redirect(res, '/?error=meli');
    }
  }

  if (action === 'logout') {
    clearSession(res);
    return redirect(res, '/');
  }

  if (action === 'disconnect') {
    method(req, 'POST');
    const s = requireSession(req);
    // Borra tokens y todos los datos del usuario (las tablas rinde_* tienen ON DELETE CASCADE).
    await db.remove('rinde_connections', { user_id: s.userId });
    await db.remove('rinde_users', { id: s.userId });
    clearSession(res);
    return json(res, 200, { ok: true });
  }

  throw new AppError(404, 'Acción desconocida.');
});
