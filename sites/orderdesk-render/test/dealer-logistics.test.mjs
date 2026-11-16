import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDealerLogistics } from '../lib/dealer-logistics.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { dealerSnapshot } from '../lib/dealership.mjs';

const row = (chassis, group, dealer = 'Frankston', customer = 'Frankston Stock', extra = {}) => ({ chassis, group, dealer, customer, ...extra });
const site = (slug, where, category = 'stock', via = 'pgi') => ({ dealerSite: { slug, where, category, via } });
const dealer = (data, slug = 'frankston') => data.dealers.find(d => d.slug === slug);
const total = data => data.dealers.reduce((n, d) => n + Object.values(d.stages).reduce((m, s) => m + s.total, 0), 0);
const counts = ({ stock, customer, total }) => ({ stock, customer, total });

test('Motorised = SRM/SRV models or chassis; all other vehicles are Towable, across stages and stock months', () => {
  const snapshot = [{ slug: 'wangaratta', name: 'Wangaratta', vehicles: [
    { chassis: 'YARD1', model: 'SRV19.1', where: 'yard', category: 'stock', since: '2026-10-01' },
    { chassis: 'SRM270001', model: '', where: 'transit', category: 'stock', arrive: '2026-12-01' },
  ] }];
  const data = buildDealerLogistics([
    row('A1', 'au', 'Frankston', 'Stock', { model: 'srm22.1', auEnd: '2026-12-29' }),
    row('SRV-270002', 'locked', 'Geelong', 'Jane'),
    row('T1', 'au', 'Frankston', 'Stock', { model: 'SRC21', auEnd: '2026-12-29' }),
    row('T2', 'customers', '', 'Stock'),
    row('YARD1', 'transport', 'Frankston', 'Stock', { model: 'SRV19.1' }),
  ], { dealers: snapshot, today: '2026-11-17' });
  const f = dealer(data), w = dealer(data, 'wangaratta');
  assert.deepEqual(f.byVehicle.motorised.au.stockMonths, { '2027-01': 1 });
  assert.deepEqual(f.byVehicle.towable.au.stockMonths, { '2027-01': 1 });
  assert.equal(dealer(data, 'geelong').byVehicle.motorised.locked.customer, 1);
  assert.equal(dealer(data, 'unassigned').byVehicle.towable.pool.stock, 1);
  assert.equal(w.byVehicle.motorised.dealership.stock, 1, 'yard classification uses the Portal model');
  assert.equal(w.byVehicle.motorised.transit.stock, 1, 'missing models fall back to SRM/SRV chassis');
  assert.equal(f.byVehicle.motorised.transport.stock, 0, 'a downstream copy wins before vehicle-type aggregation');
  for (const d of data.dealers) for (const [stage, all] of Object.entries(d.stages)) {
    const m = d.byVehicle.motorised[stage], t = d.byVehicle.towable[stage];
    for (const k of ['stock', 'customer', 'total', 'stockUndated']) assert.equal(m[k] + t[k], all[k]);
    for (const month of Object.keys(all.stockMonths)) assert.equal((m.stockMonths[month] || 0) + (t.stockMonths[month] || 0), all.stockMonths[month]);
  }
});

test('All orders includes every dealer and unassigned orders; the four dealers are quick filters only', () => {
  const rows = [row('P1', 'customers'), row('P2', 'later', 'Geelong', 'Jane'), row('R1', 'rolling', 'ST James', 'Ann'),
    row('L1', 'locked'), row('C1', 'cn'), row('S1', 'sea'), row('A1', 'au'), row('T1', 'transport'),
    row('T2', 'transport', 'Launceston', 'Sam'), row('J1', 'rolling', 'stjames', 'Perth Stock'),
    row('EMPTY', 'locked', 'Frankston', '', { empty: true }), row('', 'rolling'), row('OTHER', 'cn', 'Wangaratta'), row('PAUSED', 'cn', 'Traralgon'), row('UNASSIGNED', 'customers', '', 'Unassigned Stock')];
  const data = buildDealerLogistics(rows), f = dealer(data);
  assert.deepEqual(data.dealers.filter(d => d.featured).map(d => d.slug), ['frankston', 'geelong', 'launceston', 'st-james']);
  assert.equal(total(data), 13);
  assert.equal(dealer(data, 'wangaratta').stages.cn.stock, 1);
  assert.equal(dealer(data, 'traralgon').stages.cn.stock, 1);
  assert.equal(dealer(data, 'unassigned').stages.pool.stock, 1);
  for (const stage of ['pool', 'locked', 'cn', 'sea', 'au', 'transport']) assert.deepEqual(counts(f.stages[stage]), { stock: 1, customer: 0, total: 1 });
  assert.equal(dealer(data, 'geelong').stages.pool.customer, 1);
  assert.deepEqual(counts(dealer(data, 'st-james').stages.rolling), { stock: 1, customer: 1, total: 2 });
  assert.equal(dealer(data, 'launceston').stages.transport.customer, 1);
  assert.deepEqual(counts(f.stages.transit), { stock: 0, customer: 0, total: 0 });
  assert.ok(buildDealerLogistics().dealers.every(d => Object.values(d.stages).every(s => s.total === 0)));
});

