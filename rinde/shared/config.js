// ─────────────────────────────────────────────────────────────
// Rinde — umbrales y constantes configurables (un solo lugar).
// Este archivo lo usan tanto el servidor (/api) como el navegador.
// ─────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  // Debajo de esta cantidad de visitas en 30 días = problema de visibilidad.
  VISITS_MIN_30D: 60,
  // Conversión mínima esperada (ventas / visitas, 30 días). 0.01 = 1 %.
  CONVERSION_MIN: 0.01,
  // Conversión "buena" que usamos para estimar ventas perdidas.
  CONVERSION_TARGET: 0.015,
  // Puntaje de calidad (/performance) debajo del cual lo consideramos bajo.
  QUALITY_MIN_SCORE: 70,
  // Si tu precio está más de este % arriba del precio de referencia de la competencia.
  PRICE_GAP_ALERT: 0.08,
  // Mínimo de fotos recomendado.
  PICTURES_MIN: 6,
  // Títulos más cortos que esto suelen posicionar peor.
  TITLE_MIN_CHARS: 35,
  // Margen neto debajo del cual consideramos que el producto "no deja margen".
  MARGIN_HEALTHY_MIN: 0.08,
  // Margen objetivo para el precio sugerido.
  TARGET_MARGIN: 0.2,
  // Si el margen a costo de reposición es menor que el margen a costo de compra
  // por más de estos puntos, alertamos.
  REPLACEMENT_GAP_ALERT: 0.1,
  // Si envío + cargo fijo superan este % del precio, marcamos "El envío gratis te come esta venta".
  SHIP_FIXED_EATS: 0.5,
  // Preguntas sin responder hace más de estas horas disparan alerta.
  QUESTION_ALERT_HOURS: 24,
  // "Sin salida": casi sin visitas, sin ventas en 90 días y competencia saturada.
  NO_DEMAND_VISITS_30D: 8,
  NO_DEMAND_COMPETITORS: 40,
};

// Datos de MeLi que hoy la app no puede leer: calidad (/item/{id}/performance responde 403 "sin permiso")
// y competencia (la búsqueda pública /sites/MLA/search está cerrada para apps). Si MeLi habilita el permiso, poner true.
export const FEATURES = { quality: false, competition: false };

export const LIMITS = {
  // Tope de tokens de salida de IA por diagnóstico completo de una cuenta.
  AI_MAX_OUTPUT_TOKENS_PER_DIAGNOSIS: 40000,
  AI_MAX_TOKENS_PER_BATCH: 3500,
  AI_MAX_TOKENS_SUMMARY: 1500,
  AI_ITEMS_PER_BATCH: 6,
  // Caché de datos de MeLi.
  MELI_CACHE_HOURS: 6,
  // Publicaciones procesadas por llamada de sincronización.
  ITEMS_PER_SYNC_STEP: 20,
};

export const CATEGORIES = {
  OPERATIVO: { key: 'OPERATIVO', label: 'Sin stock o pausadas', short: 'Sin stock o pausadas', tone: 'bad', icon: 'alert', order: 1,
    desc: 'Hoy no pueden vender: sin stock, pausadas, con infracción o bajo revisión.' },
  PIERDE_PLATA: { key: 'PIERDE_PLATA', label: 'Vende pero pierde plata', short: 'Pierde plata', tone: 'bad', icon: 'down', order: 2,
    desc: 'Vende, pero después de costos y cargos no te deja ganancia.' },
  SIN_VISITAS: { key: 'SIN_VISITAS', label: 'Sin visitas', short: 'Sin visitas', tone: 'warn', icon: 'eyeoff', order: 3,
    desc: 'Problema de visibilidad: casi nadie la ve.' },
  SIN_VENTAS: { key: 'SIN_VENTAS', label: 'Visitas sin ventas', short: 'Sin ventas', tone: 'warn', icon: 'cart', order: 4,
    desc: 'Problema de conversión: la ven pero no la compran.' },
  SANA: { key: 'SANA', label: 'Sana', short: 'Sana', tone: 'ok', icon: 'check', order: 5,
    desc: 'Vende bien y deja margen.' },
};

