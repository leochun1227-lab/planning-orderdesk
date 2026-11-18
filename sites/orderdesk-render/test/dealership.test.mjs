import test from 'node:test';
import assert from 'node:assert/strict';
import { dealerSnapshot, dealerNeeds, pickRolling, yardCategory, dayOf, isStockCustomer } from '../lib/dealership.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';

const raw = {
  yard: {
    traralgon: {
      'dealer-chassis': {},
      SRC1: { model: 'SRC21', wholesaleBillToName: 'Regent RV Pty Ltd', receivedAt: '2026-10-01T02:00:00Z' },
      SRC2: { model: 'SRC21', wholesaleBillToName: 'John Smith' },
      USED1: { model: 'Z19199901', vehicleType: 'Second Hand' },
      OLD: { model: 'SRC21', history: true },
    },
    geelong: { SRT9: { model: 'SRT19', wholesaleBillToName: 'Snowy River' } },
  },
  pgi: {
    SRT5: { dealer: 'Traralgon', pgidate: '01/11/2026', customer: 'Traralgon Stock' },
    SRT6: { dealer: 'Traralgon', pgidate: '01/05/2026', customer: 'Traralgon Stock' }, // older than 100 days
    SRT9: { dealer: 'Traralgon', pgidate: '01/11/2026', customer: 'Stock' }, // already in a yard (Geelong)
    SRT7: { dealer: 'Geelong', pgidate: '10/11/2026', customer: 'Stock' }, // delivery-to override → Traralgon
    SRT8: { dealer: 'Traralgon', pgidate: '10/11/2026', customer: 'Stock' }, // already handed over
  },
  deliveryTo: { SRT7: { deliveryTo: 'Traralgon' } },
  schedule: [{ Chassis: 'H1', Customer: 'Traralgon Stock' }, { Chassis: 'H2', Customer: 'Jane Doe' }],
  handover_traralgon: {
    H1: { handoverAt: '2026-08-05' }, H2: { handoverAt: '2026-09-03' }, H3: { handoverAt: '2026-10-09' }, H4: { handoverAt: '2026-10-20', materialCode: 'Z19199901' },
    H5: { handoverAt: '2026-11-02' }, SRT8: { handoverAt: '2026-11-12' },
  },
};

test('production Stock classification uses only the case-insensitive customer-name suffix; Dealership keeps its own categories', () => {
  for (const name of ['Stock', 'STOCK', 'StOcK', 'Frankston Stock', 'Alex / stock', 'livestock', ' stock ']) assert.equal(isStockCustomer(name), true, name);
  for (const name of ['', null, undefined, 'Stock / Alex', 'Stockton', 'Alex Stock extra', 'Alex Stock.']) assert.equal(isStockCustomer(name), false, String(name));
  assert.equal(yardCategory({ customer: 'Dealer Stock', wholesaleBillToName: 'Alex Smith' }), 'customer');
  assert.equal(yardCategory({ customer: 'Alex Smith', wholesaleBillToName: 'Regent RV' }), 'stock');
  assert.equal(yardCategory({ customer: 'Dealer Stock', vehicleType: 'Second Hand' }), 'second');
});

test('dealership snapshot follows the Dealer Portal admin page and handover dashboard', () => {
  const snap = dealerSnapshot(raw, '2026-11-16');
  const t = snap.find(d => d.slug === 'traralgon');
  assert.deepEqual(t.yard, { stock: 1, customer: 1, second: 1, total: 3 });
  assert.deepEqual(t.vehicles.filter(v => v.where === 'transit').map(v => v.chassis).sort(), ['SRT5', 'SRT7']);
  assert.deepEqual(t.handover.months.map(m => m.month), ['2026-08', '2026-09', '2026-10'], 'the last three completed months');
  assert.deepEqual(t.handover.months.map(m => [m.stock, m.customer, m.second]), [[1, 0, 0], [0, 1, 0], [1, 0, 1]], 'stock / customer by the Orderlist customer name; not in the Orderlist = stock');
  assert.equal(t.handover.avgStock, 0.7);
  assert.equal(yardCategory({ customer: 'Frankston Stock' }, false), 'stock');
  assert.equal(dayOf('05/12/2025'), '2025-12-05');
});

