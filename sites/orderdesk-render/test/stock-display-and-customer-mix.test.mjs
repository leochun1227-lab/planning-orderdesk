import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyCustomerPlan } from '../lib/weekly-customer-plan.mjs';
import { mixCustomersWithStock } from '../lib/stock-customer-mix.mjs';
import { dealerDisplayWindow } from '../lib/my2027-display-window.mjs';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';

const today = '2026-11-19';
const dealer = slug => ({ slug, name: slug, own: true, target: 20, travelDays: 0, yard: { stock: 0 }, vehicles: [], transit: { stock: 0 }, handover: { months: [], avgStock: 0 } });
const order = (chassis, extra = {}) => ({ chassis, customer: 'Stock', model: 'SRC21', modelYear: '2027', dealer: 'a', group: 'locked', signedAt: today, auEnd: '2027-03-18', ...extra });
const dated = index => new Date(Date.UTC(2027, 2, 18 + index)).toISOString().slice(0, 10);

test('Stock changes over once across locked and pool Stock; a later signed MY2026 customer does not delay March MY2027 Stock', () => {
  const cap = new Map([[dated(0), { towable: 12 }], [dated(50), { towable: 10 }]]);
  const rows = [order('A1'), order('A2', { model: 'SRP19' }), order('A3'), order('OLD', { modelYear: '2026' }),
    order('LATE', { group: 'customers', auEnd: '', modelYear: '2026', customer: 'Named buyer', requestDate: dated(50) }),
    ...Array.from({ length: 6 }, (_, i) => order('POOL' + i, { group: 'customers', auEnd: '', model: 'SRP19' }))];
  const r = buildStockSimulation({ today, capacity: cap, dealers: [dealer('a'), dealer('b'), dealer('traralgon')], rows, assumptions: { customerPercent: 50 }, displayModels: ['SRC21', 'SRP19'] });
  const stocks = r.finalSchedule.rows.filter(a => a.kind === 'stock');
  assert.equal(stocks[0].modelYear, '2026');
  assert.equal(stocks[1].plannedAu, dated(0));
  assert.ok(stocks.slice(1).every(a => a.modelYear === '2027'));
  assert.equal(r.finalSchedule.customerRows.find(a => a.chassis === 'LATE').plannedAu, dated(50));
  assert.equal(r.own.dealers.find(d => d.slug === 'traralgon').displayWindow, null);
  assert.ok(r.own.dealers.some(d => d.displayWindow?.atEnd > 0));
  assert.equal(new Set(r.finalSchedule.rows.map(a => a.slotOrder)).size, r.finalSchedule.rows.length);
});

test('display coverage counts whole MY2027 units remaining on yard after sales, at each cutoff', () => {
  const window = dealerDisplayWindow({ slug: 'a', weeklyStock: 7, models: ['SRC21', 'SRP19'] }, [], { SRC21: 1 }, '2027-03-30');
  window.add({ model: 'SRC21', modelYear: '2027' }, '2027-03-30');
  window.add({ model: 'SRC21', modelYear: '2026' }, '2027-03-30', 2);
  window.add({ model: 'SRP19', modelYear: '2027' }, '2027-04-07');
  let r = window.report();
  assert.deepEqual([r.atStart, r.atEnd, r.inApril], [1, 1, 1]);
  assert.deepEqual(r.missing, ['SRC21']);
  assert.equal(window.gain({ model: 'SRP19', modelYear: '2027' }, '2027-04-26'), 0);
  window.add({ model: 'SRP19', modelYear: '2027' }, '2027-04-07', -1);
  assert.equal(window.report().atEnd, 0);
  assert.equal(window.gain({ model: 'SRP19', modelYear: '2027' }, '2027-04-26'), 1);
});

test('rolling daily 7- and 30-day shares use scheduled Stock even across calendar month boundaries', () => {
  const factory = weeklyCustomerPlan({ slots: Array.from({ length: 64 }, (_, i) => Array(10).fill(dated(i))).flat(), percent: 30 });
  const stock = factory.stockPlaces.filter((p, i) => p.day >= dated(10) && i % 3 !== 0).map(p => ({ plannedAu: p.day, slotOrder: p.slotOrder }));
  const candidates = Array.from({ length: 200 }, (_, i) => ({ chassis: 'C' + i, customer: 'Buyer', ready: today }));
  const plan = mixCustomersWithStock(factory, stock, candidates);
  assert.ok(plan.rows.every(r => r.plannedAu >= dated(10) && r.kind === 'customer'));
  for (const day of plan.rolling) for (const [length, window] of [[7, day.seven], [30, day.thirty]]) {
    const first = new Date(Date.parse(day.day) - (length - 1) * 86400000).toISOString().slice(0, 10);
    assert.equal(window.customers, plan.rows.filter(r => r.plannedAu >= first && r.plannedAu <= day.day).length);
    assert.equal(window.stock, stock.filter(r => r.plannedAu >= first && r.plannedAu <= day.day).length);
    assert.ok(Math.abs(window.customers - (window.stock + window.customers) * .3) < 1);
  }
  assert.equal(mixCustomersWithStock(factory, [], candidates).rows.length, 0);
  const sparse = mixCustomersWithStock(factory, stock, candidates.slice(0, 4));
  const actual = sparse.rows.filter(r => r.kind === 'customer');
  assert.equal(actual.length, 4);
  assert.ok(actual.at(-1).plannedAu >= dated(55));
  assert.equal(sparse.rows.length, Math.round(stock.length * 3 / 7));
  assert.equal(sparse.rows.filter(r => r.kind === 'customer-gap').length, sparse.rows.length - 4);
});
