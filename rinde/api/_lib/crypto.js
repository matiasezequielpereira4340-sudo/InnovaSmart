// Cifrado de tokens (AES-256-GCM) y firma de cookies (HMAC-SHA256).
import crypto from 'node:crypto';

function keyFrom(secret) {
  if (!secret) throw new Error('missing key');
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  const b = Buffer.from(secret, 'base64');
  if (b.length === 32) return b;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plain) {
  const key = keyFrom(process.env.TOKEN_ENC_KEY);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1') throw new Error('bad payload');
  const key = keyFrom(process.env.TOKEN_ENC_KEY);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export function sign(value) {
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed) {
  if (!signed || !process.env.SESSION_SECRET) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = sign(value);
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
