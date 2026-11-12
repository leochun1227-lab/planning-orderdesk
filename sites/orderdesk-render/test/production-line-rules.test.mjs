import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFor, regentStatus, longtreeProgress, issuesFor, sortLineRows, datesForGroup } from '../lib/production-line.mjs';

const today = '2026-11-11';
test('GR always means AU production; shipped without GR means shipping', () => {
  assert.equal(groupFor({ chassis: 'X', group: 'sea' }, {}, { grAt: '2026-10-01' }, today), 'au');
  assert.equal(groupFor({ chassis: 'X', group: 'rolling' }, {}, { grAt: '2026-10-01' }, today), 'au');
  assert.equal(groupFor({ chassis: 'X', group: 'au' }, { ata: '2026-09-30' }, {}, today), 'sea');
  assert.equal(groupFor({ chassis: 'X', group: 'au' }, { ata: '2026-09-30' }, {}, today, { location: 'production' }), 'au', 'in the factory without GR is AU');
  assert.equal(groupFor({ chassis: 'X', group: 'sea' }, { ata: '2026-10-29' }, {}, today, { location: 'received' }), 'au');
  assert.equal(groupFor({ chassis: 'X', group: 'cn' }, { shippedAt: '2026-11-09' }, {}, today), 'sea');
  assert.equal(groupFor({ chassis: 'X', group: 'cn' }, { shippedAt: '2026-12-09' }, {}, today), 'cn', 'a future ship date is not shipped');
  assert.equal(groupFor({ chassis: 'X', group: 'locked' }, { weldAt: '2026-11-01' }, {}, today), 'locked');
  assert.equal(groupFor({ empty: true, group: 'empty' }, {}, {}, today), 'empty');
});
test('Regent status order, with PO / signoff for a blank CRM status', () => {
  assert.equal(regentStatus({ productionStatus: 'Finished' }).rank, 0);
  assert.equal(regentStatus({ productionStatus: 'Van on the sea' }).rank, 4);
  assert.deepEqual(regentStatus({ productionStatus: '', purchaseAt: '2026-01-01' }), { label: 'PO sent to LT', rank: 6, phase: 'pre', derived: true });
  assert.equal(regentStatus({ productionStatus: '', signedAt: '2026-01-01' }).label, 'Signoff');
});
test('Longtree progress: furniture before welding, ETD / ETA count once set', () => {
  assert.equal(longtreeProgress({ furnitureAt: '2026-01-01', weldAt: '2026-01-05' }, today).field, 'weldAt');
  assert.equal(longtreeProgress({ shippedAt: '2026-10-01', etd: '2026-12-01' }, today).field, 'etd');
  assert.equal(longtreeProgress({ shippedAt: '2026-10-01', atd: '2026-12-01' }, today).field, 'shippedAt', 'a future actual date does not count');
  assert.ok(longtreeProgress({ eta: '2026-12-01', atd: '2026-11-01' }, today).rank > longtreeProgress({ atd: '2026-11-01' }, today).rank);
});
test('issues: in the factory without GR is an error', () => {
  const regent = regentStatus({ productionStatus: 'Production Commenced Regent' });
  const out = issuesFor({ b: { chassis: 'SRT255616' }, group: 'sea', lt: { shippedAt: '2026-07-28', atd: '2026-09-18', ata: '2026-09-30' }, au: { location: 'production', station: 'Production Red Zone' }, sap: {}, regent, today });
  assert.equal(out[0].code, 'inFactoryNoGr'); assert.equal(out[0].level, 'error');
  const late = issuesFor({ b: { chassis: 'A' }, group: 'sea', lt: { ata: '2026-10-01' }, au: undefined, sap: {}, regent: regentStatus({ productionStatus: 'Van on the sea' }), today });
  assert.deepEqual(late.map(i => i.code), ['arrivedNoGr']);
  const behind = issuesFor({ b: { chassis: 'B' }, group: 'au', lt: { ata: '2026-09-01' }, sap: { grAt: '2026-09-10' }, regent: regentStatus({ productionStatus: 'Van on the sea' }), today });
  assert.deepEqual(behind.map(i => i.code), ['crmBehind']);
  const fresh = issuesFor({ b: { chassis: 'B' }, group: 'au', lt: { ata: '2026-11-01' }, sap: { grAt: '2026-11-08' }, regent: regentStatus({ productionStatus: 'Van on the sea' }), today });
  assert.deepEqual(fresh, [], 'CRM gets a week to catch up');
  const dates = issuesFor({ b: { chassis: 'C' }, group: 'sea', lt: { finishedAt: '2026-10-14', shippedAt: '2026-10-13' }, sap: {}, regent: regentStatus(null), today });
  assert.equal(dates[0].code, 'dateOrder');
});
test('rows sort by Regent status, then latest Longtree node, then its date', () => {
  const rows = [
    { id: 'a', regentRank: 4, ltRank: 8, ltDate: '2026-10-01' }, { id: 'b', regentRank: 0, ltRank: 1, ltDate: '' },
    { id: 'c', regentRank: 4, ltRank: 10, ltDate: '2026-10-05' }, { id: 'd', regentRank: 4, ltRank: 10, ltDate: '2026-09-01' },
  ];
  assert.deepEqual(sortLineRows(rows).map(r => r.id), ['b', 'd', 'c', 'a']);
});
test('a row moved to AU gets AU plan dates', () => {
  const d = datesForGroup({ cnPlanStart: '2026-06-01', cnPlanEnd: '2026-06-21', auPlanStart: '2026-09-01', auPlanEnd: '2026-10-11', cnActual: '2026-06-02', auActual: '' }, 'au', today, {}, { shippedAt: '2026-07-01' }, { grAt: '2026-09-05' });
  assert.equal(d.planStart, '2026-09-01'); assert.equal(d.planEnd, '2026-10-11'); assert.equal(d.auStart, '2026-09-05'); assert.equal(d.expectedEnd, today);
});
import { buildProductionLine } from '../lib/production-line.mjs';
test('the plan snapshot orders the rolling 60 days and flags duplicates', () => {
  const row = (id, group, extra = {}) => ({ id, chassis: id, group, cnPlanStart: '2026-12-01', cnPlanEnd: '2026-12-20', auPlanStart: '2027-02-01', auPlanEnd: '2027-03-01', locked: false, warnings: [], ...extra });
  const board = { rows: [row('A', 'rolling'), row('B', 'later'), row('C', 'rolling'), row('D', 'locked', { locked: true }), row('E', 'cn'), row('E', 'later')], completed: 0, averages: {} };
  const plan = { activeUntil: '2026-12-31', rows: [], byChassis: new Map([['B', { order: 1, months: ['2026-11#5'], weldPlan: '2026-11-20', finishPlan: '2026-12-05' }], ['D', { order: 2, months: ['2026-12#1'], weldPlan: '2026-12-02' }], ['A', { order: 3, months: ['2026-12#2'], weldPlan: '2026-12-03' }]]) };
  const out = buildProductionLine({ board, orders: {}, longtree: new Map(), prod: new Map(), portal: new Map(), today: '2026-11-11', settings: {}, plan });
  const g = id => out.rows.filter(r => r.chassis === id).map(r => r.group);
  assert.deepEqual(g('B'), ['rolling']); assert.deepEqual(g('C'), ['later']); assert.deepEqual(g('D'), ['locked']);
  assert.deepEqual(out.rows.filter(r => ['locked', 'rolling'].includes(r.group)).map(r => r.chassis), ['B', 'D', 'A']);
  assert.equal(out.rows.find(r => r.chassis === 'B').planStart, '2026-11-20');
  assert.ok(out.rows.find(r => r.chassis === 'C').issues.some(i => i.code === 'notInPlan'));
  assert.equal(out.rows.filter(r => r.chassis === 'E' && r.issues.some(i => i.code === 'duplicate')).length, 2);
  const expired = buildProductionLine({ board, orders: {}, longtree: new Map(), prod: new Map(), portal: new Map(), today: '2027-01-02', settings: {}, plan });
  assert.deepEqual(expired.rows.filter(r => r.chassis === 'B').map(r => r.group), ['later']);
});
test('vehicles the AU factory has at Transport get their own group', () => {
  assert.equal(groupFor({ chassis: 'X', group: 'au' }, {}, { grAt: '2026-09-01' }, '2026-11-12', { location: 'transport' }), 'transport');
  assert.equal(groupFor({ chassis: 'X', group: 'sea' }, {}, {}, '2026-11-12', { location: 'Transport' }), 'transport');
  assert.equal(groupFor({ chassis: 'X', group: 'au' }, {}, { grAt: '2026-09-01' }, '2026-11-12', { location: 'qc' }), 'au');
});
