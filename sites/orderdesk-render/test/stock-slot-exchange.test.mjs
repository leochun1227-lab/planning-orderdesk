import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { stockProductionPlan } from '../lib/stock-production-plan.mjs';
import { replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';
import { stockAdjustmentReport, stockAdjustmentActions } from '../lib/stock-plan-confirmation.mjs';
import { buildSimulationReport } from '../lib/stock-simulation-report.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { loadRollingPlan } from '../lib/production-line.mjs';
import { fixture as apiSources, row as apiRow } from './helpers/rolling-fixture.mjs';
import { isCancellationProtected } from '../lib/protected-stock.mjs';
const today = '2026-11-19';
const dealer = (slug, extra = {}) => ({ slug, name: slug, own: true, target: 10, travelDays: 3, yard: { stock: 0 }, transit: { stock: 0 }, vehicles: [], handover: { months: [], avgStock: 0, thisMonth: { stock: 0 } }, ...extra });
const row = (chassis, extra = {}) => ({ chassis, model: 'SRC21', modelYear: '2027', customer: 'Stock', dealer: 'a', group: 'locked', auEnd: '2027-01-13', signedAt: today, ...extra });
const capacity = () => new Map([['2027-01-13', { towable: 1, srm: 0, srv: 0 }], ['2027-02-12', { towable: 1, srm: 0, srv: 0 }]]);
const fixture = () => ({ today, dealers: [dealer('a', { yard: { stock: 1 }, vehicles: [{ chassis: 'YARD', where: 'yard', category: 'stock', model: 'SRC21', modelYear: '2027' }] }), dealer('b')],
  rows: [row('SRC000001'), row('SRC000002', { dealer: 'b', group: 'customers', auEnd: '' })], displayModels: ['SRC21'], capacity: capacity() });
const actions = report => ['own', 'jv', 'independent'].flatMap(g => report[g].actions);

test('an own-dealer pool order replaces a locked slot before a cross-dealer transfer; released orders are retained, not cancelled', () => {
  const input = fixture(), before = structuredClone(input);
  const old = buildStockSimulation({ ...input, assumptions: { exchangeSlots: false } });
  assert.equal(old.totals.reallocated, 1, 'balancing still transfers when own-pool exchanges are disabled');
  const report = buildStockSimulation(input), by = new Map(actions(report).map(a => [a.chassis, a]));
  assert.equal(report.totals.reallocated, 0); assert.equal(report.totals.canceled, 0);
  assert.equal(by.get('SRC000002').action, 'schedule'); assert.equal(by.get('SRC000002').from, 'b'); assert.equal(by.get('SRC000002').to, 'b');
  assert.equal(by.get('SRC000002').plannedAu, '2027-01-13'); assert.equal(by.get('SRC000001').slotReleased, true); assert.equal(by.get('SRC000001').action, 'pool');
  assert.equal(report.totals.scheduledFromPool, 1); assert.equal(report.totals.returnedToPool, 1);
  assert.deepEqual(input, before); assert.equal(report.auProduction.months[1].plannedStock, 0, 'later AU capacity is left for rolling production');
});

test('monthly AU quantity changes the exchanged finish and transport arrival month while preserving the total existing Stock places', () => {
  const input = fixture(), initial = buildStockSimulation(input);
  const report = buildStockSimulation({ ...input, assumptions: { auMonthlyProduction: { '2027-01': 0 } } });
  const a = actions(report).find(a => a.slotScheduled);
  assert.equal(a.plannedAu, '2027-02-12'); assert.equal(a.plannedArrival, '2027-02-18');
  assert.equal(report.totals.allocated, initial.totals.allocated); assert.equal(report.auProduction.months[0].total, 0);
  const b = report.own.dealers.find(d => d.slug === 'b'); assert.equal(b.monthly.find(m => m.month === '2027-02').stockIn, 1);
  assert.equal(b.my2027SrcSrpArrivals.months[1].src, 1);
});

test('an earlier monthly increase opens earlier Stock places without moving a physical van or changing its stage', () => {
  const input = fixture(); input.rows[0].auEnd = '2027-02-12';
  input.rows.push(row('PHYSICAL', { group: 'au', auEnd: '2027-01-13' }));
  const base = buildStockSimulation(input);
  const moved = buildStockSimulation({ ...input, assumptions: { auMonthlyProduction: { '2027-01': 2 } } });
  assert.equal(actions(base).find(a => a.slotScheduled).plannedAu, '2027-02-12');
  assert.equal(actions(moved).find(a => a.slotScheduled).plannedAu, '2027-01-13');
  const physical = actions(moved).find(a => a.chassis === 'PHYSICAL');
  assert.equal(physical.group, 'au'); assert.equal(physical.plannedAu, '2027-01-13');
  assert.equal(physical.slotScheduled, false);
  assert.doesNotThrow(() => replayInventoryBasis({ line: { today, rows: input.rows }, report: moved, capacity: input.capacity, dealers: input.dealers }));
});

test('physical stages and locked named customers reserve capacity; edited total cannot erase those commitments or motorhome capacity', () => {
  const rows = [row('FIXED', { group: 'sea' }), row('CLIENT', { customer: 'Alice', auEnd: '2027-01-14' })];
  const capacity = new Map([['2027-01-13', { towable: 2, srm: 1, srv: 0 }], ['2027-01-14', { towable: 2, srm: 0, srv: 1 }]]);
  const plan = stockProductionPlan({ rows, today, capacity, monthly: { '2027-01': 4 } });
  assert.equal(plan.months[0].minimum, 4); assert.equal(plan.slots.length, 0);
  assert.equal(plan.daily[0][1].srm, 1); assert.equal(plan.daily[1][1].srv, 1);
  assert.throws(() => stockProductionPlan({ rows, today, capacity, monthly: { '2027-01': 3 } }), /Minimum AU production/);
  for (const monthly of [[], { '2027-01': -1 }, { '2027-01': 1.2 }, { '2028-01': 9 }]) assert.throws(() => stockProductionPlan({ rows, today, capacity, monthly }));
});

test('unmatched-dealer locked Stock retains its original capacity reservation and cannot collide with a replacement', () => {
  const input = fixture(); input.capacity.get('2027-01-13').towable = 2;
  input.rows.push(row('UNMATCHED', { dealer: 'No matching dealer' }));
  const report = buildStockSimulation(input);
  assert.equal(report.auProduction.months[0].fixedTowable, 1);
  assert.ok(report.warnings.some(w => w.code === 'dealer'));
  const applied = replayInventoryBasis({ line: { today, rows: input.rows }, report, capacity: input.capacity, dealers: input.dealers });
  assert.equal(applied.line.rows.find(r => r.chassis === 'UNMATCHED').auEnd, '2027-01-13');
  assert.equal(applied.used.get('2027-01-13:towable'), 2);
});

test('Stock exchanges never admit unsigned, named-customer or physically started pool replacements', () => {
  const input = fixture(); input.rows[1].signedAt = '';
  input.rows.push(row('CUSTOMER', { dealer: 'b', group: 'customers', customer: 'Alice', auEnd: '' }), row('STARTED', { dealer: 'a', group: 'cn', auEnd: '2027-01-13' }));
  input.capacity.get('2027-01-13').towable = 2;
  const report = buildStockSimulation(input), list = actions(report);
  assert.ok(!list.some(a => a.chassis === 'CUSTOMER'));
  assert.equal(list.find(a => a.chassis === 'SRC000002').slotScheduled, undefined);
  assert.equal(list.find(a => a.chassis === 'STARTED').slotScheduled, false);
  assert.equal(list.find(a => a.chassis === 'STARTED').simulatedAu, '2027-01-13');
});

test('confirmed slot exchanges replay the exact membership and dates, maintain ownership and leave source rows unchanged', () => {
  const input = fixture(), report = buildStockSimulation({ ...input, assumptions: { auMonthlyProduction: { '2027-01': 0 } } });
  const confirmed = stockAdjustmentReport(report);
  assert.equal(stockAdjustmentActions(report).length, 2, 'pool admission and slot release both belong to the confirmed basis');
  assert.equal(actions(confirmed).length, 2);
  const source = structuredClone(input.rows), applied = replayInventoryBasis({ line: { rows: input.rows, today }, report: confirmed, capacity: input.capacity, dealers: input.dealers });
  const [released, admitted] = applied.line.rows;
  assert.equal(released.group, 'customers'); assert.equal(released.auEnd, ''); assert.equal(released.dealer, 'a');
  assert.equal(admitted.group, 'locked'); assert.equal(admitted.auEnd, '2027-02-12'); assert.equal(admitted.dealer, 'b');
  assert.equal(applied.replay.rollingBoundary, '2027-02-12'); assert.equal(applied.replay.cancelled, 0); assert.equal(applied.replay.reallocated, 0);
  assert.deepEqual(input.rows, source);
  const exported = buildSimulationReport(report); assert.ok(exported.dealers.find(d => d.slug === 'b').distribution.some(m => m.arrivals['2027-02'] === 1));
});

test('an explicit pool finish override gates eligibility; zero monthly capacity releases rather than cancels normal Stock', () => {
  const input = fixture();
  const gated = buildStockSimulation({ ...input, assumptions: { finishDates: { SRC000002: '2027-02-01' } } });
  assert.equal(actions(gated).find(a => a.chassis === 'SRC000002').slotScheduled, undefined);
  const zero = buildStockSimulation({ ...input, assumptions: { auMonthlyProduction: { '2027-01': 0, '2027-02': 0 } } });
  assert.equal(zero.totals.canceled, 0); assert.equal(zero.totals.returnedToPool, 1); assert.ok(actions(zero).every(a => a.action === 'pool'));
});

test('API preview, save and production-line apply retain the reviewed pool/locked swaps and monthly capacity; disabling restores sources', async () => {
  const lockedId = loadRollingPlan().rows.find(r => !isCancellationProtected(r.chassis)).chassis;
  const f = apiSources({ customerCount: 0, stockCount: 0, extraRows: [apiRow(lockedId, { group: 'locked' }), apiRow('SRC000002', { dealer: 'Geelong' })] });
  const a = f.dealers.find(d => d.slug === 'frankston'); a.yard.stock = 1;
  a.vehicles = [{ chassis: 'YARD', category: 'stock', where: 'yard', model: 'SRC21', modelYear: '2027' }];
  const store = createStore(createMemoryFirebase()); await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const app = createApp({ store, auth: { user: () => ({ name: 'Planner' }) }, env: {}, productionSource: { current: async () => f.sources } });
  const get = async path => { const res = await app.request(path); assert.equal(res.status, 200, await res.clone().text()); return res.json(); };
  const post = (path, body) => app.request(path, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const initial = await get('/api/stock-forecast'), assumptions = structuredClone(initial.assumptions);
  for (const s of assumptions.dealers) { s.receiving = ['frankston', 'geelong'].includes(s.slug); s.models = ['SRC21']; }
  const next = initial.auProduction.months.at(-1); assumptions.auMonthlyProduction[next.month] = next.total + 1;
  const preview = await post('/api/stock-forecast/simulate', { assumptions, months: 8 }); assert.equal(preview.status, 200, await preview.clone().text());
  const report = await preview.json(), list = actions(report); assert.equal(report.totals.scheduledFromPool, 1); assert.equal(report.totals.reallocated, 0);
  const payload = { assumptions: report.assumptions, months: report.months, multiplier: report.multiplier, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId };
  const tampered = structuredClone(payload); tampered.assumptions.auMonthlyProduction[next.month]++;
  assert.equal((await post('/api/stock-forecast/save', tampered)).status, 409);
  assert.equal((await post('/api/stock-forecast/save', payload)).status, 200);
  const saved = await get('/api/stock-forecast'); assert.equal(saved.savedCurrent, true); assert.equal(saved.assumptions.auMonthlyProduction[next.month], next.total + 1);
  const before = await get('/api/production-line');
  const apply = async enabled => { const ctx = (await get('/api/production-line')).stockAdjustments; const res = await post('/api/production-line/stock-adjustments', { enabled, expectedId: ctx.id, inputToken: ctx.inputToken, planId: ctx.planId }); assert.equal(res.status, 200, await res.clone().text()); };
  await apply(true); const applied = await get('/api/production-line');
  const admission = list.find(a => a.group === 'customers' && a.slotScheduled);
  assert.equal(applied.rows.find(r => r.chassis === admission.chassis).group, 'locked');
  assert.equal(applied.rows.find(r => r.chassis === admission.chassis).auEnd, admission.plannedAu);
  assert.equal(applied.rows.find(r => r.chassis === lockedId).group, 'customers');
  assert.deepEqual((await store.readState()).state.orders, {}, 'applying a simulation never cancels or rewrites commercial orders');
  await apply(false); const restored = await get('/api/production-line');
  assert.deepEqual(restored.rows.map(r => [r.chassis, r.group, r.auEnd, r.dealer]), before.rows.map(r => [r.chassis, r.group, r.auEnd, r.dealer]));
});
