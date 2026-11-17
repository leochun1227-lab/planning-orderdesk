import test from 'node:test';
import assert from 'node:assert/strict';
import { JV_DEALERS, dealerList, dealerSnapshot, dealerNeeds, dealerMonthly } from '../lib/dealership.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';

const today = '2026-11-17';
const raw = { dealerConfigs: { bundaberg: { name: 'Bundaberg' }, heatherbrae: { name: 'Heatherbrae' },
  toowoomba: { name: 'Toowoomba' }, wangaratta: { name: 'Wangaratta' }, abco: { name: 'ABCO' },
  group: { name: 'Dealer group', isGroup: true }, closed: { name: 'Closed', isActive: false } }, yard: {}, pgi: {}, handover: {}, schedule: [] };
for (const d of JV_DEALERS) {
  raw.yard[d.slug] = { [`${d.slug}Y`]: { type: 'Stock', receivedAt: '2026-11-01', wholesaleBillToName: 'Other business' },
    [`${d.slug}C`]: { type: 'Customer', customer: 'Jane' }, [`${d.slug}U`]: { vehicleType: 'Second Hand' } };
  raw.pgi[`${d.slug}T`] = { dealer: d.name, customer: 'Dealer Stock', pgidate: '16/11/2026' };
  raw.handover[d.slug] = {};
  for (const [month, count] of [['08', 3], ['09', 6], ['10', 9], ['11', 1]]) for (let i = 0; i < count; i++) {
    const chassis = `${d.slug}H${month}${i}`;
    raw.handover[d.slug][chassis] = { handoverAt: `2026-${month}-10` };
    raw.schedule.push({ Chassis: chassis, Customer: 'Dealer Stock' });
  }
}
const row = (d, suffix, group, customer = 'Dealer Stock', extra = {}) => ({ id: `${d.slug}${suffix}`, chassis: `${d.slug}${suffix}`,
  dealer: d.name, group, model: 'SRC21', customer, signedAt: today, warnings: [], ...extra });
const build = (rows, dealers) => buildProductionLine({ board: { rows, completed: 0, averages: {} }, orders: {}, dealers,
  today, settings: {}, longtree: new Map(), prod: new Map(), portal: new Map(),
  auCapacity: new Map(Array.from({ length: 12 }, (_, i) => [`2026-11-${17 + i}`, { towable: 2, srm: 0, srv: 0 }])) });

test('the four named JV dealers have distinct identities and existing targets, without joining self-owned', () => {
  const list = dealerList(raw), jv = list.filter(d => d.jv);
  assert.deepEqual(jv.map(d => [d.name, d.target]), [['Bundaberg', 40], ['Heatherbrae', 40], ['Toowoomba', 35], ['Wangaratta', 25]]);
  assert.ok(jv.every(d => d.own === false && d.travelDays === 7));
  assert.equal(new Set(list.map(d => d.slug)).size, list.length, 'configured JV dealers are not duplicated');
  assert.equal(list.filter(d => d.own).length, 5);
  assert.ok(!list.some(d => ['group', 'closed'].includes(d.slug)));
  assert.equal(dealerSnapshot(raw, today).length, 5, 'the existing default remains the self-owned snapshot');
  assert.equal(dealerList({}).filter(d => d.jv).length, 4, 'the four requested dealers remain available without configs');
});

test('JV snapshot uses each dealer’s real yard, transit and last three full months of handovers', () => {
  const all = dealerSnapshot(raw, today, { all: true });
  for (const d of all.filter(d => d.jv)) {
    assert.deepEqual(d.yard, { stock: 1, customer: 1, second: 1, total: 3 });
    assert.equal(d.transit.stock, 1); assert.equal(d.vehicles.find(v => v.where === 'transit').arrive, '2026-11-23');
    assert.deepEqual(d.handover.months.map(m => m.stock), [3, 6, 9]);
    assert.equal(d.handover.avgStock, 6); assert.equal(d.handover.thisMonth.stock, 1);
  }
});

