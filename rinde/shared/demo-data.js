// Cuenta de ejemplo para el modo DEMO. Datos ficticios pero realistas (MLA, precios 2026).
// Se genera siempre igual (semilla fija) para que el demo sea estable.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const BASE = [
  // id, título, precio, visitas30, ventas30, ventas90, stock, estado, tipo, logística, envío gratis, fotos, calidad, preguntas, competencia, costo compra, costo reposición, extra
  ['MLA1460211001', 'Auriculares Bluetooth In Ear Inalámbricos Cancelación De Ruido TWS', 24999, 1840, 62, 171, 48, 'active', 'gold_pro', 'fulfillment', true, 9, 88, 0, { min: 22900, med: 25900, n: 64 }, 9800, 10900],
  ['MLA1460211002', 'Soporte Celular Moto Bici Aluminio Rotación 360 Impermeable', 12499, 2210, 88, 241, 130, 'active', 'gold_special', 'flex', true, 8, 91, 0, { min: 10999, med: 12900, n: 85 }, 3900, 4300],
  ['MLA1460211003', 'Lámpara Led Escritorio Recargable Táctil 3 Tonos Plegable', 18999, 960, 31, 88, 22, 'active', 'gold_pro', 'fulfillment', true, 7, 84, 1, { min: 17499, med: 19900, n: 41 }, 7200, 7900],
  ['MLA1460211004', 'Botella Térmica Acero Inoxidable 1 Litro Doble Pared Frío Calor', 21999, 1320, 41, 109, 35, 'active', 'gold_special', 'flex', true, 10, 86, 0, { min: 19900, med: 22500, n: 57 }, 8100, 9300],
  ['MLA1460211005', 'Organizador De Cables Escritorio Kit 30 Piezas Velcro Silicona', 8999, 780, 29, 77, 60, 'active', 'gold_special', 'drop_off', true, 6, 79, 0, { min: 7999, med: 9200, n: 33 }, null, null],
  ['MLA1460211006', 'Cargador Rápido 33W USB-C Carga Turbo Compatible Samsung Motorola', 15999, 1500, 47, 130, 75, 'active', 'gold_pro', 'fulfillment', true, 7, 90, 0, { min: 14500, med: 16200, n: 120 }, 5200, null],
  ['MLA1460211007', 'Freidora De Aire 4 Litros Digital 1400W 8 Programas Antiadherente', 89999, 2900, 38, 97, 14, 'active', 'gold_pro', 'fulfillment', true, 9, 87, 2, { min: 84999, med: 92000, n: 150 }, 61000, 72000],
  ['MLA1460211008', 'Smartwatch Reloj Inteligente Deportivo Notificaciones Malla Silicona', 32999, 1700, 44, 121, 30, 'active', 'gold_special', 'flex', true, 8, 83, 0, { min: 29999, med: 33900, n: 98 }, 19500, 26000],
  ['MLA1460211009', 'Mini Proyector Portátil Full Hd Wifi 1080p Android Netflix', 119999, 2400, 26, 70, 9, 'active', 'gold_pro', 'fulfillment', true, 10, 89, 1, { min: 109999, med: 124000, n: 72 }, 82000, 95000],
  ['MLA1460211010', 'Aspiradora Inalámbrica De Mano 2 En 1 Ciclónica Recargable', 54999, 1100, 19, 52, 11, 'active', 'gold_special', 'drop_off', true, 7, 80, 0, { min: 52000, med: 56900, n: 44 }, 39000, 47000],
  ['MLA1460211011', 'Funda Celular', 3499, 22, 0, 1, 40, 'active', 'free', 'drop_off', false, 2, 48, 0, null, 1200, 1400, { level: 'Básica', pending: ['Agregá la marca y el modelo compatible', 'Subí al menos 4 fotos más', 'Completá la ficha técnica'] }],
  ['MLA1460211012', 'Rodillera Deportiva Neoprene Compresión Talle', 9999, 41, 0, 2, 25, 'active', 'gold_special', 'drop_off', false, 4, 62, 0, { min: 8499, med: 10500, n: 38 }, 3600, 4100, { level: 'Estándar', pending: ['Completá el atributo Talle', 'Agregá foto con fondo blanco'] }],
  ['MLA1460211013', 'Kit Herramientas 46 Piezas Llaves Tubo Crique Maletín', 27999, 35, 0, 3, 18, 'active', 'gold_special', 'drop_off', true, 6, 74, 0, { min: 25999, med: 28900, n: 66 }, 15500, 17000, { catalog: 'MLA19912345' }],
  ['MLA1460211014', 'Repuesto Filtro Jarra Purificadora Agua Compatible Brita Maxtra', 14999, 5, 0, 0, 70, 'active', 'gold_special', 'drop_off', true, 6, 82, 0, { min: 6990, med: 8900, n: 120 }, 5100, 5600],
  ['MLA1460211015', 'Cortina Blackout', 23999, 18, 0, 1, 12, 'active', 'gold_special', 'drop_off', false, 3, 55, 0, { min: 19999, med: 24900, n: 90 }, 11000, 12500, { level: 'Básica', pending: ['Agregá medidas al título', 'Completá color y material'] }],
  ['MLA1460211016', 'Mouse Gamer RGB 7200 DPI Programable 7 Botones Cable Mallado', 13999, 52, 0, 4, 33, 'active', 'gold_special', 'drop_off', true, 5, 66, 0, { min: 12499, med: 14300, n: 77 }, 6100, 6800, { level: 'Estándar', pending: ['Agregá un video del producto'] }],
  ['MLA1460211017', 'Silla Gamer Ergonómica Reclinable Con Apoya Pies Almohadones', 189999, 1450, 6, 21, 8, 'active', 'gold_special', 'drop_off', true, 8, 81, 4, { min: 139999, med: 155000, n: 52 }, 98000, 112000],
  ['MLA1460211018', 'Parlante Bluetooth Portátil Resistente Al Agua 20W Graves', 39999, 880, 3, 10, 26, 'active', 'gold_special', 'flex', true, 3, 76, 2, { min: 35999, med: 39900, n: 61 }, null, null, { qhours: 52 }],
  ['MLA1460211019', 'Mochila Antirrobo Notebook 15.6 Puerto USB Impermeable', 44999, 610, 2, 7, 20, 'active', 'gold_special', 'drop_off', true, 7, 78, 0, null, null, null],
  ['MLA1460211020', 'Set Sartenes Antiadherentes 3 Piezas Aptas Inducción', 64999, 720, 4, 15, 15, 'active', 'gold_special', 'drop_off', true, 6, 80, 1, { min: 51999, med: 56500, n: 47 }, 29000, 33000],
  ['MLA1460211021', 'Cámara Seguridad Wifi Interior 360 Visión Nocturna Audio', 36999, 1300, 9, 30, 40, 'active', 'gold_pro', 'fulfillment', true, 8, 85, 6, { min: 33999, med: 36500, n: 110 }, 17500, 19800, { qhours: 30 }],
  ['MLA1460211022', 'Teclado Mecánico Inalámbrico Hot Swap Switches Red 75%', 79999, 95, 0, 0, 10, 'active', 'gold_special', 'drop_off', true, 7, 77, 0, { min: 52999, med: 58900, n: 60 }, 41000, 46000],
  ['MLA1460211023', 'Balanza Digital De Cocina 10kg Precisión 1g Tara', 11999, 640, 0, 54, 0, 'paused', 'gold_special', 'flex', true, 7, 87, 0, { min: 10999, med: 12400, n: 95 }, 3800, 4500, { sub: ['out_of_stock'] }],
  ['MLA1460211024', 'Ventilador De Pie 20 Pulgadas 5 Aspas 3 Velocidades 90W', 74999, 120, 0, 21, 16, 'paused', 'gold_pro', 'drop_off', true, 6, 83, 0, { min: 69999, med: 76000, n: 70 }, 43000, 52000],
  ['MLA1460211025', 'Tira Led RGB 5 Metros Control Remoto Bluetooth App Música', 16999, 310, 2, 25, 44, 'under_review', 'gold_special', 'drop_off', true, 5, 70, 0, { min: 14999, med: 17200, n: 130 }, 5900, 6600, { sub: ['warning'], infraction: true }],
];