// Grupos que ve el usuario (tarjetas y lista): cada publicación está en UNO solo y suman el total.
export const GROUPS = {
  SIN_STOCK: { key: 'SIN_STOCK', label: 'Sin stock', short: 'Sin stock', tone: 'bad', icon: 'alert', order: 1, desc: 'Vendían y hoy no tienen stock.' },
  PAUSADAS: { key: 'PAUSADAS', label: 'Pausadas', short: 'Pausadas', tone: 'bad', icon: 'alert', order: 2, desc: 'Vendían y hoy están pausadas.' },
  BLOQUEADAS: { key: 'BLOQUEADAS', label: 'Con infracción o en revisión', short: 'Infracción', tone: 'bad', icon: 'alert', order: 3, desc: 'Mercado Libre las frenó.', hideEmpty: true },
  PIERDE_PLATA: { key: 'PIERDE_PLATA', label: 'Vende pero pierde plata', short: 'Pierde plata', tone: 'bad', icon: 'down', order: 4, desc: 'Vende, pero después de costos y cargos no te deja ganancia.' },
  POCA_VISIBILIDAD: { key: 'POCA_VISIBILIDAD', label: 'Poca visibilidad', short: 'Poca visibilidad', tone: 'warn', icon: 'eyeoff', order: 5, desc: 'Vendían, hoy casi nadie las ve.' },
  SIN_VENTAS: { key: 'SIN_VENTAS', label: 'Visitas sin ventas', short: 'Visitas sin ventas', tone: 'warn', icon: 'cart', order: 6, desc: 'La ven pero no la compran.', hideEmpty: true },
  TEMPORADA: { key: 'TEMPORADA', label: 'De temporada', short: 'De temporada', tone: 'neutral', icon: 'info', order: 7, desc: 'Se venden en otra época del año: no las contamos ahora.', hideEmpty: true },
  ABANDONADAS: { key: 'ABANDONADAS', label: 'Abandonadas', short: 'Abandonadas', tone: 'neutral', icon: 'x', order: 8, desc: 'Sin ninguna venta en 6 meses.' },
  SANA: { key: 'SANA', label: 'Sanas', short: 'Sanas', tone: 'ok', icon: 'check', order: 9, desc: 'Venden y no tienen problemas.' },
};

// Temporada (hemisferio sur). Meses 1-12. Una publicación es "de temporada" fuera de su época si el título lo dice
// o si al menos el 70 % de sus ventas de 6 meses cayó en esos meses. El mes previo cuenta como temporada (se repone antes).
export const SEASONS = {
  invierno: { months: [5, 6, 7, 8], pre: [4], prepare: 'marzo/abril', words: /invierno|polar|kigurumi|frazada|estufa|calefactor|bufanda|chiporro|corderito|abrigo|campera|guantes t[eé]rmicos|pantuflas/i },
  verano: { months: [11, 12, 1, 2], pre: [10], prepare: 'agosto/septiembre', words: /verano|pileta|piscina|inflable|malla|bikini|protector solar|pistola de agua|ventilador|sombrilla|reposera|ojotas/i },
};

export const PLAN_PRICE_ARS = 15000;
export const WHATSAPP_NUMBER = '5491160374306';

export const WA_MESSAGES = {
  subscribe: 'Hola, quiero el Plan Rinde de $15.000',
  optimize: 'Hola! Usé Rinde y quiero que Innovasmart optimice mis publicaciones de Mercado Libre por mí.',
  ai: 'Hola! Vi Rinde y quiero aprender a usar IA en mi negocio como esta herramienta.',
  import: 'Hola! Usé Rinde y quiero sumar productos para la otra temporada. ¿Me ayudan a importarlos?',
  help: 'Hola! Tengo una consulta sobre Rinde.',
};

export function waLink(kind) {
  const msg = WA_MESSAGES[kind] || WA_MESSAGES.help;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}
