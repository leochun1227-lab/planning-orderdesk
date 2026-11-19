import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';

const today = '2026-11-19';
const yard = (chassis, model = 'SRC21') => ({ chassis, model, modelYear: '2027', category: 'stock', where: 'yard' });
const dealer = (slug, extra = {}) => ({ slug, name: slug, own: true, target: 10, travelDays: 0, yard: { stock: 1 }, transit: { stock: 0 }, vehicles: [yard(`Y-${slug}`)], handover: { months: [], avgStock: 0, thisMonth: { stock: 0 } }, ...extra });
const row = (chassis, extra = {}) => ({ chassis, model: 'SRC21', modelYear: '2027', dealer: 'a', customer: 'Stock', group: 'locked', auEnd: today, signedAt: today, ...extra });
const capacity = days => new Map(days.map(day => [day, { towable: 1, srm: 0, srv: 0 }]));
const list = r => ['own', 'jv', 'independent'].flatMap(g => r[g].actions);
const run = (dealers, rows, extra = {}) => buildStockSimulation({ today, dealers, rows, displayModels: ['SRC21'], assumptions: { customerPercent: 0 }, ...extra });

test('an editable Stock job waits for its own feasible date rather than transferring to a less full dealer', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b')], rows = [row('S1')];
  const report = run(dealers, rows, { capacity: capacity([today, '2026-12-17']), assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10, weeklyStock: 1 }] } });
  const a = list(report)[0];
  assert.equal(a.to, 'a'); assert.equal(a.plannedAu, '2026-12-17'); assert.equal(a.action, 'reschedule');
  assert.equal(report.totals.reallocated, 0);
  assert.doesNotThrow(() => replayInventoryBasis({ line: { today, rows }, report, dealers }));
});

test('a later own-dealer model replaces a surplus selected job before considering a model transfer', () => {
  const dealers = [dealer('a'), dealer('b', { yard: { stock: 0 }, vehicles: [] })];
  const rows = [row('SURPLUS'), row('OWN-MODEL', { group: 'customers', dealer: 'b', auEnd: '' })];
  const report = run(dealers, rows, { capacity: capacity([today, '2027-02-17']), assumptions: { customerPercent: 0, finishDates: { 'OWN-MODEL': '2027-02-17' } } });
  assert.equal(report.totals.reallocated, 0);
  const own = list(report).find(a => a.chassis === 'OWNMODEL'), surplus = list(report).find(a => a.chassis === 'SURPLUS');
  assert.equal(own.to, 'b'); assert.equal(own.plannedAu, '2027-02-17'); assert.equal(own.slotScheduled, true);
  assert.equal(surplus.action, 'pool'); assert.equal(surplus.slotReleased, true);
  assert.equal(report.coverage.missing, 0);
});

test('disabling slot exchange does not silently admit a later pool order during coverage repair', () => {
  const report = run([dealer('a'), dealer('b', { yard: { stock: 0 }, vehicles: [] })], [row('SURPLUS'), row('OWN-MODEL', { group: 'customers', dealer: 'b', auEnd: '' })], {
    capacity: capacity([today, '2027-02-17']), assumptions: { customerPercent: 0, exchangeSlots: false, finishDates: { 'OWN-MODEL': '2027-02-17' } }
  });
  assert.equal(list(report).find(a => a.chassis === 'OWNMODEL').slotScheduled, undefined);
  assert.equal(report.totals.reallocated, 0, 'a known own model is not a reason to transfer another dealer’s vehicle');
});

test('a fixed-stage transfer requires ceiling pressure, keeps the sender’s model, and records the reason', () => {
  const report = run([dealer('a', { yard: { stock: 10 } }), dealer('b')], [row('FIXED', { group: 'au' })], {
    assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10 }] }
  });
  const a = list(report)[0];
  assert.equal(a.to, 'b'); assert.equal(a.plannedAu, today);
  assert.equal(a.reallocationCheck.required, true); assert.equal(a.reallocationCheck.reason, 'fixedCeiling');
  assert.equal(a.reallocationCheck.dateEditable, false); assert.equal(report.reallocationReview.unverified, 0);
});

test('future fixed supply is reserved before choosing a receiver, avoiding a transfer cascade', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b', { target: 1 }), dealer('c')];
  const report = run(dealers, [row('FIRST', { group: 'au' }), row('B-FUTURE', { dealer: 'b', group: 'cn', auEnd: '2027-01-14' })], {
    assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10 }, { slug: 'b', cap: 2 }] }
  });
  assert.equal(list(report).find(a => a.chassis === 'FIRST').to, 'c');
  assert.equal(list(report).find(a => a.chassis === 'BFUTURE').to, 'b');
  assert.equal(report.totals.reallocated, 1);
});

test('a receiver’s later committed model prevents a redundant coverage transfer chain', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b', { target: 30, yard: { stock: 0 }, vehicles: [] }), dealer('c', { yard: { stock: 10 }, vehicles: [yard('OLD-C', 'SRC19')] })];
  const report = run(dealers, [row('FIRST', { group: 'au' }), row('B-FUTURE', { dealer: 'b', group: 'cn', auEnd: '2027-01-14' })], {
    assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10 }] }
  });
  assert.equal(list(report).find(a => a.chassis === 'FIRST').to, 'c', 'B already has this model on its future physical route');
  assert.equal(list(report).find(a => a.chassis === 'BFUTURE').to, 'b');
  assert.equal(report.totals.reallocated, 1, 'one necessary transfer satisfies both ceiling pressure and missing-model coverage');
});

test('a model transfer is retained only where the receiver has no eligible own model and the sender keeps one', () => {
  const dealers = [dealer('a'), dealer('b', { yard: { stock: 0 }, vehicles: [] })];
  const report = run(dealers, [row('EXTRA', { group: 'sea' })]);
  assert.equal(report.totals.reallocated, 1);
  const a = list(report)[0]; assert.equal(a.to, 'b'); assert.equal(a.reallocationCheck.reason, 'modelNoOwnOrder');
  const withOwn = run(dealers, [row('EXTRA', { group: 'sea' }), row('OWN', { dealer: 'b', group: 'customers', auEnd: '', signedAt: today })]);
  assert.equal(withOwn.totals.reallocated, 0); assert.equal(list(withOwn).find(a => a.chassis === 'EXTRA').to, 'a');
});

test('the final audit rejects ratio-only or SRH MY2026 transfers and validates each retained reason', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b', { yard: { stock: 0 }, vehicles: [] }), dealer('c')];
  const report = run(dealers, [row('EXTRA', { group: 'au' }), row('SRH-OLD', { group: 'cn', model: 'SRH19', modelYear: '2026' }), row('LATER', { auEnd: '2027-01-14' })], { capacity: new Map([[today, { towable: 2, srm: 0, srv: 0 }], ['2027-01-14', { towable: 1, srm: 0, srv: 0 }]]) });
  assert.equal(list(report).find(a => a.chassis === 'SRHOLD').to, 'a');
  for (const a of list(report).filter(a => a.reallocated)) {
    assert.ok(['fixedCeiling', 'modelNoOwnOrder'].includes(a.reallocationCheck.reason));
    assert.equal(a.reallocationCheck.required, true); assert.equal(a.reallocationCheck.balanceOnly, false);
  }
  assert.equal(report.reallocationReview.checked, report.totals.reallocated); assert.equal(report.reallocationReview.unverified, 0);
});
