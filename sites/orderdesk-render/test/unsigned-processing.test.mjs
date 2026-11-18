import test from 'node:test';
import assert from 'node:assert/strict';
import { signedPlansDate } from '../lib/order-signoff.mjs';
import { BOARD_GROUPS, buildProductionLine, createProductionLineSource } from '../lib/production-line.mjs';
import { dealerSnapshot, pickRolling } from '../lib/dealership.mjs';
import { buildDealerLogistics } from '../lib/dealer-logistics.mjs';

const today = '2026-11-17';
const row = (chassis, group = 'customers', extra = {}) => ({ id: chassis, chassis, group, dealer: 'Frankston',
  customer: 'Jane', model: 'SRC21', warnings: [], cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', ...extra });
const build = (rows, extra = {}) => buildProductionLine({ board: { rows, completed: 0, averages: {} }, orders: {},
  longtree: new Map(), prod: new Map(), portal: new Map(), settings: {}, today, ...extra });
const byChassis = out => Object.fromEntries(out.rows.map(r => [r.chassis, r]));

test('sign-off requires an actual receipt date; status, PO, invalid and future dates do not count', () => {
  for (const value of [null, '', 'No', 'Yes', true, false, 'Signoff', 'ASAP', '2026-02-30', '2026-13-01', '2026-11-18']) {
    assert.equal(signedPlansDate([value], today), '', String(value));
  }
  for (const value of ['2026-11-17', '2026-11-17T02:00:00Z', '17/11/2026', new Date('2026-11-17T00:00:00Z')]) {
    assert.equal(signedPlansDate([value], today), today);
  }
  const serial = (Date.parse(`${today}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(signedPlansDate([serial], today), today);
  assert.equal(signedPlansDate(['No', today], today), today);
  assert.equal(build([row('PO')], { orders: { PO: { chassis: 'PO', purchaseAt: today, productionStatus: 'Signoff' } } }).rows[0].group, 'processing');
});

test('unsigned Customer and Stock leave rolling and the pool for processing; pool is renamed and tab order is stable', () => {
  const rows = ['rolling', 'customers', 'later'].flatMap((group, i) => [
    row(`C${i}`, group), row(`S${i}`, group, { customer: 'Frankston sToCk' }),
  ]);
  const out = build([...rows, row('SIGNEDC', 'customers', { signedAt: today }),
    row('SIGNEDS', 'rolling', { customer: 'Stock', signedAt: today })]);
  assert.deepEqual(out.rows.filter(r => r.group === 'processing').map(r => r.chassis).sort(), rows.map(r => r.chassis).sort());
  assert.equal(out.counts.processing, 6); assert.equal(out.counts.rolling, 0); assert.equal(out.counts.customers, 2);
  assert.equal(byChassis(out).SIGNEDC.group, 'customers'); assert.equal(byChassis(out).SIGNEDS.group, 'customers');
  const pool = BOARD_GROUPS.findIndex(g => g.id === 'customers');
  assert.equal(BOARD_GROUPS[pool].zh, '库存订单池'); assert.equal(BOARD_GROUPS[pool + 1].id, 'processing');
  assert.equal(BOARD_GROUPS[pool + 1].zh, '处理中订单'); assert.ok(!BOARD_GROUPS.some(g => g.id === 'empty'));
  const pick = pickRolling(rows, [{ slug: 'frankston', need: 10 }]);
  assert.equal(pick.picked.length, 0); assert.equal(pick.stockAvailable.frankston, 0);
});

test('signing moves orders into the pool without booking rolling capacity', () => {
  const rows = [row('UC', 'rolling'), row('US', 'customers', { customer: 'Stock' }),
    row('SC', 'customers', { signedAt: today }), row('SS', 'customers', { customer: 'Stock', signedAt: today })];
  const orders = Object.fromEntries(rows.map((r, i) => [r.chassis, { chassis: r.chassis, slotRow: i + 1 }]));
  const original = structuredClone(rows);
  const extras = { orders, dealers: dealerSnapshot({ yard: {} }, today), rollingSize: 2,
    auCapacity: new Map([today, '2026-11-18', '2026-11-19'].map(d => [d, { towable: 1, srm: 0, srv: 0 }])) };
  const before = build(rows, extras), b = byChassis(before);
  assert.equal(b.UC.group, 'processing'); assert.equal(b.US.group, 'processing');
  assert.equal(b.UC.auEnd, ''); assert.equal(b.US.auForecast, undefined);
  assert.equal(b.SC.auEnd, ''); assert.equal(b.SS.auEnd, '');
  assert.equal(before.dealership.customers, 0); assert.equal(before.dealership.picked, 0);
  const f = before.dealership.dealers.find(d => d.slug === 'frankston');
  assert.equal(f.stockAvailable, 1); assert.equal(f.stockPicked, 0);
  assert.equal(f.monthly.reduce((n, m) => n + m.stockIn + m.customerIn, 0), 0);
  orders.UC.signedAt = today; orders.US.signedAt = today;
  const after = build(rows, extras), a = byChassis(after);
  assert.equal(after.counts.processing, 0); assert.equal(after.dealership.customers, 0);
  assert.equal(a.UC.group, 'customers'); assert.equal(a.UC.auEnd, ''); assert.equal(a.SC.auEnd, '');
  assert.equal(a.US.group, 'customers'); assert.equal(a.SS.group, 'customers');
  assert.equal(a.UC.id, b.UC.id); assert.equal(new Set(after.rows.map(r => r.id)).size, after.rows.length);
  assert.deepEqual(rows, original, 'recomputation does not mutate cached Portal board rows');
});

test('unsigned vehicles in the locked plan, actual production, shipping and dealerships retain their downstream groups', () => {
  const rows = ['LOCK', 'CN', 'SEA', 'AU', 'TRANSPORT'].map(c => row(c, 'rolling'));
  const plan = { activeUntil: '2026-12-31', rows: [], byChassis: new Map([['LOCK', { order: 1, months: [], weldPlan: '' }]]) };
  const out = build(rows, { plan, longtree: new Map([['CN', { weldAt: '2026-11-16' }]]),
    tms: new Map([['SEA', { container: 'C1', voyage: 'V1' }]]),
    portal: new Map([['AU', { grAt: today }], ['TRANSPORT', { grAt: today }]]),
    prod: new Map([['TRANSPORT', { location: 'transport' }]]),
    dealers: dealerSnapshot({ yard: { frankston: { YARD: { wholesaleBillToName: 'Regent RV' } } } }, today) });
  const by = byChassis(out);
  for (const [c, group] of Object.entries({ LOCK: 'locked', CN: 'cn', SEA: 'sea', AU: 'au', TRANSPORT: 'transport', YARD: 'dealership' })) {
    assert.equal(by[c].group, group);
  }
  assert.equal(out.counts.processing, 0);
});

test('Portal signature dates survive the board adapter for Towable, campers and motorhome orders', async () => {
  let at = 'copy-1';
  const raw = { schedule: [{ Chassis: 'SRC-1', 'Signed Plans Received': '16/11/2026' }],
    campers: { two: { chassisNumber: 'SRV-1', signedOrderReceived: '2026-11-15' } },
    motorhome: { orders: [{ chassis: 'SRM1', signedOffDate: '2026-11-14' }, { chassis: 'SRM2', signedOffDate: 'No' }] } };
  const rows = ['SRC1', 'SRV1', 'SRM1', 'SRM2', 'CRM1'].map(c => row(c));
  const board = Promise.resolve({ DEFAULT_BOARD_SETTINGS: {}, boardVehiclesFromSources: () => [], sortBoardRows: r => r,
    buildProductionBoard: () => ({ rows, completed: 0, averages: {} }) });
  const src = createProductionLineSource({}, { portal: { current: async () => ({ at, raw }) }, board });
  const sources = await src.current({ today });
  assert.deepEqual(sources.board.rows.map(r => r.signedAt), ['2026-11-16', '2026-11-15', '2026-11-14', '', '']);
  const orders = { CRM1: { chassis: 'CRM1', signedAt: today }, SRC1: { chassis: 'SRC1', signedAt: null } };
  const first = byChassis(buildProductionLine({ ...sources, orders, today }));
  for (const c of ['SRC1', 'CRM1']) assert.equal(first[c].group, 'customers');
  assert.equal(first.SRM2.group, 'processing'); for (const c of ['SRV1', 'SRM1']) assert.equal(first[c].group, 'later');
  raw.motorhome.orders[1].signedOffDate = today; at = 'copy-2';
  const refreshed = await src.current({ today });
  assert.equal(byChassis(buildProductionLine({ ...refreshed, orders, today })).SRM2.group, 'later');
  assert.ok(rows.every(r => r.signedAt === undefined), 'adapter does not mutate the bundled board');
});

test('deleted Towable plan has no synthetic rows; processing remains in all-order logistics filters', () => {
  const out = build([row('SRM270001'), row('SRC270001', 'rolling', { customer: 'Frankston Stock' }),
    row('SIGNED', 'customers', { signedAt: today })], {
    buildPlan: { months: [], rows: [{ id: 'ghost', date: today, month: '2026-11', seq: 1, day: 1, perDay: 1 }] },
    auCapacity: new Map([[today, { towable: 1, srm: 1, srv: 0 }]]) });
  assert.equal(out.rows.length, 3); assert.ok(out.rows.every(r => !r.empty && !r.build));
  assert.ok(!Object.hasOwn(out.counts, 'empty')); assert.equal(byChassis(out).SIGNED.auEnd, '');
  const flow = buildDealerLogistics(out.rows, { today });
  const f = flow.dealers.find(d => d.slug === 'frankston');
  assert.equal(f.stages.processing.total, 2); assert.equal(f.stages.processing.customer, 1); assert.equal(f.stages.processing.stock, 1);
  assert.equal(f.byVehicle.motorised.processing.customer, 1); assert.equal(f.byVehicle.towable.processing.stock, 1);
  assert.equal(f.stages.pool.total, 1); assert.equal(f.stages.rolling.total, 0);
  assert.equal(flow.dealers.reduce((n, d) => n + Object.values(d.stages).reduce((m, s) => m + s.total, 0), 0), 3);
  assert.deepEqual(f.stages.processing.stockMonths, {}); assert.equal(f.stages.processing.stockUndated, 1);
  const duplicate = buildDealerLogistics([...out.rows, row('SRC270001', 'transport', { customer: 'Stock' })]);
  const d = duplicate.dealers.find(d => d.slug === 'frankston');
  assert.equal(d.stages.processing.total, 1); assert.equal(d.stages.transport.stock, 1);
});
