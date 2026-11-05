import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecastResolver, reconcileSchedule, recomputeCalendar, scheduleView } from '../lib/schedule.mjs';
import { alertFor, excelCells, dueUnsigned, dealerColor, requestMismatch } from '../lib/schedule-colors.mjs';
const calendar = JSON.parse(readFileSync(new URL('./fixtures/calendar.json', import.meta.url)));
const expected = JSON.parse(readFileSync(new URL('./fixtures/orderlist-forecast.json', import.meta.url)));

test('forecast dates equal Planning Schedule (4) column A for all 8,947 rows', () => {
  const f = forecastResolver(calendar);
  const bad = expected.map((a, i) => [i + 2, a, f(i + 2)]).filter(([, a, b]) => a !== b);
  assert.deepEqual(bad, []);
});

test('recomputing the calendar reproduces Excel J and L from row 64 on', () => {
  const again = recomputeCalendar(calendar);
  const diff = again.weeks.filter((w, i) => w.row >= 64 && (w.start ?? null) !== (calendar.weeks[i].start ?? null));
  assert.deepEqual(diff.map(w => w.row), []);
});

const base = () => ({
  calendar,
  schedule: { rows: [{ chassis: 'SRC1', dealer: 'Geelong' }, { chassis: null, dealer: 'Forest Glen' }, { chassis: null, dealer: 'Geelong' }, { chassis: null, dealer: 'Geelong' }], pending: [] },
  orders: { SRC1: { id: 'SRC1', chassis: 'SRC-1', dealer: 'Geelong', status: 'active' } }, events: {},
});

test('new order takes its dealer\'s earliest empty slot and gets that row\'s forecast date', () => {
  const prev = base();
  const next = { ...prev, orders: { ...prev.orders, SRC2: { id: 'SRC2', chassis: 'SRC-2', dealer: 'Geelong', status: 'active', receivedAt: '2026-11-05' } } };
  const out = reconcileSchedule(prev, next, { now: '2026-11-05T00:20:00Z' });
  assert.equal(out.schedule.rows[2].chassis, 'SRC2');
  assert.equal(out.schedule.rows[3].chassis, null);
  assert.equal(out.orders.SRC2.slotRow, 4);
  assert.equal(out.orders.SRC2.forecastDate, forecastResolver(calendar)(4));
  assert.ok(Object.values(out.events).some(e => e.scheduleAction === 'assigned'));
  // Idempotent: saving again changes nothing.
  assert.equal(reconcileSchedule(out, out), out);
});

test('dealer without an empty slot goes to pending; cancellation clears the row without shifting', () => {
  const prev = base();
  const next = { ...prev, orders: { ...prev.orders, SRC9: { id: 'SRC9', chassis: 'SRC-9', dealer: 'Snowy Stock', status: 'active' } } };
  const out = reconcileSchedule(prev, next);
  assert.deepEqual(out.schedule.pending, ['SRC9']);
  const cancelled = { ...out, orders: { ...out.orders, SRC1: { ...out.orders.SRC1, status: 'cancelled', cancelledAt: '2026-11-05' } } };
  const after = reconcileSchedule(out, cancelled);
  assert.deepEqual(after.schedule.rows.map(r => r.chassis), [null, null, null, null]);
  assert.deepEqual(after.schedule.rows.map(r => r.dealer), ['Geelong', 'Forest Glen', 'Geelong', 'Geelong']);
  // The freed Geelong row is now the earliest Geelong slot.
  const again = reconcileSchedule(after, { ...after, orders: { ...after.orders, SRC3: { id: 'SRC3', chassis: 'SRC-3', dealer: 'Geelong', status: 'active' } } });
  assert.equal(again.schedule.rows[0].chassis, 'SRC3');
});

