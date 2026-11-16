import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDealerLogistics } from '../lib/dealer-logistics.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { dealerSnapshot } from '../lib/dealership.mjs';

const row = (chassis, group, dealer = 'Frankston', customer = 'Frankston Stock', extra = {}) => ({ chassis, group, dealer, customer, ...extra });
const site = (slug, where, category = 'stock', via = 'pgi') => ({ dealerSite: { slug, where, category, via } });
const dealer = (data, slug = 'frankston') => data.dealers.find(d => d.slug === slug);
const total = data => data.dealers.reduce((n, d) => n + Object.values(d.stages).reduce((m, s) => m + s.total, 0), 0);

test('four dealer flow: pool and rolling split, every production stage, stock/customer and explicit zeroes', () => {
  const rows = [row('P1', 'customers'), row('P2', 'later', 'Geelong', 'Jane'), row('R1', 'rolling', 'ST James', 'Ann'),
    row('L1', 'locked'), row('C1', 'cn'), row('S1', 'sea'), row('A1', 'au'), row('T1', 'transport'),
    row('T2', 'transport', 'Launceston', 'Sam'), row('J1', 'rolling', 'stjames', 'Perth Stock'),
    row('EMPTY', 'locked', 'Frankston', '', { empty: true }), row('', 'rolling'), row('OTHER', 'cn', 'Wangaratta'), row('PAUSED', 'cn', 'Traralgon')];
  const data = buildDealerLogistics(rows), f = dealer(data);
  assert.deepEqual(data.dealers.map(d => d.slug), ['frankston', 'geelong', 'launceston', 'st-james']);
  assert.equal(total(data), 10);
  for (const stage of ['pool', 'locked', 'cn', 'sea', 'au', 'transport']) assert.deepEqual(f.stages[stage], { stock: 1, customer: 0, total: 1 });
  assert.equal(dealer(data, 'geelong').stages.pool.customer, 1);
  assert.deepEqual(dealer(data, 'st-james').stages.rolling, { stock: 1, customer: 1, total: 2 });
  assert.equal(dealer(data, 'launceston').stages.transport.customer, 1);
  assert.deepEqual(f.stages.transit, { stock: 0, customer: 0, total: 0 });
  assert.deepEqual(buildDealerLogistics().dealers.map(d => Object.values(d.stages).every(s => s.total === 0)), [true, true, true, true]);
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
  assert.deepEqual(dealer(data).stages.transport, { stock: 1, customer: 1, total: 2 });
  assert.equal(dealer(data).stages.transit.total, 0);
  assert.equal(dealer(data).stages.dealership.stock, 1);
  assert.equal(dealer(data, 'geelong').stages.transit.customer, 1, 'use the PGI destination after delivery-to override');
  assert.equal(dealer(data, 'st-james').stages.dealership.customer, 1, 'use yard bill-to category, not the production customer name');
  assert.equal(dealer(data, 'launceston').stages.transit.stock, 1);
  assert.deepEqual(buildDealerLogistics([...rows].reverse()), data, 'downstream evidence wins independently of row order');
});

test('second-hand and another dealer’s yard exclude stale upstream copies too', () => {
  const data = buildDealerLogistics([row('USED1', 'cn'), row('USED1', 'dealership', '', '', site('frankston', 'yard', 'second')),
    row('MOVED1', 'au'), row('MOVED1', 'dealership', '', '', site('traralgon', 'yard')),
    row('USED2', 'dealership', '', '', site('geelong', 'transit', 'second'))]);
  assert.equal(total(data), 0);
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
  assert.deepEqual(f.stages.dealership, { stock: 1, customer: 0, total: 1 });
});
