import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, row, today, plus } from './helpers/rolling-fixture.mjs';
import { buildBalancedRolling } from '../lib/balanced-rolling.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { buildStockForecast } from '../lib/stock-forecast.mjs';
import { confirmStockAdjustments } from '../lib/stock-plan-confirmation.mjs';
import { availableRollingSlots, replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';

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
  assert.equal(p.schedule.filter(a => a.auEnd === cancel.auEnd).length, 0, 'rolling cannot use holes before the adjusted locked-line tail');
  assert.equal(p.schedule[0].auEnd, p.basisReplay.lastLocked);
  assert.equal(p.schedule.filter(a => a.auEnd === p.basisReplay.lastLocked).length, 3, 'use the three remaining places on the last locked day');
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

test('handover cover can change allocation but cannot move the continuous production window', () => {
  const f = fixture({ customerCount: 0, stockCount: 40, weeks: 12 });
  for (const d of f.dealers) if (d.target) { d.yard.stock = 100; d.handover.avgStock = 10; }
  f.plan.report = buildStockForecast({ dealers: f.dealers, rows: f.line.rows, today }); reconfirm(f);
  const early = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 0, maxStockMonths: 24 });
  const balanced = buildBalancedRolling({ ...f.input, quantity: 4, customerPercent: 0, maxStockMonths: 3 });
  assert.equal(balanced.scheduled, 4); assert.equal(balanced.customerCount, 0);
  assert.deepEqual(balanced.schedule.map(a => a.auEnd), early.schedule.map(a => a.auEnd));
  assert.ok(balanced.report.coverExceptions.length, 'report excess rather than moving the period');
});

test('cancellation repacks surviving locked quantities and moves the rolling boundary earlier without crossing it', () => {
  const f = fixture({ customerCount: 20, stockCount: 0, extraRows: Array.from({ length: 10 }, (_,i) => row(`SRCLOCK${i}`, { group: 'locked', customer: 'Fixed customer' })) });
  const fixed = f.line.rows.filter(r => r.group === 'locked');
  const before = buildBalancedRolling({ ...f.input, quantity: 8, customerPercent: 100 });
  for (const r of fixed.slice(1,7)) f.plan.report.own.actions.push({ chassis: r.chassis, group: 'locked', action: 'cancel', receive: false });
  reconfirm(f);
  const p = buildBalancedRolling({ ...f.input, quantity: 8, customerPercent: 100 });
  assert.ok(p.basisReplay.lastLocked < before.basisReplay.lastLocked);
  assert.ok(p.schedule[0].auEnd < before.schedule[0].auEnd);
  const applied = buildProductionLine({ ...f.sources, today, orders: {}, rollingSchedule: p.schedule, inventoryBasis: f.plan.confirmation.report });
  assert.equal(applied.counts.locked, 4);
  assert.equal(applied.dealership.lockedLast, p.basisReplay.lastLocked);
  for (const a of p.schedule) assert.equal(applied.rows.find(r => r.chassis === a.chassis).auEnd, a.auEnd);
});
test('locked-line boundary uses Towable capacity and the remaining last-day places across weekends', () => {
  const f = fixture({ customerCount: 20, stockCount: 0, extraRows: [row('SRCLOCK', { group: 'locked', customer: 'Fixed' }), row('SRMMH', { group: 'locked', model: 'SRM22.1', customer: 'Motorhome' })] });
  const futureDays = [...f.capacity.keys()].filter(d => d > today).sort();
  const friday = futureDays.find(d => new Date(d + 'T00:00:00Z').getUTCDay() === 5);
  f.plan.report.own.actions.push({ chassis: 'SRCLOCK', group: 'locked', action: 'delay', delayed: true, plannedAu: friday, receive: false });
  f.plan.report.own.actions.push({ chassis: 'SRMMH', group: 'locked', action: 'delay', delayed: true, plannedAu: plus(friday,7), receive: false }); reconfirm(f);
  const p = buildBalancedRolling({ ...f.input, quantity: 8, customerPercent: 100 });
  const expected = availableRollingSlots({ rows: [{ group: 'locked', model: 'SRC21', auEnd: friday }] }, f.capacity, friday, p.latest).slice(0,8);
  assert.deepEqual(p.schedule.map(a => a.auEnd), expected);
  assert.equal(p.basisReplay.rollingBoundary, friday, 'later Motorhome capacity must not postpone Towable rolling places');
  assert.equal(p.schedule.filter(a => a.auEnd === friday).length, 3);
  assert.equal(p.schedule[3].auEnd, plus(friday,3));
});

test('repacked pending locked supply reserves its updated dealer-arrival date', () => {
  const line = { today: '2027-05-03', rows: [row('CANCEL', { group: 'locked', auEnd: '2027-05-03', auForecast: { seq: 1 } }), row('PENDING', { group: 'locked', auEnd: '2027-05-04', auForecast: { seq: 2 } })] };
  const report = { own: { actions: [{ chassis: 'CANCEL', action: 'cancel', group: 'locked' }, { chassis: 'PENDING', action: 'pending', group: 'locked', originalAu: '2027-05-04', originalArrival: '2027-05-08', from: 'frankston', receive: false }] } };
  const capacity = new Map(['2027-05-03','2027-05-04'].map(d => [d, { towable: 1, srm: 0, srv: 0 }]));
  const replayed = replayInventoryBasis({ line, report, capacity, dealers: [{ slug: 'frankston', name: 'Frankston', travelDays: 1 }] });
  const a = replayed.report.own.actions.find(a => a.chassis === 'PENDING');
  assert.equal(a.plannedAu, '2027-05-03'); assert.equal(a.plannedArrival, '2027-05-07');
  assert.equal(a.receive, false, 'capacity replay must not claim that a pending arrival has been confirmed');
  assert.equal(report.own.actions[1].plannedArrival, undefined, 'the confirmed snapshot remains immutable');
});
