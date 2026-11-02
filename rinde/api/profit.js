// GET  /api/profit?format=csv — plantilla de costos con tus SKUs ya listados.
// POST /api/profit {type:'costs', costs:[...]} — guarda costos por SKU.
// POST /api/profit {type:'ads', ads_manual_monthly, meta_ads_monthly} — gasto en publicidad manual.
import { handler, json, readBody, query, AppError } from './_lib/http.js';
import { currentUser, requirePaid } from './_lib/users.js';
import { db } from './_lib/db.js';
import { costKey } from '../shared/model.js';

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim());
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export default handler(async (req, res) => {
  const u = await currentUser(req);

  if (req.method === 'GET') {
    const { format } = query(req);
    if (format !== 'csv') throw new AppError(400, 'Formato no soportado.');
    const [items, costs] = await Promise.all([
      db.select('rinde_items', { user_id: u.id }, { columns: 'data' }),
      db.select('rinde_costs', { user_id: u.id }),
    ]);
    const cm = Object.fromEntries(costs.map((c) => [c.sku, c]));
    const seen = new Set();
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = ['sku;titulo;costo_compra;costo_reposicion_hoy'];
    for (const { data: it } of items) {
      const k = costKey(it);
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push([q(k), q(it.title), cm[k]?.purchase_cost ?? '', cm[k]?.replacement_cost ?? ''].join(';'));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rinde-costos.csv"');
    return res.end('﻿' + lines.join('\n'));
  }

  requirePaid(u, 'La rentabilidad');
  const body = await readBody(req);

  if (body.type === 'costs') {
    const list = Array.isArray(body.costs) ? body.costs.slice(0, 5000) : [];
    const rows = [];
    const bad = [];
    for (const c of list) {
      const sku = String(c.sku || '').trim().slice(0, 120);
      if (!sku) continue;
      const purchase = num(c.purchase);
      const replacement = num(c.replacement);
      if (Number.isNaN(purchase) || Number.isNaN(replacement)) { bad.push(sku); continue; }
      if (purchase == null && replacement == null) { await db.remove('rinde_costs', { user_id: u.id, sku }); continue; }
      rows.push({ user_id: u.id, sku, purchase_cost: purchase, replacement_cost: replacement, updated_at: new Date().toISOString() });
    }
    await db.upsert('rinde_costs', rows, 'user_id,sku');
    return json(res, 200, { ok: true, saved: rows.length, invalid: bad });
  }

  if (body.type === 'ads') {
    const s = { ...(u.settings || {}) };
    const a = num(body.ads_manual_monthly);
    const m = num(body.meta_ads_monthly);
    if (Number.isNaN(a) || Number.isNaN(m)) throw new AppError(400, 'Revisá los montos: tienen que ser números positivos.');
    s.ads_manual_monthly = a || 0;
    s.meta_ads_monthly = m || 0;
    await db.update('rinde_users', { id: u.id }, { settings: s });
    return json(res, 200, { ok: true });
  }

  throw new AppError(400, 'Pedido inválido.');
});