test('Transport, PGI transit and yards are separate; a chassis is counted once at its furthest known location', () => {
  const rows = [row('SRC-100001', 'au'), row('src100001', 'transport'), row('SRC 100001', 'dealership', '', '', site('geelong', 'transit', 'customer')),
    row('SRC100002', 'transport'), row('SRC100002', 'dealership', '', '', site('frankston', 'yard')),
    row('SRC100003', 'transport'), row('SRC100003', 'transport'),
    row('SRC100004', 'dealership', '', 'Should not determine category Stock', site('st-james', 'yard', 'customer')),
    row('SRC100005', 'dealership', '', 'Jane', site('launceston', 'transit', 'stock')),
    row('SRC100006', 'dealership', '', '', site('frankston', 'transit', 'customer', 'transport'))];
  const before = structuredClone(rows), data = buildDealerLogistics(rows);
  assert.deepEqual(rows, before, 'the shared production line is not mutated');
  assert.equal(total(data), 6);
  assert.equal(dealer(data).stages.au.total, 0);
  assert.deepEqual(counts(dealer(data).stages.transport), { stock: 1, customer: 1, total: 2 });
  assert.equal(dealer(data).stages.transit.total, 0);
  assert.equal(dealer(data).stages.dealership.stock, 1);
  assert.equal(dealer(data, 'geelong').stages.transit.customer, 1, 'use the PGI destination after delivery-to override');
  assert.equal(dealer(data, 'st-james').stages.dealership.customer, 1, 'use yard bill-to category, not the production customer name');
  assert.equal(dealer(data, 'launceston').stages.transit.stock, 1);
  assert.deepEqual(buildDealerLogistics([...rows].reverse()), data, 'downstream evidence wins independently of row order');
});

test('second-hand is excluded and a transferred van is counted at its current dealer only', () => {
  const data = buildDealerLogistics([row('USED1', 'cn'), row('USED1', 'dealership', '', '', site('frankston', 'yard', 'second')),
    row('MOVED1', 'au'), row('MOVED1', 'dealership', '', '', site('traralgon', 'yard')),
    row('USED2', 'dealership', '', '', site('geelong', 'transit', 'second'))]);
  assert.equal(total(data), 1);
  assert.equal(dealer(data).stages.au.total, 0);
  assert.equal(dealer(data, 'traralgon').stages.dealership.stock, 1);
});

test('flow uses the final production line after rolling selection and the existing PGI eligibility rules', () => {
  const today = '2026-11-17';
  const dealers = dealerSnapshot({ yard: { frankston: {
    YARD: { wholesaleBillToName: 'Regent RV' }, USED: { vehicleType: 'Second Hand' },
  } }, pgi: {
    ROAD: { dealer: 'Frankston', pgidate: '16/11/2026', customer: 'Frankston Stock' },
    OLD: { dealer: 'Frankston', pgidate: '01/01/2026', customer: 'Stock' },
    HANDED: { dealer: 'Frankston', pgidate: '16/11/2026', customer: 'Stock' },
    YARD: { dealer: 'Frankston', pgidate: '16/11/2026', customer: 'Stock' },
  }, handover: { frankston: { HANDED: { handoverAt: today } } } }, today);
  const board = { rows: [row('ROLL', 'later', 'Frankston', 'Jane'), row('WAIT', 'later'), row('READY', 'au')]
    .map(r => ({ ...r, id: r.chassis, warnings: [], cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '' })), completed: 0, averages: {} };
  const line = buildProductionLine({ board, orders: {}, dealers, today, settings: {}, rollingSize: 1,
    longtree: new Map(), portal: new Map(), prod: new Map([['READY', { location: 'transport' }]]) });
  const f = dealer(buildDealerLogistics(line.rows));
  assert.equal(f.stages.pool.stock, 1);
  assert.equal(f.stages.rolling.customer, 1);
  assert.equal(f.stages.transport.stock, 1);
  assert.equal(f.stages.transit.stock, 1, 'excludes old PGI, handovers, yards and Transport');
  assert.deepEqual(counts(f.stages.dealership), { stock: 1, customer: 0, total: 1 });
});

