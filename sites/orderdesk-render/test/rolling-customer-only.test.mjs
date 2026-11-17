import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionLine } from '../lib/production-line.mjs';
import { dealerSnapshot, isRollingCustomer, pickRolling } from '../lib/dealership.mjs';

const today = '2026-11-17';
const row = (chassis, extra = {}) => ({ id: chassis, chassis, model: 'SRC21', line: 'Towable', customer: 'Jane', dealer: 'Frankston',
  group: 'customers', signedAt: today, cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });
const capacity = new Map([today, '2026-11-18', '2026-11-19', '2026-11-20'].map(d => [d, { towable: 1, srm: 1, srv: 1 }]));
const build = (rows, extra = {}) => buildProductionLine({ board: { rows, completed: 0, averages: {} }, orders: {}, longtree: new Map(), prod: new Map(), portal: new Map(), today, settings: {},
  dealers: dealerSnapshot({ yard: {} }, today), auCapacity: capacity, ...extra });

test('rolling only admits named Towable customers regardless of spare capacity, dealer need or camper metadata source', () => {
  const excluded = [row('SRV270001'), row('SRM-270001'), row('MODEL', { model: 'srm22.1' }), row('LINE', { line: 'SRV', model: '' }), row('RANGE', { range: 'SRM', model: '' }),
    row('STOCK1', { customer: 'STOCK' }), row('STOCK2', { customer: 'Jane / stock' }), row('EMPTY', { customer: ' ' })];
  assert.ok(excluded.every(r => !isRollingCustomer(r)));
  const rows = [row('FIRST', { orderRow: 1 }), row('SECOND', { model: 'RC17', dealer: 'Wangaratta', orderRow: 2 }), ...excluded];
  const before = structuredClone(rows), pick = pickRolling(rows, [{ slug: 'frankston', need: 500 }], 1000);
  assert.deepEqual(pick.picked.map(x => x.r.chassis), ['FIRST', 'SECOND']); assert.ok(Object.values(pick.stockPicked).every(n => n === 0));
  const out = build(rows), by = Object.fromEntries(out.rows.map(r => [r.chassis, r]));
  assert.deepEqual(out.rows.filter(r => r.group === 'rolling').map(r => r.chassis), ['FIRST', 'SECOND']);
  assert.equal(out.counts.rolling, 2); assert.equal(out.dealership.picked, 2); assert.equal(out.dealership.rollingEnd, '2026-11-18');
  assert.equal(out.auForecast.rolling.n, 2); assert.equal(out.auForecast.srv, 0); assert.equal(out.auForecast.srm, 0);
  assert.equal(by.FIRST.auEnd, today); assert.equal(by.SECOND.auEnd, '2026-11-18');
  for (const r of excluded) { assert.notEqual(by[r.chassis].group, 'rolling'); assert.equal(by[r.chassis].auForecast, undefined); }
  assert.equal(by.STOCK1.group, 'customers'); assert.equal(by.STOCK2.group, 'customers'); assert.equal(by.EMPTY.group, 'later');
  assert.equal(out.rows.length, rows.length); assert.deepEqual(rows, before);
});

test('a Stock-only pool does not reserve phantom rolling capacity or create a rolling completion date', () => {
  const out = build([row('STOCK', { customer: 'Frankston Stock' })]);
  assert.equal(out.counts.rolling, 0); assert.equal(out.auForecast.towable, 0);
  assert.equal(out.dealership.picked, 0); assert.equal(out.dealership.rollingEnd, out.dealership.lockedLast);
});

test('insufficient AU capacity leaves the rolling completion date and point-in-time inventory need pending', () => {
  const out = build([row('ONE'), row('TWO')], { auCapacity: new Map([[today, { towable: 1, srm: 1, srv: 1 }]]) });
  assert.equal(out.counts.rolling, 2); assert.equal(out.dealership.rollingEnd, '');
  assert.equal(out.dealership.dealers.find(d => d.slug === 'frankston').need, null);
  assert.equal(out.dealership.dealers.find(d => d.slug === 'frankston').projected, null);
});

test('motorhome and Stock rows already in actual production or the locked line keep their original stages', () => {
  const rows = ['locked', 'cn', 'sea', 'au', 'transport'].flatMap((group, i) => [row(`SRM${i}`, { group, model: 'SRM22.1' }), row(`SRC${i}`, { group, customer: 'Stock' })]);
  const physical = rows.filter(r => ['au', 'transport'].includes(r.group));
  const out = build(rows, { prod: new Map(physical.map(r => [r.chassis, { location: r.group === 'transport' ? 'transport' : 'qc' }])), portal: new Map(physical.map(r => [r.chassis, { grAt: today }])) });
  const actual = new Map(out.rows.map(r => [r.chassis, r.group]));
  for (const r of rows) assert.equal(actual.get(r.chassis), r.group);
  assert.equal(out.counts.rolling, 0);
});
