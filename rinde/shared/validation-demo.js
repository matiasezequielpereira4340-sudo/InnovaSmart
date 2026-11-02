// Respuestas SIMULADAS de Mercado Libre para ver la pantalla de Validación sin una cuenta real.
// Incluye casos difíciles a propósito: venta sin facturar, error de la API, formato distinto y cargos sin clasificar.
import { getDemoData } from './demo-data.js';

export function getValidationDemoInput() {
  const d = getDemoData();
  const pick = ['MLA1460211007', 'MLA1460211001', 'MLA1460211009', 'MLA1460211002', 'MLA1460211008', 'MLA1460211017', 'MLA1460211004', 'MLA1460211021', 'MLA1460211006', 'MLA1460211010'];
  const now = Date.UTC(2026, 10, 2, 14, 0);
  const orders = [];
  const calls = {};
  pick.forEach((id, i) => {
    const it = d.items.find((x) => x.id === id);
    const oid = 2000009871230 + i * 7;
    const premium = it.listing_type === 'gold_pro';
    const gross = it.price;
    const cv = Math.round(gross * (premium ? 0.145 : 0.135) + (gross < 33000 ? 1150 : 0));
    const csi = premium ? Math.round(gross * 0.115) : 0;
    const env = gross >= 33000 ? 7900 + i * 130 : 4200;
    // la orden informa sale_fee; en dos ventas difiere de la facturación (promos / bonificaciones)
    const saleFee = i === 1 ? Math.round(cv * 0.9) : i === 5 ? Math.round(cv * 1.07) : cv;
    orders.push({
      id: oid,
      status: 'paid',
      date_created: new Date(now - i * 9 * 3600000).toISOString(),
      total_amount: gross,
      buyer: { id: 99000 + i, nickname: `COMPRADOR${i}`, email: 'oculto@ejemplo.com' },
      order_items: [{ item: { id, title: it.title, seller_sku: it.sku }, quantity: 1, unit_price: gross, sale_fee: saleFee }],
      payments: [{ id: 5500 + i, installments: premium ? 6 : 1, taxes_amount: i === 2 ? Math.round(gross * 0.03) : 0 }],
      shipping: { id: 4400000 + i },
    });
    const line = (type, sub, desc, amount) => ({ charge_info: { detail_id: 700 + i, detail_type: type, detail_sub_type: sub, transaction_detail: desc, detail_amount: amount, creation_date_time: '2026-11-01T10:00:00-03:00' }, sales_info: [{ order_id: oid, operation_id: 8800 + i, sale_date_time: '2026-11-01T09:00:00-03:00' }] });
    let billing;
    if (i === 3) billing = { status: 200, param: null, body: { results: [], paging: { total: 0 } } }; // todavía no facturada
    else if (i === 4) billing = { status: 404, param: null, body: { message: 'not_found', error: 'not_found', status: 404 } };
    else if (i === 6) billing = { status: 200, param: 'order_id', body: { data: [{ description: 'Cargo por venta', amount: cv }, { description: 'Costo de envío', amount: env }] } }; // formato distinto
    else {
      const results = [line('CHARGE', 'CV', 'Cargo por venta', cv), line('CHARGE', 'CXD', 'Costo de envío por Mercado Envíos', env)];
      if (csi) results.push(line('CHARGE', 'CSI', 'Costo por ofrecer cuotas sin interés', csi));
      if (i === 8) results.push(line('CHARGE', 'PADS', 'Cargo de Mercado Ads', 2300));
      if (i === 2) results.push(line('BONUS', 'BCV', 'Bonificación por campaña', 1500));
      billing = { status: 200, param: 'order_ids', body: { results, paging: { total: results.length, limit: 150 } } };
    }
    calls[oid] = { billing, shipment: { status: 200, body: { receiver: { cost: 0 }, senders: [{ user_id: 123456789, cost: env, compensation: 0 }] } } };
  });
  return { orders, calls, items: d.items, ordersCall: { status: 200 } };
}