test('every dealer’s Portal yard and transit are included even when the production board only contains self-owned yards', () => {
  const today = '2026-11-17';
  const snapshot = dealerSnapshot({ dealerConfigs: { wangaratta: { name: 'Wangaratta', isActive: true } },
    yard: { wangaratta: { Y1: { type: 'Stock', receivedAt: '2026-10-01' }, USED: { vehicleType: 'Second Hand' } } },
    pgi: { R1: { dealer: 'Wangaratta', customer: 'Dealer Stock', pgidate: '16/11/2026' },
      OLD: { dealer: 'Wangaratta', customer: 'Stock', pgidate: '01/01/2026' },
      DONE: { dealer: 'Wangaratta', customer: 'Stock', pgidate: '16/11/2026' } },
    handover: { wangaratta: { DONE: { handoverAt: today } } } }, today, { all: true });
  const rows = [row('Y1', 'sea', 'Wangaratta'), row('R1', 'transport', 'Wangaratta')];
  const before = structuredClone(snapshot);
  const data = buildDealerLogistics(rows, { dealers: snapshot, today }), w = dealer(data, 'wangaratta');
  assert.equal(total(data), 2);
  assert.equal(w.stages.sea.total, 0); assert.equal(w.stages.transport.total, 0);
  assert.equal(w.stages.dealership.stock, 1); assert.equal(w.stages.transit.stock, 1);
  assert.deepEqual(w.stages.dealership.stockMonths, { '2026-10': 1 });
  assert.equal(w.stages.transit.stockUndated, 1, 'missing road days are not invented');
  assert.deepEqual(snapshot, before, 'the shared Portal snapshot is not changed');
});

test('Stock arrival months use AU finish + dispatch + road days, PGI + road days, and actual yard receipts', () => {
  const today = '2026-11-17';
  const data = buildDealerLogistics([
    row('POOL', 'customers', 'Frankston', 'Stock', { auEnd: '2026-12-01' }),
    row('ROLL', 'rolling', 'Frankston', 'Stock', { auEnd: '2026-12-29' }),
    row('LOCK', 'locked', 'Geelong', 'Stock', { auEnd: '2026-11-27' }),
    row('CN', 'cn', 'Launceston', 'Stock', { auEnd: '2026-11-10' }),
    row('SEA', 'sea', 'St James', 'Stock', { auEnd: '2026-12-09' }),
    row('AU', 'au', 'Frankston', 'Stock', { auEnd: '2026-11-18' }),
    row('T', 'transport', 'ST James', 'Stock', { auEnd: '2026-01-01' }),
    row('ROAD', 'dealership', '', '', { dealerSite: { slug: 'st-james', where: 'transit', category: 'stock', since: '2026-11-16' } }),
    row('OVERDUE', 'dealership', '', '', { dealerSite: { slug: 'frankston', where: 'transit', category: 'stock', since: '2026-10-30' } }),
    row('YARD', 'dealership', '', '', { dealerSite: { slug: 'frankston', where: 'yard', category: 'stock', since: '2026-10-20' } }),
    row('CUST', 'au', 'Frankston', 'Jane', { auEnd: '2026-11-18' }),
    row('UNKNOWN', 'au', 'Wangaratta', 'Stock', { auEnd: '2026-11-18' }),
    row('OVERFLOW', 'locked', 'Frankston', 'Stock', { auEnd: '2026-11-18', auForecast: { note: 'overflow' } }),
  ], { today });
  const f = dealer(data), j = dealer(data, 'st-james');
  assert.deepEqual(f.stages.rolling.stockMonths, { '2027-01': 1 });
  assert.deepEqual(dealer(data, 'geelong').stages.locked.stockMonths, { '2026-12': 1 });
  assert.deepEqual(dealer(data, 'launceston').stages.cn.stockMonths, { '2026-12': 1 });
  assert.deepEqual(j.stages.sea.stockMonths, { '2027-01': 1 });
  assert.deepEqual(j.stages.transport.stockMonths, { '2026-12': 1 });
  assert.deepEqual(j.stages.transit.stockMonths, { '2026-12': 1 });
  assert.deepEqual(f.stages.au.stockMonths, { '2026-11': 1 }, 'Customer vehicles do not enter Stock months');
  assert.deepEqual(f.stages.transit.stockMonths, { '2026-11': 1 }, 'overdue PGI is still arriving now');
  assert.deepEqual(f.stages.dealership.stockMonths, { '2026-10': 1 });
  assert.equal(f.stages.pool.stockUndated, 1, 'pool orders have no confirmed active production slot');
  assert.equal(f.stages.locked.stockUndated, 1, 'capacity overflow has no reliable finish date');
  assert.equal(dealer(data, 'wangaratta').stages.au.stockUndated, 1);
  for (const d of data.dealers) for (const s of Object.values(d.stages)) assert.equal(Object.values(s.stockMonths).reduce((n, v) => n + v, 0) + s.stockUndated, s.stock);
});

test('a downstream transfer changes the Stock arrival month without duplicating the chassis', () => {
  const data = buildDealerLogistics([row('DUP1', 'au', 'Frankston', 'Stock', { auEnd: '2027-01-20' }),
    row('DUP1', 'dealership', '', '', { dealerSite: { slug: 'geelong', where: 'yard', category: 'stock', since: '2026-10-20' } })], { today: '2026-11-17' });
  assert.equal(dealer(data).stages.au.stock, 0);
  assert.deepEqual(dealer(data, 'geelong').stages.dealership.stockMonths, { '2026-10': 1 });
  assert.equal(total(data), 1);
});
