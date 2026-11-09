import test from 'node:test';
import assert from 'node:assert/strict';
import { longtreeDate, parseLongtree, parseProdReport, parsePortal, stageOf, buildProductionLine, createProductionLineSource } from '../lib/production-line.mjs';

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

test('Portal GR/GI: dd/mm/yyyy, 01/01/1970 placeholders ignored, SAP GR as fallback', () => {
  const m = parsePortal({ a: { 'Chassis Number': 'SRC-1', 'Received in Melbourne': '30/04/2025', GRPURCHASEORDER: '01/01/1970' }, b: { 'Chassis Number': 'SRC2', 'Received in Melbourne': '01/01/1970' } }, { SRC1: { pgidate: '05/05/2025' }, SRC2: { pgidate: '<NA>', grDateLast: '12/10/2026' } });
  assert.deepEqual(m.get('SRC1'), { grAt: '2025-04-30', giAt: '2025-05-05' });
  assert.deepEqual(m.get('SRC2'), { grAt: '2026-10-12', giAt: '' });
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

test('line: unsigned and cancelled orders left out; GI listed only when recent; counts cover all', () => {
  const orders = {
    A: { chassis: 'A', status: 'active' }, B: { chassis: 'B', status: 'cancelled', signedAt: '2026-01-01' },
    C: { chassis: 'C', status: 'active', signedAt: '2026-01-01' }, D: { chassis: 'D', status: 'completed', signedAt: '2025-01-01' }, E: { chassis: 'E', status: 'completed', signedAt: '2026-01-01' },
  };
  const portal = new Map([['D', { grAt: '2025-03-01', giAt: '2025-04-01' }], ['E', { grAt: '2026-10-01', giAt: '2026-11-05' }]]);
  const r = buildProductionLine({ orders, longtree: new Map(), prod: new Map(), portal, today: '2026-11-09' });
  assert.equal(r.unsigned, 1); assert.equal(r.counts.gi, 2); assert.equal(r.counts.cnWaiting, 1);
  assert.deepEqual(r.rows.map(x => x.id), ['E', 'C']);
});

test('sources: unconfigured sources are reported, a failed refresh keeps the last good copy', async () => {
  let fail = false;
  const fetcher = async url => { if (fail) throw new Error('down'); return new Response(JSON.stringify(url.includes('datetrack') ? { x: { 'Chassis Number': 'SRC1', 'Received in Melbourne': '01/02/2026' } } : {}), { status: 200 }); };
  const src = createProductionLineSource({}, { fetcher, ttlMs: 0 });
  let r = await src.current();
  assert.equal(r.status.longtree.error, 'not configured'); assert.equal(r.portal.get('SRC1').grAt, '2026-02-01');
  fail = true; r = await src.current({ force: true });
  fail = false; const quick = await src.current(); assert.equal(typeof quick.refreshing, 'boolean');
  assert.match(r.status.portal.error, /down/); assert.equal(r.portal.get('SRC1').grAt, '2026-02-01');
});
