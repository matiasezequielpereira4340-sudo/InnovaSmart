// Planes de acción con IA (Claude Haiku 5.5): tope de tokens por diagnóstico y caché por hash de datos.
import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto.js';
import { LIMITS } from '../../shared/config.js';
import { fmtMoney, fmtPct, LISTING_LABEL, conversion, priceGap } from '../../shared/rules.js';

const MODEL = 'claude-haiku-5-5';

let client;
function ai() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25000 }) // < 60 s de la función;
  return client;
}

const SYSTEM = `Sos el analista de Rinde, una herramienta de Innovasmart para vendedores de Mercado Libre Argentina.
Escribís en español rioplatense (vos, tenés, hacé), directo, sin relleno, sin saludos ni frases motivacionales.
Reglas estrictas:
- Usá SOLO los datos que te pasan. No inventes números, precios de competencia, ni datos que digan "sin dato".
- Si un dato dice "sin dato", no lo uses para afirmar nada.
- Máximo 5 acciones por publicación, ordenadas de mayor a menor impacto. Cada acción es concreta y ejecutable hoy.
- Tomá como base las "mejoras pendientes de Mercado Libre" y los "motivos detectados".
- Si la publicación no tiene demanda (casi sin visitas con la ficha bien armada, o competencia saturada con un precio imposible de igualar), el veredicto es "liquidar" y el titular dice exactamente: "Este producto no tiene salida: liquidalo o pausalo."
- Rinde es de solo lectura: las acciones las hace el vendedor en Mercado Libre.
- Nunca digas que el vendedor "pierde", "perdió" o tiene "pérdidas" salvo que la ganancia neta real sea negativa. Las ventas perdidas son una ESTIMACIÓN: decí "podrías estar dejando de vender" y no pongas montos que no te pasaron.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          verdict: { type: 'string', enum: ['mejorar', 'liquidar', 'mantener'] },
          headline: { type: 'string' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
                impact: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
              },
              required: ['title', 'detail', 'impact'],
              additionalProperties: false,
            },
          },
        },
        required: ['item_id', 'verdict', 'headline', 'actions'],
        additionalProperties: false,
      },
    },
  },
  required: ['plans'],
  additionalProperties: false,
};

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' } },
        required: ['label', 'detail', 'fix'],
        additionalProperties: false,
      },
    },
    first: { type: 'string' },
  },
  required: ['headline', 'problems', 'first'],
  additionalProperties: false,
};

/** Texto con los datos reales de una publicación (lo que ve la IA). */
export function itemFacts(r) {
  const it = r.it;
  const p = r.profit;
  const sd = (v) => (v == null ? 'sin dato' : v);
  return [
    `item_id: ${it.id}`,
    `Título: "${it.title}" (${(it.title || '').length} caracteres)`,
    `Categoría Rinde: ${r.cls.category}`,
    `Precio: ${fmtMoney(it.price)} · Tipo: ${LISTING_LABEL[it.listing_type] || sd(it.listing_type)} · Envío: ${it.shipping?.logistic === 'fulfillment' ? 'Full' : it.shipping?.flex ? 'Flex' : 'normal'}${it.shipping?.free_shipping ? ', gratis' : ''}`,
    `Estado: ${it.status}${it.sub_status?.length ? ` (${it.sub_status.join(', ')})` : ''} · Stock: ${sd(it.available_quantity)}`,
    `Visitas 30 días: ${sd(it.visits30)} · Ventas 30 días: ${sd(it.sales30)} · Ventas 90 días: ${sd(it.sales90)} · Conversión: ${fmtPct(conversion(it))}`,
    `Calidad MeLi: ${it.quality ? `${sd(it.quality.score)}/100 (${sd(it.quality.level_wording)})` : 'sin dato'}`,
    `Mejoras pendientes de Mercado Libre: ${it.quality?.pending_actions?.length ? it.quality.pending_actions.join(' | ') : 'ninguna informada'}`,
    `Fotos: ${sd(it.pictures_count)} · Catálogo: ${it.catalog_product_id ? (it.catalog_listing ? 'compite en catálogo' : 'hay ficha de catálogo y NO compite') : 'no aplica'}`,
    `Preguntas sin responder: ${sd(it.questions_unanswered)}${it.oldest_question_hours ? ` (la más vieja hace ${it.oldest_question_hours} h)` : ''}`,
    `Competencia: ${it.competition ? `mínimo ${fmtMoney(it.competition.min_price)}, mediana ${fmtMoney(it.competition.median_price)}, ${it.competition.count} publicaciones (fuente: ${it.competition.source}); tu diferencia vs referencia: ${fmtPct(priceGap(it))}` : 'sin dato'}`,
    `Rentabilidad 30 días: ${p.hasCost ? `ganancia neta ${fmtMoney(p.net)}, margen ${fmtPct(p.margin)}, margen a costo de reposición ${fmtPct(p.marginReplacement)}, precio mínimo sin pérdida ${fmtMoney(p.minPrice)}, precio sugerido ${fmtMoney(p.suggestedPrice)}` : 'costo sin cargar (no calcules ganancia)'}`,
    `Motivos detectados: ${(r.cls.reasons || []).map((x) => x.text).join(' | ') || 'ninguno'}`,
    `Sin demanda según reglas: ${r.cls.noDemand ? 'sí' : 'no'}`,
  ].join('\n');
}

const LOSS_WORDS = /\b(pierd\w*|perd[ée]s|perdi[óo]\w*|p[ée]rdida\w*|perdiendo)\b/i;
/** true si el texto habla de "pérdida" sin que haya pérdida real (ganancia neta negativa). */
export function claimsFakeLoss(text, profit) {
  return LOSS_WORDS.test(String(text || '')) && !(profit?.hasCost && profit.net < 0);
}

export function planHash(r) {
  return sha256(itemFacts(r)).slice(0, 32);
}

function textOf(resp) {
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Genera planes para un lote de publicaciones. Devuelve { plans: {id: plan}, tokens }.
 * Si la IA no está configurada o falla, devuelve {} y se usan los planes por reglas.
 */
export async function generatePlans(rows, maxTokens = LIMITS.AI_MAX_TOKENS_PER_BATCH) {
  const c = ai();
  if (!c || !rows.length) return { plans: {}, tokens: 0 };
  const content = `Armá el plan de acción para cada una de estas ${rows.length} publicaciones.\n\n` + rows.map((r, i) => `### Publicación ${i + 1}\n${itemFacts(r)}`).join('\n\n');
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    const tokens = resp.usage?.output_tokens || 0;
    if (resp.stop_reason !== 'end_turn') return { plans: {}, tokens };
    const parsed = JSON.parse(textOf(resp));
    const ids = new Set(rows.map((r) => r.it.id));
    const plans = {};
    for (const p of parsed.plans || []) {
      if (!ids.has(p.item_id)) continue;
      plans[p.item_id] = { verdict: p.verdict, headline: p.headline, actions: (p.actions || []).slice(0, 5), source: 'ia' };
    }
    return { plans, tokens };
  } catch (e) {
    console.error('[rinde][ia] planes', e?.status, e?.message);
    return { plans: {}, tokens: 0, error: true };
  }
}