const FEES = {
  gold_pro: { commission: 0.145, financing: 0.115 },
  gold_special: { commission: 0.135, financing: 0 },
  free: { commission: 0, financing: 0 },
};
const TAX_RATE = 0.035; // retenciones IIBB + percepciones aproximadas en el demo

export function getDemoData() {
  const rand = rng(20261102);
  const now = Date.now();
  const items = [];
  const lines = [];
  const costs = {};

  BASE.forEach((b, i) => {
    const [id, title, price, visits30, sales30, sales90, stock, status, listing, logistic, free, pics, qscore, qn, comp, pc, rc, extra = {}] = b;
    const sku = 'RND-' + String(i + 1).padStart(3, '0');
    const level = extra.level || (qscore >= 80 ? 'Profesional' : qscore >= 60 ? 'Estándar' : 'Básica');
    items.push({
      id, title, sku, price, currency: 'ARS', status,
      sub_status: extra.sub || [],
      infraction: !!extra.infraction,
      available_quantity: stock,
      listing_type: listing,
      shipping: { logistic, flex: logistic === 'flex', free_shipping: free },
      catalog_product_id: extra.catalog || null,
      catalog_listing: false,
      pictures_count: pics,
      thumbnail: null,
      permalink: '#',
      visits30, sales30, sales90,
      quality: { score: qscore, level_wording: level, pending_actions: extra.pending || (qscore < 85 ? ['Completá los atributos recomendados'] : []) },
      questions_unanswered: qn,
      oldest_question_hours: qn ? extra.qhours || 6 : 0,
      competition: comp ? { min_price: comp.min, median_price: comp.med, count: comp.n, source: 'búsqueda' } : null,
    });
    if (pc != null) costs[sku] = { purchase: pc, replacement: rc };

    // ventas de los últimos 30 días
    const fee = FEES[listing];
    let left = sales30;
    let n = 0;
    while (left > 0) {
      const qty = left > 3 && rand() < 0.15 ? 2 : 1;
      left -= qty;
      const daysAgo = Math.floor(rand() * 30);
      const gross = qty * price;
      const shipping = free ? (price >= 33000 ? 7900 + Math.round(rand() * 2500) : 4200) : 0;
      const estimated = daysAgo < 2; // la facturación de MeLi tarda: las ventas más nuevas van "estimado"
      lines.push({
        order_id: `2000009${String(i).padStart(2, '0')}${String(n++).padStart(4, '0')}`,
        item_id: id, sku, qty, unit_price: price,
        date: new Date(now - daysAgo * 86400000).toISOString(),
        fees: {
          commission: Math.round(gross * fee.commission + (price < 33000 ? 1150 * qty : 0)),
          shipping,
          financing: Math.round(gross * fee.financing),
          taxes: Math.round(gross * TAX_RATE),
          other: 0,
          fixed_fee: price < 33000 ? 1150 * qty : 0, // cargo fijo por unidad (incluido en comisión)
        },
        estimated,
        source: estimated ? 'orden' : 'facturación',
      });
    }
  });

  const d30 = lines.reduce((t, l) => t + l.qty * l.unit_price, 0);
  return {
    demo: true,
    // Facturación de ejemplo: el último mes cayó respecto del promedio de 6 meses.
    revenue: { d30, d90: Math.round(d30 * 3.4), d180: Math.round(d30 * 7.2), orders30: new Set(lines.map((l) => l.order_id)).size, cancelled30: 1, cancelled30_amount: 47990, statuses30: { paid: new Set(lines.map((l) => l.order_id)).size, cancelled: 1 }, months: null },
    seller: {
      id: 123456789,
      nickname: 'TIENDA.EJEMPLO',
      reputation: { level_id: '4_light_green', power_seller_status: 'silver', transactions: 2140 },
    },
    prevReputation: '5_green',
    items,
    lines,
    costs,
    settings: { ads_manual_monthly: 120000, meta_ads_monthly: 80000, alert_email: 'vos@tutienda.com.ar', alerts_enabled: true, weekly_enabled: true },
    productAds: null,
    plans: DEMO_AI_PLANS,
    summary: null,
    syncedAt: new Date(now - 25 * 60000).toISOString(),
  };
}