test('need = target − (yard + transit + stock vans arriving by then (AU finish + 3 + travel days) − average stock handovers)', () => {
  const snap = [{ slug: 'frankston', target: 50, travelDays: 1, yard: { stock: 20 }, transit: { stock: 3 }, handover: { avgStock: 10 }, vehicles: [{ where: 'transit', category: 'stock', arrive: '2026-11-16' }, { where: 'transit', category: 'stock', arrive: '2026-11-20' }, { where: 'transit', category: 'stock', arrive: '2027-03-01' }] },
    { slug: 'traralgon', target: 25, travelDays: null, paused: true, yard: { stock: 17 }, transit: { stock: 4 }, handover: { avgStock: 6 } }];
  const rows = [
    { dealer: 'Frankston', group: 'transport', customer: 'Frankston Stock' }, // Transport: counted as transit (withTransport), not here
    { dealer: 'Frankston', group: 'au', auEnd: '2027-01-10', customer: 'Frankston Stock' }, // there 2027-01-14
    { dealer: 'Frankston', group: 'locked', auEnd: '2027-02-27', customer: 'Frankston Stock' }, // there 2027-03-03: after the date
    { dealer: 'Frankston', group: 'later', customer: 'Frankston Stock' }, { dealer: 'Frankston', group: 'au', auEnd: '2026-12-01', customer: 'Bob' }];
  const [f, t] = dealerNeeds(snap, rows, '2026-11-16', '2027-02-12'); // rolling ends 2027-02-12 → Frankston gets it 2027-02-16
  assert.equal(f.deliveredBy, '2027-02-16'); assert.equal(f.lead, 4);
  assert.equal(f.pipelineStock, 2); assert.equal(f.arriving, 1); assert.equal(f.pipelineCustomer, 1);
  assert.equal(f.transitArriving, 2, 'transit counted only when it arrives by then');
  assert.equal(f.sold, 30, '10 a month × 3 months'); assert.equal(f.projected, 20 + 2 + 1 - 30); assert.equal(f.need, 50 - (20 + 2 + 1 - 30));
  assert.equal(t.paused, true); assert.equal(t.need, 0, 'Traralgon is not calculated for now');
});

test('rolling line: all dealers’ named customer orders without stock top-up or a count cutoff', () => {
  const r = (chassis, dealer, customer, orderRow) => ({ chassis, dealer, customer, orderRow, group: 'later', signedAt: '2026-10-01', forecast: '' });
  const rows = [r('S1', 'Traralgon', 'Traralgon Stock', 5), r('C2', 'Frankston', 'Bob', 9), r('C1', 'ST James', 'Ann', 7), r('X1', 'Wangaratta', 'Zed', 1), r('S2', 'Traralgon', 'Traralgon Stock', 6), r('S3', 'Geelong', 'Geelong Stock', 2)];
  const out = pickRolling(rows, [{ slug: 'traralgon', need: 1 }, { slug: 'geelong', need: 0 }], 180);
  assert.deepEqual(out.customerCandidates.map(p => p.r.chassis), ['X1', 'C1', 'C2']);
  assert.deepEqual(pickRolling(rows, [{ slug: 'traralgon', need: 5 }], 2).customerCandidates.map(p => p.r.chassis), ['X1', 'C1', 'C2'], 'candidate collection does not select orders or top up Stock');
});

