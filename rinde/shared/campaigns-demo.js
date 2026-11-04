// Campañas y publicidad de EJEMPLO para /demo y las pruebas. Datos ficticios con todos los casos:
// 1) campaña que conviene (baja de umbral y deja de pagar envío), 2) co-fondeada con boost que conviene,
// 3) descuento que la baja de umbral y pierde plata, 4) publicidad con ACOS mayor al margen, 5) sin costo cargado.
export function getCampaignsDemo() {
  const offers = [
    { item_id: 'MLA1460211019', type: 'DEAL', name: 'Ofertas de la semana', status: 'candidate', price_today: 34999, promo_price: 32499,
      item: { title: 'Mochila Antirrobo Notebook 15.6 Puerto USB Impermeable', listing_type: 'gold_special', offersFreeShipping: false, shipCost: 7900, cost: 21000 } },
    { item_id: 'MLA1460211008', type: 'SMART', name: 'Campaña co-fondeada con boost (MeLi pone el descuento)', status: 'candidate', price_today: 32999, promo_price: 28049, original_price: 32999, meli_percentage: 15, seller_percentage: 0,
      item: { title: 'Smartwatch Reloj Inteligente Deportivo Notificaciones Malla Silicona', listing_type: 'gold_special', offersFreeShipping: true, shipCost: 4200, cost: 19500 } },
    { item_id: 'MLA1460211021', type: 'LIGHTNING', name: 'Oferta relámpago', status: 'candidate', price_today: 36999, promo_price: 32499,
      item: { title: 'Cámara Seguridad Wifi Interior 360 Visión Nocturna Audio', listing_type: 'gold_pro', offersFreeShipping: true, shipCost: 7900, cost: 22500 } },
    { item_id: 'MLA1460211002', type: 'DOD', name: 'Oferta del día', status: 'candidate', price_today: 12499, promo_price: 11999,
      item: { title: 'Soporte Celular Moto Bici Aluminio Rotación 360 Impermeable', listing_type: 'gold_special', offersFreeShipping: true, shipCost: 4200, cost: 3900 } },
    { item_id: 'MLA1460211005', type: 'SELLER_CAMPAIGN', name: 'Tu campaña: Cyber', status: 'started', price_today: 8999, promo_price: 7999,
      item: { title: 'Organizador De Cables Escritorio Kit 30 Piezas Velcro Silicona', listing_type: 'gold_special', offersFreeShipping: true, shipCost: 4200, cost: null } },
  ];
  const ads = [
    { item_id: 'MLA1460211017', campaign: 'Campaña Hogar', cost: 150000, direct_amount: 189999 * 2, indirect_amount: 189999, direct_units: 2, indirect_units: 1, clicks: 1840,
      item: { title: 'Silla Gamer Ergonómica Reclinable Con Apoya Pies Almohadones', price: 189999, listing_type: 'gold_special', offersFreeShipping: true, shipCost: 9800, cost: 112000 } },
    { item_id: 'MLA1460211001', campaign: 'Campaña Audio', cost: 21000, direct_amount: 24999 * 14, indirect_amount: 24999 * 6, direct_units: 14, indirect_units: 6, clicks: 2310,
      item: { title: 'Auriculares Bluetooth In Ear Inalámbricos Cancelación De Ruido TWS', price: 24999, listing_type: 'gold_pro', offersFreeShipping: true, shipCost: 4200, cost: 9800 } },
    { item_id: 'MLA1460211006', campaign: 'Campaña Audio', cost: 30000, direct_amount: 15999 * 6, indirect_amount: 15999 * 2, direct_units: 6, indirect_units: 2, clicks: 1210,
      item: { title: 'Cargador Rápido 33W USB-C Carga Turbo Compatible Samsung Motorola', price: 15999, listing_type: 'gold_pro', offersFreeShipping: true, shipCost: 4200, cost: 5200 } },
    { item_id: 'MLA1460211018', campaign: 'Campaña Audio', cost: 6000, direct_amount: 39999, indirect_amount: 0, direct_units: 1, indirect_units: 0, clicks: 640,
      item: { title: 'Parlante Bluetooth Portátil Resistente Al Agua 20W Graves', price: 39999, listing_type: 'gold_special', offersFreeShipping: true, shipCost: 7900, cost: null } },
  ];
  for (const x of [...offers, ...ads]) x.item.sku = x.item.sku || x.item_id;
  return { offers, ads, taxRate: 0.035, source: 'demo' };
}
