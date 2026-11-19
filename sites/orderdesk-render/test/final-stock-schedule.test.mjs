import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { finalScheduleView, scheduleCells, scheduleHeaders } from '../lib/stock-schedule-view.mjs';
import { buildSimulationReport } from '../lib/stock-simulation-report.mjs';
import { buildFinalSchedulePdf } from '../server/final-stock-schedule-pdf.mjs';
import { replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { fixture } from './helpers/rolling-fixture.mjs';
const today = '2026-11-19';
const dealer = (slug, extra = {}) => ({ slug, name: slug, own: true, target: 10, travelDays: 0, yard: { stock: 0 }, transit: { stock: 0 }, vehicles: [], handover: { months: [], avgStock: 0, thisMonth: { stock: 0 } }, ...extra });
const row = (chassis, extra = {}) => ({ chassis, customer: 'Stock', model: 'SRC21', modelYear: '2027', dealer: 'a', signedAt: today, group: 'locked', auEnd: '2027-03-15', ...extra });
const allActions = r => ['own', 'jv', 'independent'].flatMap(g => r[g].actions);

test('SRH MY2026 retains its own dealer at every stage, even with impossible ceilings or a MY2027 coverage gap elsewhere', () => {
  const rows = ['au', 'sea', 'cn', 'locked', 'rolling', 'customers'].map((group, i) => row(`SRH${i}`, { model: 'SRH16', modelYear: '2026', group }));
  const dealers = [dealer('a', { target: 1, yard: { stock: 30 }, vehicles: [{ chassis: 'YARD26', model: 'SRH14', modelYear: '2026', category: 'stock', where: 'yard' }] }), dealer('b')];
  const report = buildStockSimulation({ dealers, rows, today, displayModels: ['SRH16'], assumptions: { dealers: [{ slug: 'a', cap: 0 }] } });
  assert.ok(allActions(report).every(a => !a.reallocated && a.action !== 'cancel' && (!a.to || a.to === a.from)));
  assert.equal(report.finalSchedule.srh2026.length, 7);
  assert.equal(buildSimulationReport(report).dealers[0].srh2026Count, 7);
  const moved = allActions(report).find(a => a.group === 'au');
  const fake = structuredClone(report); fake.auProduction = { daily: [['2027-03-15', { towable: 8, srm: 0, srv: 0 }]] };
  Object.assign(fake.own.actions.find(a => a.chassis === moved.chassis), { reallocated: true, to: 'b', proposedDealer: 'b' });
  assert.throws(() => replayInventoryBasis({ line: { today, rows }, report: fake, capacity: new Map(fake.auProduction.daily), dealers }), /SRH MY2026/);
});

test('following Stock dates start at the last adjusted locked Towable place, consume spare daily capacity once and retain owners', () => {
  const capacity = new Map([['2027-03-15', { towable: 2, srm: 0, srv: 0 }], ['2027-03-16', { towable: 1, srm: 0, srv: 0 }], ['2027-04-01', { towable: 1, srm: 0, srv: 0 }]]);
  const rows = [row('LOCK'), row('CUSTOMER_LOCK', { customer: 'Alice', auEnd: '2027-03-16' }), row('POOL1', { group: 'customers', auEnd: '' }), row('POOL2', { group: 'customers', auEnd: '' }), row('UNSIGNED', { group: 'customers', auEnd: '', signedAt: '' }), row('CLIENT', { group: 'customers', customer: 'Bob', auEnd: '' })];
  const before = structuredClone(rows), report = buildStockSimulation({ today, rows, capacity, dealers: [dealer('a')], displayModels: ['SRC21'] });
  const plan = finalScheduleView(report); assert.equal(plan.boundary, '2027-03-15'); assert.equal(plan.following, 2);
  assert.equal(plan.rows.at(-1).auFinish, '2027-04-01');
  assert.ok(plan.rows.every(a => a.from === a.to));
  assert.deepEqual(plan.rows.map(a => a.auFinish), plan.rows.map(a => a.auFinish).sort());
  assert.equal(new Set(plan.rows.map(a => a.chassis)).size, plan.rows.length);
  assert.ok(!plan.rows.filter(a => !a.kind || a.kind === 'stock').some(a => ['UNSIGNED', 'CLIENT', 'CUSTOMER_LOCK'].includes(a.chassis)));
  assert.ok(plan.rows.some(a => a.kind === 'customer' && a.chassis === 'CUSTOMER_LOCK'));
  assert.ok(allActions(report).filter(a => report.finalSchedule.following.some(b => b.chassis === a.chassis)).every(a => a.action === 'pool'), 'continuation remains a read-only preview, not a silently applied order change');
  assert.deepEqual(rows, before);
});

test('OUT and IN occupy the final two columns of the same row and refer to the same unique transfer', () => {
  const report = buildStockSimulation({ today, dealers: [dealer('a', { target: 1, yard: { stock: 30 }, vehicles: [{ chassis: 'OWN', model: 'SRC21', modelYear: '2027', category: 'stock', where: 'yard' }] }), dealer('b')], rows: [row('TRANSFER', { group: 'au' })], displayModels: ['SRC21'] });
  const model = buildSimulationReport(report), a = model.dealers[0].planRows[0], b = model.dealers[1].planRows[0];
  assert.equal(a.chassis, b.chassis); assert.equal(a.reallocation, true);
  assert.deepEqual(scheduleCells(a).slice(-2), ['a', 'b']);
  assert.equal(scheduleHeaders[0], 'AU finish'); assert.deepEqual(scheduleHeaders.slice(-2), ['OUT - from', 'IN - to']);
});

test('simple PDF repeats chronological table headers on standard landscape pages and lists every SRH MY2026 vehicle in red', async () => {
  const report = buildStockSimulation({ today, dealers: [dealer('a')], rows: [row('SRH26', { model: 'SRH16', modelYear: '2026' })], displayModels: ['SRH16'] });
  const base = report.finalSchedule.rows[0];
  report.finalSchedule.rows.push(...Array.from({ length: 130 }, (_, i) => ({ ...base, chassis: `SRC${i}`, model: 'SRC21', modelYear: '2027', plannedAu: '2027-04-01' })));
  const before = structuredClone(report), bytes = await buildFinalSchedulePdf(report), text = bytes.toString('latin1');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const pages = (text.match(/\/Type \/Page\b/g) || []).length; assert.ok(pages > 3);
  for (const m of text.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)) assert.ok(Number(m[1].trim().split(/\s+/).at(-1)) < 600);
  assert.deepEqual(report, before);
});

test('schedule PDF API uses the same preview token, supports the simple format and remains read-only', async () => {
  const f = fixture({ stockCount: 2, customerCount: 0 }), store = createStore(createMemoryFirebase());
  await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const app = createApp({ store, auth: { user: () => ({ name: 'Planner' }) }, env: {}, productionSource: { current: async () => f.sources } });
  const response = await app.request('/api/stock-forecast'); assert.equal(response.status, 200); const report = await response.json(), before = await store.readState();
  const post = body => app.request('/api/stock-forecast/report.pdf', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = { format: 'schedule', multiplier: report.multiplier, months: report.months, assumptions: report.assumptions, previewToken: report.previewToken };
  const pdf = await post(payload); assert.equal(pdf.status, 200, await pdf.clone().text()); assert.match(pdf.headers.get('Content-Disposition'), /Final_Stock_AU_Schedule/);
  assert.equal((await post({ ...payload, previewToken: 'stale' })).status, 409); assert.deepEqual(await store.readState(), before);
});
