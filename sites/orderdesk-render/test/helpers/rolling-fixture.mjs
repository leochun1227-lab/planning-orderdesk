import { buildProductionLine } from '../../lib/production-line.mjs';
import { buildStockForecast, DISPLAY_MODELS } from '../../lib/stock-forecast.mjs';
import { configureDealers, dealerSnapshot } from '../../lib/dealership.mjs';
import { stockInputFingerprint, saveStockOpinion } from '../../lib/stock-rolling.mjs';
import { confirmStockAdjustments } from '../../lib/stock-plan-confirmation.mjs';
import { dayInSydney } from '../../lib/order-engine.mjs';
import { weekOf } from '../../lib/balanced-rolling.mjs';
export const today = dayInSydney(), plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const row = (chassis, extra = {}) => ({ id: chassis, chassis, model: 'SRC21', modelYear: '2027', line: 'Towable', customer: 'Stock', dealer: 'Frankston', group: 'customers', signedAt: today, cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });
export function fixture({ customerCount = 40, stockCount = 60, overstock = false, weeks = 4, extraRows = [], orders = {} } = {}) {
  const raw = { yard: {}, dealerConfigs: { abco: { name: 'ABCO', isActive: true }, unknown: { name: 'Unknown Independent', isActive: true } } };
  const dealers = configureDealers(dealerSnapshot(raw, today, { all: true, towableOnly: true }), { abco: { target: 15, travelDays: 7 } }, today);
  if (overstock) for (const d of dealers) if (d.target) d.yard.stock = 1000;
  const rows = [...Array.from({ length: stockCount }, (_, i) => row(`SRC99${String(i).padStart(4, '0')}`, { model: DISPLAY_MODELS[i % DISPLAY_MODELS.length], dealer: ['Frankston', 'Geelong', 'Bundaberg', 'ABCO'][i % 4] })),
    ...Array.from({ length: customerCount }, (_, i) => row(`SRC98${String(i).padStart(4, '0')}`, { customer: `Customer ${i}`, orderRow: i + 1 })), ...extraRows];
  const lead = plus(today, 110), monday = weekOf(lead), first = monday < lead ? plus(monday, 7) : monday;
  const capacity = new Map([[today, { towable: 4, srm: 1, srv: 1 }]]);
  for (let week = 0; week < weeks; week++) for (let d = 0; d < 5; d++) capacity.set(plus(first, week * 7 + d), { towable: 4, srm: 1, srv: 1 });
  const sources = { board: { rows, completed: 0, averages: {} }, longtree: new Map(), prod: new Map(), portal: new Map(), dealers, forecastDealers: dealers, auCapacity: capacity, settings: { cnDays: 20, seaDays: 50, auDays: 40 }, status: {} };
  const line = buildProductionLine({ ...sources, today, orders });
  const fingerprint = stockInputFingerprint({ line, dealers, capacity, settings: sources.settings, orders });
  const report = buildStockForecast({ dealers, rows: line.rows, today });
  const plan = saveStockOpinion({ report, fingerprint, actor: 'Test' });
  plan.confirmation = confirmStockAdjustments({ plan, fingerprint, actor: 'Test' });
  return { sources, rows, dealers, capacity, line, fingerprint, report, plan, input: { plan, fingerprint, line, dealers, capacity, settings: sources.settings, orders, quantity: 40 } };
}