// Planes "escritos por la IA" para algunas publicaciones del demo (el resto usa las reglas).
const DEMO_AI_PLANS = {
  MLA1460211017: {
    verdict: 'mejorar', source: 'ia',
    headline: 'Te miran un montón pero sos 23 % más caro que el resto y no das cuotas.',
    actions: [
      { title: 'Respondé las 4 preguntas hoy', detail: 'Son compradores calientes en un producto de $190.000. Respondé en menos de 1 hora, con medidas y peso máximo.', impact: 'alto' },
      { title: 'Pasala a Premium para dar cuotas sin interés', detail: 'En un ticket de este nivel, sin cuotas la mayoría ni lo considera. Con tu costo de $98.000 el margen lo banca.', impact: 'alto' },
      { title: 'Bajá a la zona de $165.000', detail: 'La mediana de la competencia es $155.000. No hace falta ser el más barato, pero 23 % arriba es mucho.', impact: 'alto' },
      { title: 'Primera foto con la silla reclinada', detail: 'Mostrá el apoya pies abierto: es el diferencial y hoy no se ve.', impact: 'medio' },
    ],
  },
  MLA1460211007: {
    verdict: 'mejorar', source: 'ia',
    headline: 'Es tu producto que más factura y cada venta te hace perder plata.',
    actions: [
      { title: 'Subí el precio al mínimo sin pérdida', detail: 'Con comisión Premium, cuotas, envío y retenciones, abajo del precio mínimo perdés en cada venta. Ajustalo ya.', impact: 'alto' },
      { title: 'Actualizá el costo con la próxima compra', detail: 'Reponerla te cuesta $72.000: el precio tiene que contemplar eso, no lo que pagaste antes.', impact: 'alto' },
      { title: 'Probá Clásica en una segunda publicación', detail: 'Te ahorrás el costo de cuotas. Medí cuál vende y deja más.', impact: 'medio' },
    ],
  },
  MLA1460211014: {
    verdict: 'liquidar', source: 'ia',
    headline: 'Este producto no tiene salida: liquidalo o pausalo.',
    actions: [
      { title: 'Liquidá las 70 unidades', detail: 'Hay 120 competidores y la mediana está en $8.900: tu precio de $14.999 no tiene chance. Bajalo cerca de tu costo para recuperar la plata.', impact: 'alto' },
      { title: 'No repongas', detail: '5 visitas en 30 días y cero ventas en 90 días, con la ficha bien armada. El problema no es la publicación, es el producto.', impact: 'medio' },
    ],
  },
  MLA1460211011: {
    verdict: 'mejorar', source: 'ia',
    headline: 'Nadie la encuentra: título de 13 letras y publicación gratuita.',
    actions: [
      { title: 'Reescribí el título', detail: 'Ej.: "Funda Silicona Para Samsung A15 Antigolpe Con Felpa Interior". Marca y modelo son lo que la gente busca.', impact: 'alto' },
      { title: 'Pasala a Clásica', detail: 'Las gratuitas casi no aparecen en las búsquedas.', impact: 'alto' },
      { title: 'Subí 4 fotos más', detail: 'Tiene 2. Mostrá la funda puesta, los bordes y el interior.', impact: 'medio' },
      { title: 'Completá la ficha técnica', detail: 'Mercado Libre te marca 3 mejoras pendientes: suben la calidad de 48 a más de 70.', impact: 'medio' },
    ],
  },
  MLA1460211023: {
    verdict: 'mejorar', source: 'ia',
    headline: 'Tu balanza vendía 18 por mes y está parada por falta de stock.',
    actions: [
      { title: 'Reponé ya', detail: 'Vendió 54 en 90 días. Cada semana sin stock son ~4 ventas que se van a la competencia.', impact: 'alto' },
      { title: 'Ajustá el precio cuando vuelva', detail: 'El costo de reposición subió a $4.500: revisá que el margen siga.', impact: 'medio' },
    ],
  },
};