test('production line: Dealership group first and customer orders stay in the pool', () => {
  const row = (id, group, extra = {}) => ({ id, chassis: id, group, signedAt: '2026-10-01', cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', locked: false, warnings: [], ...extra });
  const board = { rows: [row('L1', 'later', { dealer: 'Frankston', customer: 'Bob' }), row('L2', 'later', { dealer: 'Wangaratta', customer: 'Zed' }), row('A1', 'au', { dealer: 'Geelong' })], completed: 0, averages: {} };
  const dealers = dealerSnapshot(raw, '2026-11-16');
  const cap = new Map([['2026-11-17', { towable: 1, srm: 0, srv: 0 }], ['2026-11-18', { towable: 1, srm: 0, srv: 0 }]]);
  const out = buildProductionLine({ board, orders: {}, longtree: new Map(), prod: new Map([['A1', { location: 'qc' }]]), portal: new Map([['A1', { grAt: '2026-10-01' }]]), today: '2026-11-16', settings: {}, dealers, auCapacity: cap });
  const by = Object.fromEntries(out.rows.filter(r => r.group !== 'dealership').map(r => [r.chassis, r]));
  assert.equal(by.L1.group, 'customers'); assert.equal(by.L2.group, 'customers'); assert.equal(out.counts.later, 0);
  assert.equal(by.A1.auEnd, '2026-11-17'); assert.equal(by.L1.auEnd, '', 'pool orders do not consume available capacity');
  assert.equal(out.rows[0].group, 'dealership');
  assert.equal(out.counts.dealership, 2, 'tab count = new stock in the five yards (Traralgon 1 + Geelong 1)');
  assert.equal(out.dealership.dealers.find(d => d.slug === 'frankston').customerPicked, 0);
});

test('month by month: arrivals at AU finish + 3 + travel days (12-29 + 4 → January), stock handovers at the average, stock at month end', async () => {
  const { dealerMonthly } = await import('../lib/dealership.mjs');
  const d = { slug: 'geelong', travelDays: 1, yard: { stock: 10 }, handover: { avgStock: 3 }, vehicles: [{ where: 'transit', category: 'stock', arrive: '2026-11-17' }, { where: 'transit', category: 'customer', arrive: '2026-11-18' }, { where: 'transit', category: 'stock', arrive: '2026-12-02' }] };
  const rows = [{ dealer: 'Geelong', group: 'au', auEnd: '2026-11-20', customer: 'Geelong Stock' }, { dealer: 'Geelong', group: 'sea', auEnd: '2026-12-29', customer: 'Bob' }, { dealer: 'Frankston', group: 'au', auEnd: '2026-11-20', customer: 'Frankston Stock' }];
  const m = dealerMonthly(d, rows, '2026-11-16', 3);
  assert.deepEqual(m.map(x => x.month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(m.map(x => [x.stockIn, x.customerIn]), [[2, 1], [1, 0], [0, 1]], 'transit by its own arrival day');
  assert.equal(m[0].stockOut, 1.5, 'this month: only the days left (15 of 30)');
  assert.deepEqual(m.map(x => x.endStock), [11, 9, 6], '10 + 2 − 1.5 = 10.5; + 1 − 3 = 8.5; − 3 = 5.5');
});

test('transit arrives PGI + travel days; overdue counts as today; Traralgon not calculated', async () => {
  const { transitArrival } = await import('../lib/dealership.mjs');
  assert.equal(transitArrival('2026-11-10', { travelDays: 20 }, '2026-11-16'), '2026-11-30');
  assert.equal(transitArrival('2026-11-10', { travelDays: 1 }, '2026-11-16'), '2026-11-16');
  assert.equal(transitArrival('2026-11-10', { travelDays: null }, '2026-11-16'), '');
});

test('Transport vans join the dealer\'s transit: AU finish = today, + 3 + travel days', async () => {
  const { withTransport } = await import('../lib/dealership.mjs');
  const snap = [{ slug: 'st-james', travelDays: 20, target: 60, yard: { stock: 1 }, transit: { stock: 2, customer: 0, second: 0, total: 2 }, vehicles: [], handover: { avgStock: 1 } }];
  const rows = [{ group: 'transport', dealer: 'ST James', chassis: 'T1', customer: 'St James Stock', live: { stationSince: '2026-11-10T01:00:00Z' } }, { group: 'transport', dealer: 'ST James', chassis: 'T2', customer: 'Ann' }, { group: 'au', dealer: 'ST James', chassis: 'A1', customer: 'St James Stock' }];
  const [d] = withTransport(snap, rows, '2026-11-16');
  assert.deepEqual(d.transit, { stock: 3, customer: 1, second: 0, total: 4, pgiStock: 2, transportStock: 1, transportCustomer: 1 });
  assert.equal(d.vehicles.find(v => v.chassis === 'T1').arrive, '2026-12-09');
  assert.equal(snap[0].vehicles.length, 0, 'the cached snapshot is not changed');
});