test('JV cards are generated from final production rows, while self-owned totals and stock top-up retain their scope', () => {
  const rows = JV_DEALERS.flatMap(d => [row(d, 'LINE', 'cn'), row(d, 'READY', 'transport'), row(d, 'CUSTOMER', 'customers', 'Jane'), row(d, 'STOCK', 'customers')]);
  const before = structuredClone(rows), dealers = dealerSnapshot(raw, today, { all: true }), snapshots = structuredClone(dealers);
  const out = build(rows, dealers);
  assert.equal(out.dealership.dealers.length, 5); assert.ok(out.dealership.dealers.every(d => !d.jv));
  assert.deepEqual(out.dealership.jvDealers.map(d => d.name), JV_DEALERS.map(d => d.name));
  assert.equal(out.counts.dealership, 0, 'JV yard stock does not inflate the self-owned Dealership tab');
  for (const d of out.dealership.jvDealers) {
    assert.equal(d.monthly.length, 8); assert.equal(d.lead, 10); assert.ok(d.monthly.every(m => m.stockIn !== null && m.endStock !== null)); assert.equal(d.pipelineStock, 1); assert.equal(d.customerPicked, 1);
    assert.equal(d.transit.stock, 2); assert.equal(d.transit.pgiStock, 1); assert.equal(d.transit.transportStock, 1);
    assert.equal(d.stockAvailable, 1); assert.equal(d.stockPicked, 0);
    assert.equal(out.rows.find(r => r.id === `${d.slug}STOCK`).group, 'customers');
    assert.equal(out.dealership.all.filter(a => a.slug === d.slug && a.jv).length, 1);
  }
  assert.deepEqual(rows, before); assert.deepEqual(dealers, snapshots, 'shared Portal snapshots are not changed');
});

test('missing transport days retain the monthly layout and sales estimate but leave arrivals, closing stock and need pending', () => {
  const d = { ...dealerSnapshot(raw, today, { all: true }).find(d => d.slug === 'bundaberg'), travelDays: null };
  const rows = [{ dealer: d.name, group: 'au', customer: 'Stock', auEnd: '2026-12-01' }];
  const [need] = dealerNeeds([d], rows, today, '2027-02-01');
  assert.equal(need.lead, null); assert.equal(need.deliveredBy, ''); assert.equal(need.need, null); assert.equal(need.projected, null);
  const months = dealerMonthly(d, rows, today);
  assert.deepEqual(months.map(m => m.month), ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
  assert.ok(months.every(m => m.stockIn === null && m.customerIn === null && m.endStock === null));
  assert.equal(months[0].stockOut, 2.8); assert.ok(months.slice(1).every(m => m.stockOut === 6));
});

test('once JV road days are supplied the same dispatch, monthly roll-forward and shortage formulas apply', () => {
  // Fixture road days exercise a month boundary; they are not business defaults.
  const d = { ...dealerSnapshot(raw, today, { all: true }).find(d => d.slug === 'bundaberg'), travelDays: 2,
    yard: { stock: 10 }, handover: { avgStock: 3 }, vehicles: [{ where: 'transit', category: 'stock', arrive: '2026-11-20' }] };
  const rows = [{ dealer: d.name, group: 'au', customer: 'Stock', auEnd: '2026-12-29' },
    { dealer: d.name, group: 'au', customer: 'Jane', auEnd: '2026-12-29' }];
  const [need] = dealerNeeds([d], rows, today, '2027-01-01');
  assert.equal(need.lead, 5); assert.equal(need.deliveredBy, '2027-01-06'); assert.equal(need.arriving, 1); assert.equal(need.transitArriving, 1);
  assert.equal(need.projected, 10 + 1 + 1 - need.sold); assert.equal(need.need, 40 - need.projected);
  const months = dealerMonthly(d, rows, today, 3);
  assert.deepEqual(months.map(m => [m.stockIn, m.customerIn]), [[1, 0], [0, 0], [1, 1]]);
  assert.deepEqual(months.map(m => m.endStock), [10, 7, 5]);
});
