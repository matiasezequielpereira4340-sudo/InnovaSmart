// GET  /api/diagnosis — modelo completo de la cuenta (diagnóstico + rentabilidad + alertas).
// POST /api/diagnosis — genera los planes con IA por lotes y, al final, el resumen de la cuenta.
import { handler, json, method, AppError } from './_lib/http.js';
import { currentUser, isPaid, publicUser } from './_lib/users.js';
import { loadAccount, getJob, progressOf } from './_lib/sync.js';
import { buildModel, buildRuleSummary } from '../shared/model.js';
import { buildRulePlan } from '../shared/rules.js';
const buildRulePlanHeadline = (r) => buildRulePlan(r.it, r.cls, r.profit).headline;
import { generatePlans, generateSummary, planHash, claimsFakeLoss } from './_lib/ai.js';
import { LIMITS } from '../shared/config.js';
import { db } from './_lib/db.js';
import { sha256 } from './_lib/crypto.js';

export default handler(async (req, res) => {
  const u = await currentUser(req);
  const paid = isPaid(u);

  if (req.method === 'GET') {
    const { data, job } = await loadAccount(u.id);
    if (!job || job.status !== 'done') return json(res, 409, { error: 'Todavía no terminamos de analizar tu cuenta.', code: 'not_ready', sync: job ? progressOf(job) : null });
    const model = buildModel(data);
    const diag = await db.one('rinde_diagnoses', { user_id: u.id }, { order: 'created_at.desc' });
    // El titular y los montos siempre se recalculan con las reglas (corrige diagnósticos viejos con "pierde").
    const rule = buildRuleSummary(model);
    const stored = diag?.summary;
    const fixFor = (label) => { const f = (stored?.problems || []).find((x) => x.label === label)?.fix; return f && !claimsFakeLoss(f) ? f : null; };
    const sameTop = stored?.problems?.[0]?.label && stored.problems[0].label === rule.problems[0]?.label;
    const summary = stored
      ? { ...stored, headline: rule.headline, revenueNote: rule.revenueNote, explain: rule.explain, abandoned: rule.abandoned, seasonal: rule.seasonal, tips: rule.tips, problems: rule.problems.map((p) => ({ ...p, fix: fixFor(p.label) || p.fix })), first: sameTop && stored.first && !claimsFakeLoss(stored.first) ? stored.first : rule.first }
      : rule;
    for (const r of model.rows) if (r.plan?.source === 'ia' && claimsFakeLoss(r.plan.headline, r.profit)) r.plan = { ...r.plan, headline: buildRulePlanHeadline(r) };
    const sales90 = model.rows.reduce((t, r) => t + (r.it.sales90 || 0), 0);
    return json(res, 200, {
      user: publicUser(u),
      paid,
      syncedAt: job.finished_at,
      sales90,
      summary,
      diagnosedAt: diag?.created_at || null,
      model: { ...model, rows: model.rows, kpis: paid ? model.kpis : null, alerts: paid ? model.alerts : [] },
      settings: data.settings,
      productAds: !!data.productAds,
    });
  }

  method(req, 'POST');
  const job = await getJob(u.id);
  if (!job || job.status !== 'done') throw new AppError(409, 'Primero tenemos que terminar de leer tu cuenta.', 'not_ready');
  const existing = await db.one('rinde_diagnoses', { user_id: u.id }, { columns: 'id,created_at,sync_finished_at', order: 'created_at.desc' });
  if (existing && existing.sync_finished_at === job.finished_at) return json(res, 200, { done: true, remaining: 0 });
  if (!paid && u.free_diagnosis_used_at && existing) {
    throw new AppError(402, 'Ya usaste tu diagnóstico gratis. Con el Plan Rinde lo regenerás cuando quieras.', 'plan_required');
  }

  const { data } = await loadAccount(u.id);
  const model = buildModel({ ...data, plans: {} });
  const used = job.meta?.ai_tokens || 0;

  // Publicaciones que necesitan plan de IA: no sanas, ordenadas por impacto. Si el hash no cambió, se reutiliza.
  const pending = model.rows
    .filter((r) => r.cls.category !== 'SANA')
    .sort((a, b) => (b.lost + (b.profit.net < 0 ? -b.profit.net : 0)) - (a.lost + (a.profit.net < 0 ? -a.profit.net : 0)))
    .filter((r) => data.planHashes[r.it.id] !== planHash(r));

  if (pending.length && used < LIMITS.AI_MAX_OUTPUT_TOKENS_PER_DIAGNOSIS) {
    const batch = pending.slice(0, LIMITS.AI_ITEMS_PER_BATCH);
    const budget = Math.min(LIMITS.AI_MAX_TOKENS_PER_BATCH, LIMITS.AI_MAX_OUTPUT_TOKENS_PER_DIAGNOSIS - used);
    const { plans, tokens, error } = await generatePlans(batch, budget);
    const rows = batch.map((r) => {
      let plan = plans[r.it.id] || { ...r.plan, source: 'reglas' };
      if (plan.source === 'ia' && claimsFakeLoss(plan.headline, r.profit)) plan = { ...plan, headline: r.plan.headline };
      return { user_id: u.id, item_id: r.it.id, input_hash: planHash(r), plan, created_at: new Date().toISOString() };
    });
    await db.upsert('rinde_ai_plans', rows, 'user_id,item_id');
    const aiTokens = used + tokens + (error ? LIMITS.AI_MAX_TOKENS_PER_BATCH : 0); // si la IA falla, no insistimos indefinidamente
    await db.update('rinde_sync_jobs', { user_id: u.id }, { meta: { ...job.meta, ai_tokens: aiTokens } });
    return json(res, 200, { done: false, remaining: pending.length - batch.length, analyzed: batch.length, aiAvailable: !!process.env.ANTHROPIC_API_KEY });
  }

  // Resumen de la cuenta (caché por hash de los datos)
  const full = buildModel(data);
  const rule = buildRuleSummary(full);
  const hash = sha256(JSON.stringify([full.groupCounts, full.problems.map((p) => [p.code, Math.round(p.impact)])])).slice(0, 32);
  const prev = await db.one('rinde_diagnoses', { user_id: u.id, input_hash: hash }, { order: 'created_at.desc' });
  const summary = prev?.summary || (await generateSummary(full, rule)) || rule;
  await db.insert('rinde_diagnoses', [{ user_id: u.id, input_hash: hash, summary, tokens_used: (job.meta?.ai_tokens || 0) + (summary.tokens || 0), sync_finished_at: job.finished_at, counts: full.groupCounts }]);
  if (!u.free_diagnosis_used_at) await db.update('rinde_users', { id: u.id }, { free_diagnosis_used_at: new Date().toISOString() });
  json(res, 200, { done: true, remaining: 0 });
});
