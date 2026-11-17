import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFor, buildProductionLine } from '../lib/production-line.mjs';
import { pickRolling, dealerSnapshot } from '../lib/dealership.mjs';
import { parseTms } from '../lib/tms-shipping.mjs';

const today = '2026-11-17';
const row = (chassis, group, extra = {}) => ({ id: chassis, chassis, group, customer: 'Jane', dealer: 'Frankston',
  model: 'SRC21', signedAt: '2026-10-01', cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });
const build = (rows, extra = {}) => buildProductionLine({ board: { rows, completed: 0, averages: {} }, orders: {},
  longtree: new Map(), prod: new Map(), portal: new Map(), today, settings: {}, ...extra });

test('a displayed Shipment record without vehicle GR always means shipping, even with AU production facts', () => {
  const ship = { container: 'C1', voyage: 'V1', eta: '', arrived: true, containerGr: '2026-11-01' };
  for (const group of ['locked', 'rolling', 'customers', 'later', 'cn', 'sea', 'au', 'transport']) {
    for (const au of [null, { location: 'received' }, { location: 'production' }, { location: 'qc' }, { location: 'transport' }]) {
      assert.equal(groupFor(row('SRC1', group, { auActual: '2026-11-01' }), {}, {}, today, au, ship), 'sea');
    }
  }
  assert.equal(groupFor(row('SRC1', 'cn'), {}, { grAt: '2026-11-16' }, today, { location: 'production' }, ship), 'au');
  assert.equal(groupFor(row('SRC1', 'cn'), {}, { grAt: '2026-11-16' }, today, { location: 'transport' }, ship), 'transport');
  assert.equal(groupFor(row('SRC1', 'cn'), {}, {}, today, { location: 'production' }), 'au', 'no Shipment: keep the existing factory rule');
  assert.equal(groupFor(row('', 'empty', { empty: true }), {}, {}, today, null, ship), 'empty');
});

test('grouping uses the same normalized per-chassis Shipment object displayed in the column, before the locked plan', () => {
  const tms = parseTms({ vessels: { v: { vesselVoyage: 'V1', etaArrivalMelbourne: '25/11/2026' } },
    containers: { c: { containerNumber: 'C1', vesselVoyage: 'V1', chassisNumbers: ['SRC-1', 'SRC2', 'SRC3'] } } });
  const rows = [row('SRC1', 'au'), row('SRC2', 'locked'), row('SRC3', 'au'), row('SRC4', 'au')];
  const plan = { activeUntil: '2026-12-31', rows: [], byChassis: new Map([['SRC2', { order: 1, months: ['2026-11#1'] }]]) };
  const out = build(rows, { tms, plan, orders: { SRC1: { chassis: 'SRC1', productionStatus: 'Finished' } },
    prod: new Map([['SRC1', { location: 'transport' }], ['SRC3', { location: 'transport' }], ['SRC4', { location: 'qc' }]]),
    portal: new Map([['SRC3', { grAt: '2026-11-16' }]]) });
  const by = Object.fromEntries(out.rows.map(r => [r.chassis, r]));
  assert.equal(by.SRC1.group, 'sea', 'CRM Finished and a Transport location cannot override Shipment without GR');
  assert.equal(by.SRC2.group, 'sea', 'a dated locked plan cannot override Shipment without GR');
  assert.equal(by.SRC3.group, 'transport'); assert.equal(by.SRC4.group, 'au');
  assert.deepEqual(by.SRC1.live.ship, tms.get('SRC1'));
  assert.equal(by.SRC1.live.location, 'transport', 'source facts remain visible for reconciliation');
  assert.equal(out.counts.sea, 2); assert.equal(out.counts.transport, 1); assert.equal(out.counts.au, 1);
});

test('named Towable Customer orders enter beyond 180; blank names and Stock never enter', () => {
  const customers = Array.from({ length: 185 }, (_, i) => row(`C${i}`, i % 2 ? 'customers' : 'later', {
    dealer: i % 2 ? 'Wangaratta' : '', customer: i === 0 ? '' : 'Stock / Jane', orderRow: i + 2 }));
  const stock = Array.from({ length: 5 }, (_, i) => row(`S${i}`, 'customers', { customer: 'Frankston sToCk', orderRow: 1 }));
  const rows = [...stock, ...customers].reverse(), before = structuredClone(rows);
  const needs = [{ slug: 'frankston', need: 5 }];
  const full = pickRolling(rows, needs, 180);
  assert.equal(full.customers, 184); assert.equal(full.picked.length, 184);
  assert.deepEqual(full.picked.map(p => p.r.chassis), customers.slice(1).map(r => r.chassis));
  assert.equal(full.stockPicked.frankston, 0);
  assert.equal(pickRolling(rows, needs, 188).stockPicked.frankston, 0);
  assert.deepEqual(rows, before, 'the cached source rows are not mutated by selection');
});

test('Customer promotion works without dealership data and keeps physical/locked vehicles out of the order pool', () => {
  const out = build([row('C1', 'customers', { dealer: 'Wangaratta', orderRow: 2 }), row('C2', 'later', { dealer: '', customer: '', orderRow: 1 }),
    row('C3', 'rolling', { orderRow: 3 }), row('S1', 'customers', { customer: 'Jane / STOCK' }),
    row('S2', 'later', { customer: 'livestock' }), row('LOCK', 'locked'), row('CN', 'cn')], {
      orders: { C1: { chassis: 'C1', slotRow: 2 }, C2: { chassis: 'C2', slotRow: 1 }, C3: { chassis: 'C3', slotRow: 3 } },
    });
  const by = Object.fromEntries(out.rows.map(r => [r.chassis, r]));
  assert.equal(out.dealership, null);
  assert.deepEqual(out.rows.filter(r => r.group === 'rolling').map(r => r.chassis), ['C1', 'C3']);
  assert.deepEqual(out.rows.filter(r => r.group === 'rolling').map(r => r.rollingOrder), [1, 2]);
  assert.equal(by.C2.group, 'later'); assert.equal(by.S1.group, 'customers'); assert.equal(by.S2.group, 'customers');
  assert.equal(by.LOCK.group, 'locked'); assert.equal(by.CN.group, 'cn');
  assert.equal(out.counts.rolling, 2); assert.equal(out.counts.customers, 2); assert.equal(out.counts.later, 1);
});

test('rolling totals and AU forecasts include all customers, and the stock projection horizon grows beyond the target', () => {
  const cap = new Map(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map(d => [d, { towable: 1, srm: 0, srv: 0 }]));
  const out = build([row('AU', 'au'), row('C1', 'customers', { orderRow: 1 }),
    row('C2', 'customers', { dealer: 'Wangaratta', orderRow: 2 }), row('C3', 'later', { dealer: '', orderRow: 3 }),
    row('S1', 'customers', { customer: 'Stock' })], { dealers: dealerSnapshot({ yard: {} }, today), rollingSize: 2, auCapacity: cap,
    prod: new Map([['AU', { location: 'qc' }]]), portal: new Map([['AU', { grAt: '2026-11-16' }]]) });
  assert.equal(out.dealership.customers, 3); assert.equal(out.dealership.picked, 3);
  assert.equal(out.dealership.size, 2); assert.equal(out.dealership.lockedLast, '2026-11-17');
  assert.equal(out.dealership.rollingEnd, '2026-11-20');
  assert.deepEqual(out.rows.filter(r => r.group === 'rolling').map(r => r.auEnd), ['2026-11-18', '2026-11-19', '2026-11-20']);
  assert.equal(out.rows.find(r => r.chassis === 'S1').group, 'customers');
});