export async function generateSummary(model, ruleSummary) {
  const c = ai();
  if (!c) return null;
  const facts = [
    `Publicaciones analizadas: ${model.rows.length}`,
    `Por categoría: ${Object.entries(model.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Ventas mensuales que se estiman perdidas: ${fmtMoney(model.lostTotal)} (estimado)`,
    `Facturación real de los últimos 30 días: ${fmtMoney(model.revenue?.d30)}`,
    `Reputación del vendedor: ${model.seller?.reputation?.level_id || 'sin dato'}`,
    `Problemas rankeados por impacto (ya calculados, respetá el orden):`,
    ...model.problems.map((p, i) => `${i + 1}. ${p.label} — ${p.items.length} publicaciones — impacto estimado ${fmtMoney(p.impact)}/mes`),
    `Rentabilidad: facturación 30 días ${fmtMoney(model.kpis.revenue)}, productos que pierden plata ${model.kpis.losing}, productos sin costo cargado ${model.kpis.noCost}`,
  ].join('\n');
  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: LIMITS.AI_MAX_TOKENS_SUMMARY,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      messages: [{ role: 'user', content: `Escribí el resumen de la cuenta: un titular de una oración, los 3 problemas que más ventas le están costando (en el mismo orden, con qué hacer) y qué arreglar primero.\n\n${facts}` }],
    });
    if (resp.stop_reason !== 'end_turn') return null;
    const s = JSON.parse(textOf(resp));
    const clean = (t, fallback) => (t && !LOSS_WORDS.test(t) ? t : fallback);
    // Los números y el titular salen siempre de las reglas (con respaldo); la IA solo redacta qué hacer.
    return {
      ...ruleSummary,
      problems: ruleSummary.problems.map((p, i) => ({ ...p, fix: clean((s.problems || []).find((x) => x.label === p.label)?.fix || (s.problems?.[i]?.label ? null : s.problems?.[i]?.fix), p.fix) })),
      first: s.problems?.[0]?.label === ruleSummary.problems[0]?.label ? clean(s.first, ruleSummary.first) : ruleSummary.first,
      source: 'ia',
      tokens: resp.usage?.output_tokens || 0,
    };
  } catch (e) {
    console.error('[rinde][ia] resumen', e?.status, e?.message);
    return null;
  }
}
