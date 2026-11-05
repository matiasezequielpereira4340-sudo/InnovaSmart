// Filtro de los planes de acción (IA y reglas) contra la nota de publicación Rinde.
// La nota es la única fuente de las mejoras de la ficha: si un plan sugiere algo que la nota NO recomienda
// (recortar un título que MeLi acepta, pasar a Premium, ofrecer envío gratis), esa acción se reemplaza
// por una del plan de reglas. Código puro para poder probarlo.

import { mentionsInternalAttr } from './attrs.js';

const TRIM_TITLE = (t) => /(recort|acort|achic|reduc|sac[aá])\w*.{0,30}t[ií]tulo|t[ií]tulo.{0,40}(recort|acort|m[aá]s corto|achic|reduc|hasta 60|60 caracteres)/i.test(t);
const FULL_FLEX = /\b(full|flex)\b/i;
const PREMIUM = /premium/i;
const FREE_SHIP = /env[ií]o gratis/i;

const TOPICS = [['fotos', /foto/i], ['video', /video|clip/i], ['atributos', /atribut/i], ['descripcion', /descrip/i], ['titulo', /t[ií]tulo/i], ['preguntas', /pregunta/i], ['stock', /stock/i], ['precio', /precio/i]];
const topicOf = (a) => (TOPICS.find(([, re]) => re.test(a?.title || '')) || [])[0] || null;

/** Qué recomienda la nota (con cualquier criterio que tenga mejora, no solo las 3 primeras). */
export function scoreAllows(score, { ship = null } = {}) {
  const fixes = (score?.criteria || []).filter((c) => c.fix);
  return {
    premium: fixes.some((c) => c.key === 'tipo' && PREMIUM.test(c.fix)),
    freeShip: fixes.some((c) => c.key === 'envio'),
    fullFlex: !!ship, // solo con venta sostenida (sugerencia de envío calculada)
    trim: false, // nunca: un título publicado es un título que Mercado Libre aceptó
  };
}

/** Motivo por el que una acción contradice la nota (o null si está bien). */
export function conflictOf(action, allow) {
  const t = `${action?.title || ''} ${action?.detail || ''}`;
  if (!allow.trim && TRIM_TITLE(t)) return 'recortar título';
  // Planes guardados antes del filtro: "Cargá …, IVA, Impuesto interno" (atributos que el comprador no ve).
  if (mentionsInternalAttr(t)) return 'atributo fiscal o interno';
  if (!allow.premium && PREMIUM.test(t)) return 'pasar a Premium';
  if (!allow.fullFlex && FULL_FLEX.test(t)) return 'Full o Flex';
  if (!allow.freeShip && FREE_SHIP.test(t) && !/ya (ten[eé]s|ofrec)/i.test(t)) return 'envío gratis';
  return null;
}

/**
 * Devuelve el plan sin acciones que contradigan la nota. Las que se sacan se reemplazan con acciones
 * del plan de reglas (que tampoco contradigan). Si el titular contradice, va el de reglas.
 */
export function guardPlan(plan, score, rulePlan, opts = {}) {
  if (!plan) return rulePlan;
  const allow = scoreAllows(score, opts);
  const keep = (plan.actions || []).filter((a) => !conflictOf(a, allow));
  const removed = (plan.actions || []).length - keep.length;
  // No repetir tema: si la IA ya dice "Sumá fotos", no se suma "Mejorá las fotos" de reglas.
  const seen = new Set(keep.flatMap((a) => [a.title.toLowerCase(), topicOf(a)]).filter(Boolean));
  const pool = (rulePlan?.actions || []).filter((a) => !conflictOf(a, allow) && !seen.has(a.title.toLowerCase()) && !(topicOf(a) && seen.has(topicOf(a))));
  const actions = [...keep];
  while (actions.length < Math.min(5, (plan.actions || []).length) && pool.length) actions.push(pool.shift());
  const badHead = conflictOf({ title: plan.headline }, allow);
  if (!removed && !badHead) return plan;
  return { ...plan, headline: badHead ? rulePlan?.headline || plan.headline : plan.headline, actions, guarded: removed + (badHead ? 1 : 0) };
}
