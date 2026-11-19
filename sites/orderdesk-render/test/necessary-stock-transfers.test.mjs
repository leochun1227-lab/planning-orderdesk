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

test('inventory balance wins over waiting months solely to keep the original dealer', () => {
  const report = run([dealer('a', { yard: { stock: 10 } }), dealer('b')], [row('S1')], { capacity: capacity([today, '2026-12-17']), assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10, weeklyStock: 1 }] } });
  assert.equal(list(report)[0].to, 'b'); assert.equal(list(report)[0].plannedAu, today);
});

test('an own pool vehicle at the same slot avoids a transfer without changing balanced inventory', () => {
  const dealers = [dealer('a'), dealer('b', { yard: { stock: 0 }, vehicles: [] })];
  const rows = [row('SURPLUS'), row('OWN-MODEL', { group: 'customers', dealer: 'b', auEnd: '' })];
  const exchanged = run(dealers, rows, { capacity: capacity([today]) });
  const transferred = run(dealers, rows, { capacity: capacity([today]), assumptions: { exchangeSlots: false, customerPercent: 0 } });
  assert.equal(exchanged.totals.reallocated, 0); assert.equal(transferred.totals.reallocated, 1);
  assert.equal(list(exchanged).find(a => a.chassis === 'OWNMODEL').to, 'b');
  assert.deepEqual(exchanged.own.dealers.map(d => d.monthly.map(m => [m.stockIn,m.endStock,m.idealMultiple])), transferred.own.dealers.map(d => d.monthly.map(m => [m.stockIn,m.endStock,m.idealMultiple])));
});

test('disabling slot exchange does not silently admit a later pool order during coverage repair', () => {
  const report = run([dealer('a'), dealer('b', { yard: { stock: 0 }, vehicles: [] })], [row('SURPLUS'), row('OWN-MODEL', { group: 'customers', dealer: 'b', auEnd: '' })], {
    capacity: capacity([today, '2027-02-17']), assumptions: { customerPercent: 0, exchangeSlots: false, finishDates: { 'OWN-MODEL': '2027-02-17' } }
  });
  assert.equal(list(report).find(a => a.chassis === 'OWNMODEL').slotScheduled, undefined);
  assert.equal(report.totals.reallocated, 1, 'an unavailable own job must not prevent balancing');
});

test('a fixed-stage transfer requires ceiling pressure, keeps the sender’s model, and records the reason', () => {
  const report = run([dealer('a', { yard: { stock: 10 } }), dealer('b')], [row('FIXED', { group: 'au' })], {
    assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10 }] }
  });
  const a = list(report)[0];
  assert.equal(a.to, 'b'); assert.equal(a.plannedAu, today);
  assert.equal(a.reallocationCheck.required, true); assert.equal(a.reallocationCheck.reason, 'inventoryBalance');
  assert.equal(a.reallocationCheck.dateEditable, false); assert.equal(report.reallocationReview.unverified, 0);
});

test('future fixed supply is reserved before choosing a receiver, avoiding a transfer cascade', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b', { target: 1 }), dealer('c')];
  const report = run(dealers, [row('FIRST', { group: 'au' }), row('B-FUTURE', { dealer: 'b', group: 'cn', auEnd: '2027-01-14' })], {
    assumptions: { customerPercent: 0, dealers: [{ slug: 'a', cap: 10 }, { slug: 'b', cap: 2 }] }
  });
  assert.equal(list(report).find(a => a.chassis === 'FIRST').to, 'c');
  assert.ok(list(report).every(a => !a.limitConflict));
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
  const a = list(report)[0]; assert.equal(a.to, 'b'); assert.equal(a.reallocationCheck.reason, 'inventoryBalance');
  const withOwn = run(dealers, [row('EXTRA', { group: 'sea' }), row('OWN', { dealer: 'b', group: 'customers', auEnd: '', signedAt: today })]);
  assert.equal(withOwn.totals.reallocated, 1, 'future own orders alone do not justify leaving the inventory imbalance');
});

test('the final audit rejects ratio-only or SRH MY2026 transfers and validates each retained reason', () => {
  const dealers = [dealer('a', { yard: { stock: 10 } }), dealer('b', { yard: { stock: 0 }, vehicles: [] }), dealer('c')];
  const report = run(dealers, [row('EXTRA', { group: 'au' }), row('SRH-OLD', { group: 'cn', model: 'SRH19', modelYear: '2026' }), row('LATER', { auEnd: '2027-01-14' })], { capacity: new Map([[today, { towable: 2, srm: 0, srv: 0 }], ['2027-01-14', { towable: 1, srm: 0, srv: 0 }]]) });
  assert.equal(list(report).find(a => a.chassis === 'SRHOLD').to, 'a');
  for (const a of list(report).filter(a => a.reallocated)) {
    assert.ok(['inventoryBalance', 'inventoryBalance'].includes(a.reallocationCheck.reason));
    assert.equal(a.reallocationCheck.required, true); assert.equal(a.reallocationCheck.balanceOnly, true);
  }
  assert.equal(report.reallocationReview.checked, report.totals.reallocated); assert.equal(report.reallocationReview.unverified, 0);
});


test('one undated incoming order does not exclude a low-inventory dealer from balancing', () => {
 const report=run([dealer('a',{yard:{stock:8}}),dealer('b',{yard:{stock:0},vehicles:[]})],[row('GIVE',{group:'au'}),row('UNKNOWN',{dealer:'b',group:'cn',auEnd:''})]);
 assert.equal(list(report).find(a=>a.chassis==='GIVE').to,'b');
 assert.equal(report.own.dealers.find(d=>d.slug==='b').undatedIncoming,1);
});
