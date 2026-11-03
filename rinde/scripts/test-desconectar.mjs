// Prueba: desconectar / borrar un usuario NUNCA toca los datos de otro.
// Levanta una base falsa (imita a Supabase/PostgREST, con borrado en cascada) y el servidor local,
// y llama a los endpoints reales. Uso: node scripts/test-desconectar.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PORT = 54399, APP_PORT = 3199;
process.env.SESSION_SECRET = 'secreto-de-prueba-123456789012345678901234567890';
process.env.SUPABASE_URL = `http://localhost:${DB_PORT}`;
process.env.SUPABASE_SERVICE_KEY = 'prueba';

// ── Base falsa ──
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const USER_TABLES = ['rinde_connections', 'rinde_sync_jobs', 'rinde_items', 'rinde_orders', 'rinde_costs', 'rinde_ai_plans', 'rinde_diagnoses', 'rinde_alerts', 'rinde_validation_runs'];
const T = { rinde_users: [], rinde_payments: [], rinde_settings: [] };
USER_TABLES.forEach((t) => (T[t] = []));
for (const [id, nick] of [[A, 'USUARIO_A'], [B, 'USUARIO_B']]) {
  T.rinde_users.push({ id, nickname: nick, plan: 'rinde', free_diagnosis_used_at: '2026-11-01' });
  for (const t of USER_TABLES) T[t].push({ id: `${t}-${nick}`, user_id: id, item_id: 'MLA1', order_id: '1', key: 'k' });
  T.rinde_payments.push({ id: `pago-${nick}`, user_id: id, amount: 15000 });
}
const writes = [];
const parse = (search) => {
  const f = [];
  for (const [k, v] of new URLSearchParams(search)) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) f.push((r) => String(r[k]) === v.slice(3));
    else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')); f.push((r) => set.includes(String(r[k]))); }
    else if (v === 'is.null') f.push((r) => r[k] == null);
    else f.push(() => false);
  }
  return f;
};
const dbServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace('/rest/v1/', '');
  const rows = T[table] || (T[table] = []);
  const f = parse(u.search);
  const hit = rows.filter((r) => f.every((fn) => fn(r)));
  if (req.method !== 'GET') writes.push(`${req.method} ${table}${u.search}`);
  if (req.method === 'DELETE') {
    T[table] = rows.filter((r) => !hit.includes(r));
    if (table === 'rinde_users') for (const r of hit) {
      for (const t of USER_TABLES) T[t] = T[t].filter((x) => x.user_id !== r.id); // ON DELETE CASCADE
      T.rinde_payments.forEach((p) => { if (p.user_id === r.id) p.user_id = null; }); // ON DELETE SET NULL
    }
    res.statusCode = 204; return res.end();
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(hit));
});
await new Promise((r) => dbServer.listen(DB_PORT, r));

// ── Servidor de la app ──
const app = spawn('node', ['scripts/dev-server.mjs'], { cwd: root, env: { ...process.env, PORT: String(APP_PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const { sign } = await import('../api/_lib/crypto.js');
const cookieFor = (uid) => `rinde_s=${encodeURIComponent(sign(`${uid}|${Date.now() + 3600000}`))}`;
const post = (p, uid, body) => fetch(`http://localhost:${APP_PORT}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieFor(uid) }, body: JSON.stringify(body || {}) });

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const countB = () => USER_TABLES.reduce((n, t) => n + T[t].filter((r) => r.user_id === B).length, 0) + T.rinde_users.filter((u) => u.id === B).length;
const countA = () => USER_TABLES.reduce((n, t) => n + T[t].filter((r) => r.user_id === A).length, 0) + T.rinde_users.filter((u) => u.id === A).length;
const B0 = countB();

// 1) Desconectar A
let r = await post('/api/auth/disconnect', A);
ok(r.status === 200, `Desconectar A responde 200 (${r.status})`);
ok(!T.rinde_connections.some((c) => c.user_id === A), 'A: se borró solo su conexión con MeLi');
ok(T.rinde_users.some((u) => u.id === A) && T.rinde_diagnoses.some((d) => d.user_id === A) && T.rinde_validation_runs.some((d) => d.user_id === A), 'A: usuario, diagnóstico y validación siguen guardados');
ok(T.rinde_users.find((u) => u.id === A)?.plan === 'rinde', 'A: la suscripción sigue igual');
ok(countB() === B0, `B intacto (${countB()}/${B0} filas)`);

// 2) Borrar A sin escribir BORRAR
r = await post('/api/auth/delete', A, { confirm: 'borrar' });
ok(r.status === 400, `Borrar sin "BORRAR" exacto se rechaza (${r.status})`);
ok(T.rinde_users.some((u) => u.id === A), 'A: no se borró nada');

// 3) Borrar A con BORRAR
r = await post('/api/auth/delete', A, { confirm: 'BORRAR' });
ok(r.status === 200, `Borrar con "BORRAR" responde 200 (${r.status})`);
ok(countA() === 0, 'A: todos sus datos borrados');
ok(T.rinde_payments.some((p) => p.id === 'pago-USUARIO_A' && p.user_id === null), 'A: su pago queda guardado para facturar (sin usuario)');
ok(countB() === B0 && T.rinde_payments.find((p) => p.id === 'pago-USUARIO_B')?.user_id === B, `B intacto después del borrado (${countB()}/${B0} filas)`);
ok(writes.filter((w) => w.startsWith('DELETE')).every((w) => w.includes(A)), 'Todos los DELETE que llegaron a la base llevan el id de A');

// 4) Protección de db.js: filtros vacíos no llegan a la base
const { db } = await import('../api/_lib/db.js');
const before = writes.length;
const blocked = async (fn, msg) => { try { await fn(); ok(false, msg); } catch (e) { ok(e.code === 'unsafe_write', `${msg} → bloqueado`); } };
await blocked(() => db.remove('rinde_items', {}), 'DELETE sin filtro');
await blocked(() => db.remove('rinde_users', { id: undefined }), 'DELETE rinde_users con id vacío');
await blocked(() => db.remove('rinde_connections', { user_id: '' }), 'DELETE conexiones con user_id ""');
await blocked(() => db.remove('rinde_items', { item_id: 'MLA1' }), 'DELETE de tabla de usuario sin user_id');
await blocked(() => db.update('rinde_users', {}, { plan: 'free' }), 'UPDATE usuarios sin filtro');
await blocked(() => db.update('rinde_alerts', { id: ['x'] }, { resolved_at: 'hoy' }), 'UPDATE alertas sin user_id');
await blocked(() => db.remove('rinde_items', { user_id: B, item_id: [] }), 'DELETE con lista vacía');
await blocked(() => db.update('rinde_payments', { id: undefined }, { invoiced_at: null }), 'UPDATE pagos con id vacío');
ok(writes.length === before, 'Ninguno de esos llegó a la base');
ok(countB() === B0, 'B sigue intacto al final');

app.kill();
dbServer.close();
console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