test('column A colours follow the Excel rule order', () => {
  const today = '2026-11-05';
  const order = o => excelCells({ forecastDate: '2027-01-11', order: { receivedAt: '2026-10-01', sentLongtreeAt: '2026-10-01', customer: 'Jane Doe', requestDate: '2027-02-01', ...o } });
  assert.equal(alertFor(excelCells({ forecastDate: '2027-01-11', order: null }), today), 'red');            // empty slot soon
  assert.equal(alertFor(excelCells({ forecastDate: '2027-09-06', order: null }), today), null);              // empty slot far away
  assert.equal(alertFor(order({}), today), 'yellow');                                                         // plans not sent
  assert.equal(alertFor(order({ specAt: '2026-10-02' }), today), 'lightBlue');                                // waiting signature
  assert.equal(alertFor(order({ specAt: '2026-10-02', signedAt: '2026-10-05', purchaseAt: '2026-10-05' }), today), null);
  assert.equal(alertFor(order({ specAt: '2026-10-02', signedAt: '2026-10-05', requestDate: 'ASAP' }), today), 'greyNoRequest');
  assert.equal(alertFor(order({ specAt: '2026-10-02', signedAt: '2026-10-05', customer: 'Stock' }), today), 'grey');
  assert.ok(dueUnsigned(order({}), today));
  assert.ok(!dueUnsigned(order({ requestDate: 'ASAP' }), today));
  assert.ok(requestMismatch({ ...order({}), D: 'Production Commenced Longtree', B: '2027-04-01' }));
  assert.deepEqual(dealerColor('auswide'), { background: '#FFFF00', color: '#000' });
});

test('schedule view lists every row with its forecast date', () => {
  const v = scheduleView(base());
  assert.equal(v.length, 4); assert.equal(v[0].order.id, 'SRC1'); assert.equal(v[1].order, null); assert.equal(v[1].excelRow, 3);
});

test('campervan prefixes are not created as caravan orders (Campervan Schedule)', async () => {
  const { applyReport } = await import('../lib/order-engine.mjs');
  const state = { orders: {}, events: {}, imports: {}, meta: {}, refs: { dealers: { '1': 'Geelong' }, dealerNames: [], excluded: [], excludedPrefixes: ['SRV', 'SRM'] } };
  const rec = chassis => ({ chassis, quoteStatus: 'BUYER ORDERED', description: '2027 SRC16', dealerCode: '1', customer: 'A Person', expectedDate: 'ASAP', sourceRow: 14 });
  const r = applyReport(state, [rec('SRM266702'), rec('SRV266624'), rec('SRC266999')], { batchId: 'b', fileName: 'f', businessDate: '2026-11-05', reportDate: '2026-11-05', now: '2026-11-05T00:20:00Z' });
  assert.deepEqual(Object.keys(r.state.orders), ['SRC266999']);
});

test('a manually kept customer is not overwritten by CRM, but the CRM text is still recorded', async () => {
  const { applyReport } = await import('../lib/order-engine.mjs');
  const state = { orders: { SRH263605: { id: 'SRH263605', chassis: 'SRH-263605', dealer: 'Frankston', customer: 'Robert Raymer', customerManual: true, status: 'active', specAt: null, signedAt: null, purchaseAt: null } }, events: {}, imports: {}, meta: {}, refs: { dealers: {}, dealerNames: [], excluded: [] } };
  const r = applyReport(state, [{ chassis: 'SRH263605', quoteStatus: 'FACTORY DRAWN', description: '2026 SRH16', dealerCode: '1', customer: 'REGENT RV - FRANKSTON', expectedDate: 'ASAP', sourceRow: 14 }], { batchId: 'b', fileName: 'f', businessDate: '2026-11-05', reportDate: '2026-11-05', now: '2026-11-05T00:20:00Z' });
  assert.equal(r.state.orders.SRH263605.customer, 'Robert Raymer');
  assert.equal(r.state.orders.SRH263605.crmCustomer, 'REGENT RV - FRANKSTON');
  assert.equal(r.state.orders.SRH263605.specAt, '2026-11-05');
});

test('campervans never take Orderlist slots or go to pending', () => {
  const prev = base();
  const next = { ...prev, orders: { ...prev.orders, SRM266702: { id: 'SRM266702', chassis: 'SRM-266702', dealer: 'Geelong', status: 'active' } } };
  const out = reconcileSchedule(prev, next);
  assert.equal(out, next);
  assert.ok(out.schedule.rows.every(r => r.chassis !== 'SRM266702'));
});