export const DEMO_SUMMARY_AI = null; // el demo arma el resumen con las mismas reglas que la cuenta real

// Usuarios de ejemplo para la vista previa del panel admin.
export const DEMO_ADMIN_USERS = [
  { id: 'u1', nickname: 'TIENDA.EJEMPLO', meli_user_id: 123456789, plan: 'rinde', created_at: '2026-10-03T14:10:00Z', plan_activated_at: '2026-10-04T10:00:00Z', free_diagnosis_used_at: '2026-10-03T14:20:00Z', last_login_at: '2026-11-02T12:30:00Z', alert_email: 'ventas@tiendaejemplo.com.ar', billing_status: 'active', payment_method: 'mp', plan_interval: 'monthly', plan_expires_at: '2026-12-01T13:10:00Z' },
  { id: 'u2', nickname: 'ELECTRO_SUR', meli_user_id: 223344556, plan: 'free', created_at: '2026-10-21T18:44:00Z', free_diagnosis_used_at: '2026-10-21T18:52:00Z', last_login_at: '2026-10-30T09:10:00Z', alert_email: null, billing_status: 'lapsed', payment_method: 'mp', plan_interval: 'monthly', plan_expires_at: '2026-10-25T00:00:00Z' },
  { id: 'u3', nickname: 'HOGAR-Y-DECO', meli_user_id: 334455667, plan: 'rinde', created_at: '2026-11-01T22:05:00Z', free_diagnosis_used_at: null, last_login_at: '2026-11-01T22:05:00Z', alert_email: 'hogarydeco@gmail.com', billing_status: 'trial', payment_method: 'mp', plan_interval: 'monthly', plan_expires_at: '2026-11-05T22:05:00Z' },
  { id: 'u4', nickname: 'MOTOPARTS.BA', meli_user_id: 445566778, plan: 'rinde', created_at: '2026-09-12T11:00:00Z', plan_activated_at: '2026-09-12T15:30:00Z', free_diagnosis_used_at: '2026-09-12T11:12:00Z', last_login_at: '2026-11-02T08:01:00Z', alert_email: 'motoparts@gmail.com', billing_status: 'past_due', payment_method: 'transfer', plan_interval: 'annual', plan_expires_at: '2026-10-30T23:59:00Z', grace_until: '2026-11-04T23:59:00Z' },
];
