import test from 'node:test';
import assert from 'node:assert/strict';
import { dealerSnapshot, dealerNeeds, pickRolling, yardCategory, dayOf } from '../lib/dealership.mjs';
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

test('need = target − (yard + transit + stock on the line − average stock handovers until delivery)', () => {
  const snap = [{ slug: 'traralgon', target: 25, yard: { stock: 17 }, transit: { stock: 4 }, handover: { avgStock: 6 } }];
  const rows = [{ dealer: 'Traralgon', group: 'sea', customer: 'Traralgon Stock' }, { dealer: 'Traralgon', group: 'later', customer: 'Traralgon Stock' }, { dealer: 'Traralgon', group: 'au', customer: 'Bob' }];
  const [n] = dealerNeeds(snap, rows, '2026-11-16', '2027-05-16');
  assert.equal(n.pipelineStock, 1); assert.equal(n.sold, 36); assert.equal(n.projected, 17 + 4 + 1 - 36); assert.equal(n.need, 25 - (17 + 4 + 1 - 36));
});

test('rolling line: the five dealerships’ customer orders first, then their stock need; others stay out', () => {
  const r = (chassis, dealer, customer, orderRow) => ({ chassis, dealer, customer, orderRow, group: 'later', forecast: '' });
  const rows = [r('S1', 'Traralgon', 'Traralgon Stock', 5), r('C2', 'Frankston', 'Bob', 9), r('C1', 'ST James', 'Ann', 7), r('X1', 'Wangaratta', 'Zed', 1), r('S2', 'Traralgon', 'Traralgon Stock', 6), r('S3', 'Geelong', 'Geelong Stock', 2)];
  const out = pickRolling(rows, [{ slug: 'traralgon', need: 1 }, { slug: 'geelong', need: 0 }], 180);
  assert.deepEqual(out.picked.map(p => p.r.chassis), ['C1', 'C2', 'S1']);
  assert.deepEqual(pickRolling(rows, [{ slug: 'traralgon', need: 5 }], 2).picked.map(p => p.r.chassis), ['C1', 'C2'], 'at most the rolling size, customers first');
});

test('production line: Dealership group first, rolling after locked, every other open order in the Customer pool', () => {
  const row = (id, group, extra = {}) => ({ id, chassis: id, group, cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', locked: false, warnings: [], ...extra });
  const board = { rows: [row('L1', 'later', { dealer: 'Frankston', customer: 'Bob' }), row('L2', 'later', { dealer: 'Wangaratta', customer: 'Zed' }), row('A1', 'au', { dealer: 'Geelong' })], completed: 0, averages: {} };
  const dealers = dealerSnapshot(raw, '2026-11-16');
  const cap = new Map([['2026-11-17', { towable: 1, srm: 0, srv: 0 }], ['2026-11-18', { towable: 1, srm: 0, srv: 0 }]]);
  const out = buildProductionLine({ board, orders: {}, longtree: new Map(), prod: new Map([['A1', { location: 'qc' }]]), portal: new Map([['A1', { grAt: '2026-10-01' }]]), today: '2026-11-16', settings: {}, dealers, auCapacity: cap });
  const by = Object.fromEntries(out.rows.filter(r => r.group !== 'dealership').map(r => [r.chassis, r]));
  assert.equal(by.L1.group, 'rolling'); assert.equal(by.L2.group, 'customers'); assert.equal(out.counts.later, 0);
  assert.equal(by.A1.auEnd, '2026-11-17'); assert.equal(by.L1.auEnd, '2026-11-18', 'rolling continues after the cars ahead');
  assert.equal(out.rows[0].group, 'dealership');
  assert.equal(out.counts.dealership, 2, 'tab count = new stock in the five yards (Traralgon 1 + Geelong 1)');
  assert.equal(out.dealership.dealers.find(d => d.slug === 'frankston').customerPicked, 1);
});

test('month by month: arrivals at AU finish + 21 days, stock handovers at the average, stock at month end', async () => {
  const { dealerMonthly } = await import('../lib/dealership.mjs');
  const d = { slug: 'traralgon', yard: { stock: 10 }, handover: { avgStock: 3 }, vehicles: [{ where: 'transit', category: 'stock' }, { where: 'transit', category: 'customer' }] };
  const rows = [{ dealer: 'Traralgon', group: 'au', auEnd: '2026-11-20', customer: 'Traralgon Stock' }, { dealer: 'Traralgon', group: 'sea', auEnd: '2026-12-25', customer: 'Bob' }, { dealer: 'Geelong', group: 'au', auEnd: '2026-11-20', customer: 'Geelong Stock' }];
  const m = dealerMonthly(d, rows, '2026-11-16', 3);
  assert.deepEqual(m.map(x => x.month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(m.map(x => [x.stockIn, x.customerIn]), [[1, 1], [1, 0], [0, 1]]);
  assert.equal(m[0].stockOut, 1.5, 'this month: only the days left (15 of 30)');
  assert.deepEqual(m.map(x => x.endStock), [10 + 1 - 1.5, 10 + 1 - 1.5 + 1 - 3, 10 + 1 - 1.5 + 1 - 3 - 3].map(Math.round));
});