test('campervan plan prefers the Portal saved schedule, falls back to campervanSchedule', async () => {
  const { buildCampervanPlan } = await import('../lib/campervan-plan.mjs');
  const plan = buildCampervanPlan(
    { orders: [{ id: 'o1', chassis: 'SRM263711', model: 'SRM22.1', dealer: 'Forest Glen', signedOffDate: '2026-03-10', productLine: 'SRM' }, { id: 'o2', chassis: 'SRM266702', model: 'SRM 25.1 - Fiat', signedOffDate: '2026-11-04' }],
      plans: { savedSchedule: { SRM: [{ orderId: 'o1', date: '2026-06-01', week: 1 }] } } },
    [{ chassisNumber: 'SRM263711', forecastProductionDate: '2026-06-05', regentProduction: '' }, { chassisNumber: 'SRV250001', forecastProductionDate: '2025-07-01', regentProduction: 'Finished' }]);
  assert.equal(plan.SRM263711.forecastDate, '2026-06-01'); assert.equal(plan.SRM263711.source, 'savedSchedule');
  assert.equal(plan.SRV250001.forecastDate, '2025-07-01'); assert.equal(plan.SRV250001.productionStatus, 'Finished');
  assert.equal(plan.SRM266702.forecastDate, null); assert.equal(plan.SRM266702.source, 'queue');
});

test('Portal board dates override the saved schedule for SRV/SRM', async () => {
  const { applyPortalBoard } = await import('../lib/campervan-plan.mjs');
  const plan = applyPortalBoard({ SRM263741: { forecastDate: '2026-11-02', source: 'savedSchedule' } },
    { rows: [{ chassis: 'SRM263741', auPlanStart: '2026-10-12', auStart: '2026-10-14', auActual: '2026-10-14', group: 'au', status: 'Production' }, { chassis: 'SRC264000', auPlanStart: '2026-01-01' }] });
  assert.equal(plan.SRM263741.forecastDate, '2026-10-12'); assert.equal(plan.SRM263741.actualStart, '2026-10-14'); assert.equal(plan.SRM263741.source, 'portal-board');
  assert.equal(plan.SRC264000, undefined);
});

test('the bundled Portal board code loads and runs on empty data', async () => {
  const { loadPortalBoard } = await import('../lib/campervan-plan.mjs');
  const m = await loadPortalBoard();
  const vehicles = m.boardVehiclesFromSources({}, '2026-11-05');
  assert.ok(Array.isArray(m.buildProductionBoard(vehicles, m.DEFAULT_BOARD_SETTINGS, '2026-11-05').rows));
});

test('model year follows the CRM only when the CRM value changes', async () => {
  const { applyReport } = await import('../lib/order-engine.mjs');
  const opts = d => ({ batchId: 'b' + d, fileName: 'f', businessDate: d, reportDate: d, now: d + 'T00:20:00Z' });
  const rec = desc => ({ chassis: 'SRC255901', quoteStatus: 'BUYER ORDERED', description: desc, dealerCode: '1', customer: 'Stock', expectedDate: 'ASAP', sourceRow: 14 });
  let state = { orders: { SRC255901: { id: 'SRC255901', chassis: 'SRC-255901', dealer: 'Slacks Creek', modelYear: '2026', model: 'SRC17', status: 'completed', specAt: '2023-01-01', signedAt: '2023-01-02', purchaseAt: '2023-01-02' } }, events: {}, imports: {}, meta: {}, refs: { dealers: {}, dealerNames: [], excluded: [] } };
  state = applyReport(state, [rec('2023 SRC17')], opts('2026-11-05')).state;          // first sighting: keep Planning's 2026
  assert.equal(state.orders.SRC255901.modelYear, '2026'); assert.equal(state.orders.SRC255901.crmModelYear, '2023');
  state = applyReport(state, [rec('2023 SRC17')], opts('2026-11-06')).state;          // unchanged CRM: still 2026
  assert.equal(state.orders.SRC255901.modelYear, '2026');
  const r = applyReport(state, [rec('2027 SRC17')], opts('2026-11-07'));              // CRM changes: CRM wins
  assert.equal(r.state.orders.SRC255901.modelYear, '2027');
  assert.ok(Object.values(r.state.events).some(e => e.changes.some(c => c.field === 'modelYear' && c.after === '2027')));
});
