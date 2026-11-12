import test from 'node:test';
import assert from 'node:assert/strict';
import { longtreeDate, parseLongtree, parseProdReport, stageOf, buildProductionLine, createProductionLineSource } from '../lib/production-line.mjs';

test('Longtree dates: Beijing epoch, dash/dot/compact text, whitespace; other text is a note', () => {
  assert.equal(longtreeDate([1787068800000]).date, '2026-08-19'); // 2026-08-18T16:00Z = Beijing midnight
  assert.equal(longtreeDate([{ text: '2026-10-14 00:00', type: 'text' }]).date, '2026-10-14');
  assert.equal(longtreeDate([{ text: '\n     \n2026.11.06\n \n ', type: 'text' }]).date, '2026-11-06');
  assert.equal(longtreeDate([{ text: '20250105', type: 'text' }]).date, '2025-01-05');
  assert.deepEqual(longtreeDate([{ text: '研发样车不发运', type: 'text' }]), { date: '', note: '研发样车不发运' });
  assert.deepEqual(longtreeDate(undefined), { date: '', note: '' });
});

test('Longtree records merge per chassis; the later row (序号) wins per field', () => {
  const m = parseLongtree([
    { fields: { 序号: '20', 车架号: 'SRC-254701', 总装上线日期: [{ text: '2025-11-02 00:00' }] } },
    { fields: { 序号: '10', 车架号: 'SRC254701', 车型: [{ text: 'SRC21' }], 总装上线日期: [{ text: '2025-10-01 00:00' }], 发运日期: [{ text: '展车不发运' }] } },
  ]);
  const r = m.get('SRC254701');
  assert.equal(r.assemblyAt, '2025-11-02'); assert.equal(r.model, 'SRC21'); assert.equal(r.notes.shippedAt, '展车不发运');
});

test('prodReport rows give location, station, flags and station time (Sydney)', () => {
  const m = parseProdReport([{ id: 'SRV265330', chassis: 'SRV265330', location: 'production', stage: 'Campervan', status: ['G', 'B'], entryDate: { _seconds: 1791781237 }, moveDate: { _seconds: 1793825067 }, stageHistory: [{ stage: 'campervan', location: 'production', enteredAt: { _seconds: 1793825067 } }] }]);
  const r = m.get('SRV265330');
  assert.equal(r.location, 'production'); assert.equal(r.station, 'Campervan'); assert.deepEqual(r.flags, ['G', 'B']);
  assert.equal(r.enteredAt, '2026-10-12'); assert.equal(r.stationSince.slice(0, 10), '2026-11-04');
});

test('stage: latest node wins; AU factory report counts before GR; future dates do not count', () => {
  const today = '2026-11-09', o = { signedAt: '2026-05-01' };
  assert.equal(stageOf(o, {}, undefined, {}, today).stage, 'cnWaiting');
  assert.equal(stageOf(o, { weldAt: '2026-06-01' }, undefined, {}, today).stage, 'cnWelding');
  assert.equal(stageOf(o, { weldAt: '2026-06-01', assemblyAt: '2026-06-10', finishedAt: '2026-07-01' }, undefined, {}, today).stage, 'cnFinished');
  assert.equal(stageOf(o, { shippedAt: '2026-07-02' }, undefined, {}, today).stage, 'cnShipped');
  assert.equal(stageOf(o, { shippedAt: '2026-07-02', etd: '2026-07-10' }, undefined, {}, today).stage, 'seaPort');
  assert.equal(stageOf(o, { shippedAt: '2026-07-02', atd: '2026-07-11', ata: '2026-12-01' }, undefined, {}, today).stage, 'seaOnWater');
  assert.equal(stageOf(o, { atd: '2026-07-11', ata: '2026-08-01' }, undefined, {}, today).stage, 'seaArrived');
  assert.equal(stageOf(o, { ata: '2026-08-01' }, { location: 'received', enteredAt: '2026-08-05' }, {}, today).stage, 'auFactory');
  assert.equal(stageOf(o, { ata: '2026-08-01' }, undefined, { grAt: '2026-08-06' }, today).stage, 'auFactory');
  assert.equal(stageOf(o, {}, { location: 'transport' }, { grAt: '2026-08-06', giAt: '2026-11-01' }, today).stage, 'gi');
});

const fakeBoard = rows => Promise.resolve({ DEFAULT_BOARD_SETTINGS: { cnDays: 20 }, boardVehiclesFromSources: () => [], sortBoardRows: r => r, buildProductionBoard: () => ({ rows, completed: 7, averages: { cn: { days: 30, count: 3 } } }) });
const portalCopy = (raw = { datetrack: {}, pgi: {} }) => ({ calls: 0, async current() { this.calls++; return { at: '2026-11-09T00:00:00Z', raw, error: '' }; } });

test('line = Portal board rows (groups, plan dates kept) plus live facts and the Orderdesk order', () => {
  const board = { completed: 5, averages: {}, rows: [
    { id: 'chassis-SRC1', chassis: 'SRC1', group: 'au', line: 'Towable', planStart: '2026-10-26', planEnd: '2026-12-05', expectedEnd: '2026-12-05', delay: 0, cnMrp: '2025-09-17', auMrp: '2026-10-21', production: { status: '', stage: 'Final', location: 'qc' }, warnings: [] },
    { id: 'slot-1', chassis: '', empty: true, group: 'empty', line: 'SRM', warnings: [] },
  ] };
  const r = buildProductionLine({ board, orders: { SRC1: { chassis: 'SRC-1', customer: 'Smith', status: 'active', signedAt: '2025-01-01' } }, longtree: new Map([['SRC1', { weldAt: '2025-09-22' }]]), prod: new Map([['SRC1', { location: 'qc', station: 'Qc Red Zone', flags: ['G'], stationSince: '2026-11-01T00:00:00Z', history: [] }]]), portal: new Map([['SRC1', { grAt: '2026-10-10', giAt: '' }]]), today: '2026-11-09' });
  assert.deepEqual(r.counts.au, 1); assert.ok(!r.counts.empty, 'Portal SRV / SRM empty slots are not shown'); assert.equal(r.completed, 5);
  const a = r.rows[0];
  assert.equal(a.auMrp, '2026-10-21'); assert.equal(a.customer, 'Smith'); assert.equal(a.orderId, 'SRC1');
  assert.equal(a.live.stage, 'auFactory'); assert.equal(a.live.station, 'Qc Red Zone'); assert.equal(a.live.daysAtStation, 8); assert.equal(a.live.grAt, '2026-10-10');
  assert.equal(r.rows.length, 1);
});

test('sources: unconfigured sources are reported; the Portal board is built from the shared copy; GR/GI only from SAP', async () => {
  const portal = portalCopy({ datetrack: { x: { 'Chassis Number': 'SRC1', 'Received in Melbourne': '01/02/2026' } }, pgi: {} });
  const src = createProductionLineSource({}, { fetcher: async () => { throw new Error('no network'); }, portal, board: fakeBoard([{ id: 'a', chassis: 'SRC1', group: 'sea' }]) });
  const r = await src.current({ today: '2026-11-09' });
  assert.equal(r.status.longtree.error, 'not configured'); assert.equal(r.status.prod.error, 'not configured');
  assert.equal(r.board.rows.length, 1); assert.equal(r.board.completed, 7); assert.equal(r.portal.size, 0); assert.equal(r.status.sap.error, 'not configured');
  await src.current({ today: '2026-11-09' }); assert.equal(portal.calls, 2); // the shared copy decides when to download
});
