import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyCustomerPlan, customerCandidates } from '../lib/weekly-customer-plan.mjs';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { buildSimulationReport } from '../lib/stock-simulation-report.mjs';
import { finalScheduleView, scheduleCells } from '../lib/stock-schedule-view.mjs';
import { replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { fixture } from './helpers/rolling-fixture.mjs';
const today = '2026-11-19';
const dealer = slug => ({ slug, name: slug, own: true, target: 20, travelDays: 0, yard: { stock: 0 }, transit: { stock: 0 }, vehicles: [], handover: { months: [], avgStock: 0, thisMonth: { stock: 0 } } });
const row = (chassis, extra = {}) => ({ chassis, customer: 'Stock', model: 'SRC21', modelYear: '2027', dealer: 'a', signedAt: today, group: 'locked', auEnd: '2027-03-15', ...extra });

test('weekly quotas use cumulative whole-unit rounding and interleave customer places without converting empty places to Stock', () => {
  const slots = ['2027-03-15', '2027-03-16', '2027-03-17', '2027-03-18', '2027-03-19', '2027-03-22', '2027-03-23', '2027-03-24', '2027-03-25', '2027-03-26'].flatMap(d => [d, d]);
  const mix = weeklyCustomerPlan({ slots, percent: 50 });
  assert.deepEqual(mix.weeks.map(w => [w.slots, w.customerSlots, w.stockSlots, w.waiting]), [[10, 5, 5, 5], [10, 5, 5, 5]]);
  assert.equal(mix.stockSlots.length, 10); assert.equal(mix.rows.length, 10);
  assert.ok(mix.rows.every(r => r.kind === 'customer-gap' && !r.chassis));
  assert.deepEqual(mix.rows.map(r => r.slotOrder), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  const rounded = weeklyCustomerPlan({ slots, percent: 35 });
  assert.equal(rounded.weeks.reduce((n, w) => n + w.customerSlots, 0), 7);
  for (const percent of [-1, 101, NaN, '35', null]) assert.throws(() => weeklyCustomerPlan({ slots, percent }));
});

test('only signed, unique Towable customers in locked / pool queues enter the customer mix and readiness dates gate placement', () => {
  const rows = [row('LOCKED', { customer: 'Alice' }), row('POOL', { customer: 'Bob', group: 'customers', auEnd: '' }),
    row('UNSIGNED', { customer: 'Unsigned', signedAt: '' }), row('MH', { customer: 'Motorhome', model: 'SRM22.1' }), row('STOCK'),
    row('DUP', { customer: 'Duplicate' }), row('DUP', { customer: 'Duplicate' }), row('FIXED', { customer: 'Physical', group: 'cn' }),
    row('EXCLUDED', { customer: 'Excluded', dealer: 'MotorHub' }), row('FUTURE', { customer: 'Later', group: 'customers', requestDate: '2027-04-01' })];
  const candidates = customerCandidates({ rows, dealers: [dealer('a')], today });
  assert.deepEqual(candidates.map(r => r.chassis), ['LOCKED', 'FUTURE', 'POOL']);
  const mix = weeklyCustomerPlan({ slots: Array(3).fill('2027-03-15'), candidates, percent: 100 });
  assert.deepEqual(mix.rows.map(r => r.chassis), ['LOCKED', 'POOL', '']);
  assert.equal(mix.rows[2].kind, 'customer-gap'); assert.equal(mix.unplanned[0].chassis, 'FUTURE');
});

test('customer shortfalls remain empty when Stock is available, and an arriving customer fills the reserved place without taking a Stock place', () => {
  const slots = Array(8).fill('2027-03-15'), empty = weeklyCustomerPlan({ slots, percent: 50 });
  const candidates = customerCandidates({ rows: [row('CUSTOMER', { customer: 'New customer', group: 'customers' })], dealers: [dealer('a')], today });
  const filled = weeklyCustomerPlan({ slots, percent: 50, candidates });
  assert.deepEqual(filled.stockPlaces, empty.stockPlaces); assert.equal(filled.rows.filter(r => r.kind === 'customer').length, 1);
  assert.equal(filled.rows.filter(r => r.kind === 'customer-gap').length, 3);
  assert.equal(filled.rows[0].slotId, empty.rows[0].slotId);
});

test('zero and full customer percentages preserve orders and do not turn customer gaps into cancellation or Stock slots', () => {
  const slots = Array(4).fill('2027-03-15');
  assert.equal(weeklyCustomerPlan({ slots, percent: 0 }).stockSlots.length, 4);
  assert.equal(weeklyCustomerPlan({ slots, percent: 100 }).stockSlots.length, 0);
  const report = buildStockSimulation({ dealers: [dealer('a')], today, rows: [row('STOCK')], displayModels: ['SRC21'], capacity: new Map([['2027-03-15', { towable: 4, srm: 0, srv: 0 }]]), assumptions: { customerPercent: 100 } });
  assert.equal(report.totals.canceled, 0); assert.equal(report.own.actions[0].action, 'pool');
  assert.equal(report.finalSchedule.customerRows.length, 4); assert.ok(report.finalSchedule.customerRows.every(a => a.kind === 'customer-gap'));
});

test('customer identities appear only in the chronological schedule; Stock metrics and Dealer report rows remain Stock-only', () => {
  const capacity = new Map([['2027-03-15', { towable: 4, srm: 0, srv: 0 }], ['2027-03-16', { towable: 4, srm: 0, srv: 0 }]]);
  const stock = [row('S1'), row('S2')], customer = row('C1', { customer: 'Customer identity', group: 'customers' });
  const base = buildStockSimulation({ today, rows: stock, dealers: [dealer('a')], capacity, assumptions: { customerPercent: 50 } });
  const report = buildStockSimulation({ today, rows: [...stock, customer], dealers: [dealer('a')], capacity, assumptions: { customerPercent: 50 } });
  assert.deepEqual(report.own.actions, base.own.actions); assert.deepEqual(report.own.dealers, base.own.dealers);
  assert.ok(!JSON.stringify(report.own).includes('Customer identity'));
  const model = buildSimulationReport(report); assert.ok(!model.dealers.some(d => JSON.stringify(d).includes('Customer identity')));
  const plan = finalScheduleView(report); assert.equal(plan.customers, 1); assert.equal(plan.waiting, 3); assert.equal(plan.stock, 2);
  assert.equal(scheduleCells(plan.rows.find(r => r.kind === 'customer'))[6], 'Customer identity');
  assert.equal(new Set(plan.rows.map(r => r.slotId || r.chassis)).size, plan.rows.length);
  assert.ok(plan.rows.every((r, i) => !i || r.auFinish >= plan.rows[i - 1].auFinish));
});

test('locked customer dates replay at their reviewed quota places without changing Dealer ownership or commercial orders', () => {
  const capacity = new Map([['2027-03-15', { towable: 2, srm: 0, srv: 0 }], ['2027-03-16', { towable: 2, srm: 0, srv: 0 }]]);
  const rows = [row('S1'), row('S2'), row('C1', { customer: 'Alice' })], before = structuredClone(rows);
  const report = buildStockSimulation({ today, rows, dealers: [dealer('a')], capacity, assumptions: { customerPercent: 50 } });
  const planned = report.finalSchedule.customerRows.find(a => a.chassis === 'C1');
  const applied = replayInventoryBasis({ line: { today, rows }, report, capacity, dealers: [dealer('a')] });
  assert.equal(applied.line.rows.find(r => r.chassis === 'C1').auEnd, planned.plannedAu);
  assert.equal(applied.line.rows.find(r => r.chassis === 'C1').dealer, 'a'); assert.deepEqual(rows, before);
  for (const [k, n] of applied.used) assert.ok(n <= capacity.get(k.slice(0, 10)).towable);
});

test('customer percentage persists in saved assumptions and is bound to preview tokens', async () => {
  const f = fixture({ customerCount: 4, stockCount: 3 }), store = createStore(createMemoryFirebase());
  await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const app = createApp({ store, auth: { user: () => ({ name: 'Planner' }) }, env: {}, productionSource: { current: async () => f.sources } });
  const post = (path, body) => app.request(path, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await (await app.request('/api/stock-forecast')).json(); assert.equal(first.assumptions.customerPercent, 35);
  const preview = await post('/api/stock-forecast/simulate', { assumptions: { ...first.assumptions, customerPercent: 60 } }); assert.equal(preview.status, 200);
  const report = await preview.json(); assert.notEqual(report.previewToken, first.previewToken);
  const body = { assumptions: report.assumptions, multiplier: report.multiplier, months: report.months, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId };
  assert.equal((await post('/api/stock-forecast/save', { ...body, assumptions: { ...body.assumptions, customerPercent: 10 } })).status, 409);
  assert.equal((await post('/api/stock-forecast/save', body)).status, 200);
  assert.equal((await (await app.request('/api/stock-forecast')).json()).assumptions.customerPercent, 60);
  assert.equal((await post('/api/stock-forecast/simulate', { assumptions: { customerPercent: 101 } })).status, 400);
});
