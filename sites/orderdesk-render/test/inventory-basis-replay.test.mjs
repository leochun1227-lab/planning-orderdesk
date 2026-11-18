import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, row, today, plus } from './helpers/rolling-fixture.mjs';
import { buildBalancedRolling } from '../lib/balanced-rolling.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { buildStockForecast } from '../lib/stock-forecast.mjs';
import { confirmStockAdjustments } from '../lib/stock-plan-confirmation.mjs';
import { availableRollingSlots } from '../lib/inventory-basis-replay.mjs';

const reconfirm = f => { f.plan.confirmation = confirmStockAdjustments({ plan: f.plan, fingerprint: f.fingerprint }); };
test('confirmed cancellation releases a real occupied day; delay and reallocation reserve later capacity and apply identically on display', () => {
  const f = fixture({ customerCount: 20, stockCount: 0, extraRows: Array.from({ length: 6 }, (_, i) => row(`SRC97FIX${i}`, { group: 'locked' })) });
  const fixed = f.line.rows.filter(r => r.group === 'locked'), cancel = fixed[4], delay = fixed[5];
  assert.ok(cancel.auEnd > today); assert.equal(cancel.auEnd, delay.auEnd);
  f.plan.report.own.actions = f.plan.report.own.actions.filter(a => !fixed.some(r => r.chassis === a.chassis));
  reconfirm(f);
  const before = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 100 });
  f.plan.report.own.actions.push(
    { chassis: cancel.chassis, group: 'locked', action: 'cancel', from: 'frankston', receive: false },
    { chassis: delay.chassis, group: 'locked', action: 'reallocate', delayed: true, reallocated: true, from: 'frankston', to: 'geelong', proposedDealer: 'Geelong', originalAu: delay.auEnd, plannedAu: plus(delay.auEnd, 7), receive: true, model: delay.model },
  );
  reconfirm(f);
  const p = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 100 });
  assert.equal(p.basisReplay.cancelled, 1); assert.equal(p.basisReplay.shifted, 1); assert.equal(p.basisReplay.reallocated, 1);
  assert.equal(before.schedule.filter(a => a.auEnd === cancel.auEnd).length, 2);
  assert.equal(p.schedule.filter(a => a.auEnd === cancel.auEnd).length, 4, 'both released places are actually reusable');
  const applied = buildProductionLine({ ...f.sources, today, orders: {}, rollingSchedule: p.schedule, inventoryBasis: f.plan.confirmation.report });
  assert.ok(!applied.rows.some(r => r.chassis === cancel.chassis));
  const moved = applied.rows.find(r => r.chassis === delay.chassis);
  assert.equal(moved.dealer, 'Geelong'); assert.ok(moved.auEnd >= plus(delay.auEnd, 7));
  for (const a of p.schedule) assert.equal(applied.rows.find(r => r.chassis === a.chassis).auEnd, a.auEnd);
  for (const [day, c] of f.capacity) assert.ok(applied.rows.filter(r => ['locked', 'rolling'].includes(r.group) && r.auEnd === day).length <= c.towable);
  assert.equal(applied.counts.locked, 5); assert.equal(applied.auForecast.overflow, 0);
  assert.ok(f.line.rows.some(r => r.chassis === cancel.chassis), 'original source orders remain intact');
});
test('remaining capacity preserves individual daily holes rather than discarding everything before the last sequence number', () => {
  const line = { rows: [{ group: 'locked', model: 'SRC21', auEnd: '2027-05-03', auForecast: { seq: 99 } }] };
  const capacity = new Map([['2027-05-01', { towable: 2 }], ['2027-05-03', { towable: 2 }]]);
  assert.deepEqual(availableRollingSlots(line, capacity, '2027-05-01', '2027-05-03'), ['2027-05-01', '2027-05-01', '2027-05-03']);
});
test('handover cover takes precedence over own-dealer Ideal deficits; quantity remains full and unknown history is disclosed', () => {
  const f = fixture({ customerCount: 0, stockCount: 40 });
  for (const d of f.dealers) { if (d.own) { d.yard.stock = 10; d.handover.avgStock = .1; } else d.handover.avgStock = 10; }
  f.plan.report = buildStockForecast({ dealers: f.dealers, rows: f.line.rows, today }); reconfirm(f);
  const p = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 0, maxStockMonths: 3 });
  assert.equal(p.scheduled, 4); assert.ok(p.schedule.every(a => a.group !== 'own'), 'do not top up a slow own dealer just because its Ideal ratio is low');
  const unknown = fixture({ customerCount: 0, stockCount: 10 });
  const q = buildBalancedRolling({ ...unknown.input, quantity: 4, customerPercent: 0 });
  assert.ok(q.report.coverExceptions.some(d => d.reason === 'noStockHandoverHistory'));
  assert.throws(() => buildBalancedRolling({ ...f.input, maxStockMonths: 0 }), /覆盖/);
});
test('arrival bar details reconcile to totals and retain distinct AU-finish and dealer-arrival dates', () => {
  const f = fixture({ extraRows: [row('SRC97FIX', { group: 'locked' })] });
  for (const g of ['own', 'jv', 'independent']) for (const d of f.report[g].dealers) for (const m of d.monthly) {
    if (m.stockIn != null) assert.equal(m.arrivals.length, m.stockIn);
    for (const a of m.arrivals) { assert.ok(a.arrival.startsWith(m.month)); if (a.auEnd) assert.ok(a.arrival >= a.auEnd); }
  }
  const p = buildBalancedRolling({ ...f.input, quantity: 4 });
  for (const d of p.stockResult.monthly) for (const m of d.months) assert.equal(m.basisIn, m.basisArrivals.length);
});

test('later working weeks are compared to reduce handover cover while preserving the exact real-order quantity', () => {
  const f = fixture({ customerCount: 0, stockCount: 40, weeks: 12 });
  for (const d of f.dealers) if (d.target) { d.yard.stock = 100; d.handover.avgStock = 10; }
  f.plan.report = buildStockForecast({ dealers: f.dealers, rows: f.line.rows, today }); reconfirm(f);
  const early = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 0, maxStockMonths: 24 });
  const balanced = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 0, maxStockMonths: 3 });
  assert.equal(balanced.scheduled, 4); assert.equal(balanced.customerCount, 0);
  assert.ok(balanced.schedule[0].auEnd >= plus(early.schedule[0].auEnd, 35));
  const cost = p => p.stockResult.inventory.filter(d => d.peakAfterReplenishment != null).reduce((n,d) => n + Math.max(0, d.peakAfterReplenishment / d.avgStock - 3) ** 2, 0);
  assert.ok(cost(balanced) < cost(early));
});
