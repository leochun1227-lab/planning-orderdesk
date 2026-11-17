import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBalancedRolling, rollingQuantity, weekOf } from '../lib/balanced-rolling.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { buildStockForecast, DISPLAY_MODELS } from '../lib/stock-forecast.mjs';
import { configureDealers, dealerList, dealerSnapshot, validateDealerSettings } from '../lib/dealership.mjs';
import { stockInputFingerprint, saveStockOpinion } from '../lib/stock-rolling.mjs';
import { forecastExportSheets, buildForecastWorkbook } from '../lib/stock-forecast-export.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { dayInSydney } from '../lib/order-engine.mjs';

const today = dayInSydney(), plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const row = (chassis, extra = {}) => ({ id: chassis, chassis, model: 'SRC21', modelYear: '2027', line: 'Towable', customer: 'Stock', dealer: 'Frankston', group: 'customers', signedAt: today, cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });
function fixture({ customerCount = 40, stockCount = 60, overstock = false, weeks = 4, extraRows = [], orders = {} } = {}) {
  const raw = { yard: {}, dealerConfigs: { abco: { name: 'ABCO', isActive: true }, unknown: { name: 'Unknown Independent', isActive: true } } };
  const dealers = configureDealers(dealerSnapshot(raw, today, { all: true, towableOnly: true }), { abco: { target: 15, travelDays: 7 } }, today);
  if (overstock) for (const d of dealers) if (d.target) d.yard.stock = 1000;
  const rows = [...Array.from({ length: stockCount }, (_, i) => row(`SRC99${String(i).padStart(4, '0')}`, { model: DISPLAY_MODELS[i % DISPLAY_MODELS.length], dealer: ['Frankston', 'Geelong', 'Bundaberg', 'ABCO'][i % 4] })),
    ...Array.from({ length: customerCount }, (_, i) => row(`SRC98${String(i).padStart(4, '0')}`, { customer: `Customer ${i}`, orderRow: i + 1 })), ...extraRows];
  const lead = plus(today, 110), monday = weekOf(lead), first = monday < lead ? plus(monday, 7) : monday;
  const capacity = new Map([[today, { towable: 4, srm: 1, srv: 1 }]]);
  for (let week = 0; week < weeks; week++) for (let d = 0; d < 5; d++) capacity.set(plus(first, week * 7 + d), { towable: 4, srm: 1, srv: 1 });
  const sources = { board: { rows, completed: 0, averages: {} }, longtree: new Map(), prod: new Map(), portal: new Map(), dealers, forecastDealers: dealers, auCapacity: capacity, settings: { cnDays: 20, seaDays: 50, auDays: 40 }, status: {} };
  const line = buildProductionLine({ ...sources, today, orders });
  const fingerprint = stockInputFingerprint({ line, dealers, capacity, settings: sources.settings, orders });
  const report = buildStockForecast({ dealers, rows: line.rows, today });
  const plan = saveStockOpinion({ report, fingerprint, actor: 'Test' });
  return { sources, rows, dealers, capacity, line, fingerprint, report, plan, input: { plan, fingerprint, line, dealers, capacity, settings: sources.settings, orders, quantity: 40 } };
}

test('balanced schedule fills the target with pool stock and customers at 30–40% each week without moving fixed capacity', () => {
  const f = fixture(), original = structuredClone(f.input), p = buildBalancedRolling(f.input);
  assert.equal(p.quantity, 40); assert.equal(p.scheduled, 40); assert.equal(p.customerCount, 14); assert.equal(p.stockCount, 26);
  assert.equal(p.newOrders + p.inventoryBlocked + p.capacityGap, 0); assert.ok(p.weeks.every(w => w.ratioMet));
  assert.equal(new Set(p.schedule.map(a => a.chassis)).size, p.schedule.length);
  const applied = buildProductionLine({ ...f.sources, today, orders: {}, rollingSchedule: p.schedule, rollingSize: p.quantity });
  const selected = new Map(applied.rows.filter(r => r.group === 'rolling').map(r => [r.chassis, r]));
  assert.equal(applied.counts.rolling, 40);
  for (const a of p.schedule) { assert.equal(selected.get(a.chassis).auEnd, a.auEnd); assert.equal(selected.get(a.chassis).rollingKind, a.kind); }
  for (const [day, c] of f.capacity) assert.ok([...selected.values()].filter(r => r.auEnd === day).length <= c.towable);
  assert.equal(applied.rows.filter(r => r.waitingRolling).length, f.input.line.counts.rolling - p.customerCount);
  assert.ok(p.stockResult.monthly.every(d => d.months.every(m => m.after == null || d.cap == null || m.after <= Math.max(d.cap, m.before))));
  assert.deepEqual(f.input, original);
});

test('pool shortage produces named model/dealer requests with no chassis; overstock requests remain blocked instead of filling capacity', () => {
  const short = fixture({ stockCount: 3 }), p = buildBalancedRolling({ ...short.input, quantity: 20 });
  assert.equal(p.stockCount, 3); assert.equal(p.customerCount, 7); assert.equal(p.newOrders, 10);
  assert.equal(p.scheduled + p.newOrders + p.inventoryBlocked + p.capacityGap, 20);
  assert.ok(p.requests.every(r => r.status === 'newOrder' && r.dealer && r.model && !r.chassis && r.auEnd && r.arrival));
  assert.ok(p.weeks.every(w => w.plannedCustomerShare >= .3 && w.plannedCustomerShare <= .4));
  assert.ok(p.weeks.some(w => !w.ratioMet), 'missing orders must not inflate the actual customer/stock ratio denominator');
  const excess = fixture({ overstock: true }), blocked = buildBalancedRolling({ ...excess.input, quantity: 20 });
  assert.equal(blocked.stockCount + blocked.newOrders, 0); assert.equal(blocked.inventoryBlocked, 13);
  assert.ok(blocked.requests.every(r => r.dealer && r.model && r.status === 'blocked' && !r.auEnd && !r.arrival));
  assert.ok(blocked.weeks.every(w => !w.ratioMet));
  assert.equal(blocked.scheduled + blocked.newOrders + blocked.inventoryBlocked + blocked.capacityGap, 20);
});

test('quantity, stale opinions, readiness, motorhomes, duplicates and receiving exclusions are enforced', () => {
  for (const q of ['', null, 0, -1, 1.5, 3001, Infinity, 'bad']) assert.throws(() => rollingQuantity(q));
  const f = fixture({ extraRows: [row('SRM990001', { customer: 'MH customer', model: 'SRM22.1' }), row('SRV990001'), row('SRC970001', { signedAt: '' }), row('SRC970002', { dealer: 'Traralgon' }), row('SRC970003', { model: 'SRC20' }), row('SRC970004'), row('SRC970004')] });
  const p = buildBalancedRolling(f.input);
  assert.ok(p.schedule.every(a => !/^(SRM|SRV|SRC970)/.test(a.chassis)));
  assert.ok(!p.requests.some(a => a.dealer === 'Traralgon'));
  assert.throws(() => buildBalancedRolling({ ...f.input, fingerprint: 'changed' }), /保存/);
  assert.throws(() => buildBalancedRolling({ ...f.input, blockers: ['portal'] }), /保存/);
  const small = fixture({ weeks: 1 }), gap = buildBalancedRolling({ ...small.input, quantity: 100 });
  assert.equal(gap.capacityGap, 80); assert.equal(gap.scheduled + gap.newOrders + gap.inventoryBlocked + gap.capacityGap, 100);
});

test('fixed orders preserve occupied capacity even when chassis/model labels disagree, and count towards the same weekly ratio', () => {
  const extraRows = Array.from({ length: 5 }, (_, i) => row(`SRM97FIX${i}`, { group: 'locked', customer: `Fixed customer ${i}`, model: 'SRC21' }));
  const f = fixture({ extraRows }), p = buildBalancedRolling({ ...f.input, quantity: 39 });
  assert.equal(p.weeks[0].fixedCustomer, 1); assert.ok(p.weeks.every(w => w.ratioMet));
  const applied = buildProductionLine({ ...f.sources, today, orders: {}, rollingSchedule: p.schedule });
  for (const r of f.line.rows.filter(r => r.group === 'locked')) assert.equal(applied.rows.find(a => a.chassis === r.chassis).auEnd, r.auEnd);
  for (const [d, cap] of f.capacity) assert.ok(applied.rows.filter(r => ['locked', 'rolling'].includes(r.group) && r.auEnd === d).length <= cap.towable);
});

test('the planner searches later receiving windows and gives existing future-ready stock priority over new orders', () => {
  const delayed = fixture({ weeks: 9 });
  for (const d of delayed.dealers) if (d.target) { d.yard.stock = d.target + 50; d.handover.avgStock = 10; }
  delayed.input.fingerprint = stockInputFingerprint({ line: delayed.line, dealers: delayed.dealers, capacity: delayed.capacity, settings: delayed.sources.settings });
  delayed.input.plan = saveStockOpinion({ report: buildStockForecast({ dealers: delayed.dealers, rows: delayed.line.rows, today }), fingerprint: delayed.input.fingerprint, actor: 'Test' });
  const later = buildBalancedRolling({ ...delayed.input, quantity: 20 });
  assert.ok(later.stockCount > 0); assert.ok(later.schedule.every(a => a.auEnd > plus(today, 120)));
  const mon = weekOf(plus(today, 110)), first = mon < plus(today, 110) ? plus(mon, 7) : mon;
  const ready = plus(first, 14);
  const future = fixture({ stockCount: 1, orders: { SRC990000: { chassis: 'SRC990000', status: 'active', customer: 'Stock', signedAt: today, forecastDate: plus(ready, -40) } } });
  const p = buildBalancedRolling({ ...future.input, quantity: 20 });
  assert.equal(p.stockCount, 1); assert.ok(p.schedule.find(a => a.chassis === 'SRC990000').auEnd >= ready);
});

test('later pool orders replace early draft requests before extra new stock is proposed', () => {
  const mon = weekOf(plus(today, 110)), first = mon < plus(today, 110) ? plus(mon, 7) : mon, ready = plus(first, 21);
  const orders = Object.fromEntries(Array.from({ length: 57 }, (_, i) => {
    const chassis = `SRC99${String(i + 3).padStart(4, '0')}`;
    return [chassis, { chassis, status: 'active', customer: 'Stock', signedAt: today, forecastDate: plus(ready, -40) }];
  }));
  const f = fixture({ orders, weeks: 7 }), p = buildBalancedRolling({ ...f.input, quantity: 20 });
  assert.equal(p.scheduled, 20); assert.equal(p.newOrders, 0);
  assert.ok(p.stockCount >= 12); assert.ok(p.schedule.some(a => a.kind === 'stock' && a.auEnd >= ready));
  assert.equal(p.scheduled + p.newOrders + p.inventoryBlocked + p.capacityGap, 20);
});

test('customer delivery requirements survive the source update and urgent customers take priority without bypassing lead time', () => {
  const f = fixture({ extraRows: [row('SRC96URGENT', { customer: 'Urgent Customer', inSchedule: true, requestDate: 'Urgent', orderRow: 9999 })] });
  const p = buildBalancedRolling({ ...f.input, quantity: 20 }), urgent = p.schedule.find(a => a.chassis === 'SRC96URGENT');
  assert.ok(urgent); assert.equal(urgent.requestDate, 'Urgent'); assert.ok(urgent.auEnd >= plus(today, 110));
  const changed = structuredClone(f.input.line); changed.rows.find(r => r.chassis === 'SRC96URGENT').requestDate = '2027-01-10';
  assert.notEqual(stockInputFingerprint({ line: changed, dealers: f.dealers, capacity: f.capacity, settings: f.sources.settings }), f.fingerprint);
});

test('independent dealer discovery, missing settings and forecasts preserve all groups and prohibit independent reallocation', () => {
  const raw = { dealerConfigs: { abco: { name: 'ABCO Caravans' }, old: { name: 'Old', isActive: false }, group: { name: 'Group', isGroup: true } }, yard: { other: {}, old: {} }, schedule: [{ Dealer: 'ABCO Caravans' }, { Dealer: 'Sydney' }] };
  const list = dealerList(raw);
  assert.equal(list.filter(d => d.name === 'ABCO Caravans').length, 1); assert.ok(list.some(d => d.slug === 'other')); assert.ok(list.some(d => d.slug === 'sydney' && d.target === 25));
  assert.ok(!list.some(d => ['old', 'group'].includes(d.slug)));
  const snapshot = dealerSnapshot(raw, today, { all: true, towableOnly: true });
  const rows = [row('SRC970001', { group: 'locked', dealer: 'ABCO Caravans', auEnd: plus(today, 110) }), row('SRC970002', { group: 'locked', dealer: 'other', auEnd: plus(today, 110) })];
  const pending = buildStockForecast({ dealers: snapshot, rows, today });
  assert.equal(pending.independent.summary.canceled, 0); assert.equal(pending.independent.summary.pending, 2);
  assert.ok(pending.independent.dealers.filter(d => ['abco', 'other'].includes(d.slug)).every(d => d.settingsNeeded && d.monthly.every(m => m.endStock == null)));
  assert.throws(() => validateDealerSettings([{ slug: 'abco', target: 0, travelDays: 7 }], snapshot));
  const settings = validateDealerSettings([{ slug: 'abco', target: 15, travelDays: 7 }, { slug: 'other', target: 10, travelDays: 0 }], snapshot);
  const configured = configureDealers(snapshot, settings, today), ready = buildStockForecast({ dealers: configured, rows, today });
  assert.equal(ready.independent.actions.length, 2); assert.ok(ready.independent.actions.every(a => a.receive && a.from === a.to && !a.reallocated));
  assert.deepEqual(forecastExportSheets(ready, 'independent').find(s => s.name === 'Independent-月度预测').rows.map(r => r[0]).filter((n, i, a) => a.indexOf(n) === i).sort(), ready.independent.dealers.map(d => d.name).sort());
});

async function apiFixture() {
  const f = fixture(), firebase = createMemoryFirebase(), store = createStore(firebase);
  await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const auth = { user: () => ({ name: 'Planner' }) }, app = createApp({ store, auth, env: {}, productionSource: { current: async () => f.sources } });
  const get = async (path = '/api/stock-forecast') => { const r = await app.request(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const post = (path, body, origin = 'http://localhost') => app.request(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const save = async report => { const r = await post('/api/stock-forecast/save', { multiplier: report.multiplier, months: report.months, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId }); assert.equal(r.status, 200, await r.clone().text()); };
  return { ...f, firebase, store, auth, app, get, post, save };
}

test('API generation is persistent, applies exact pool dates, aligns the forecast and can be cleared without editing orders', async () => {
  const f = await apiFixture(); await f.save(await f.get());
  const initial = await f.get('/api/production-line'), b = initial.balanced;
  const body = { quantity: 40, inputToken: b.inputToken, opinionId: b.opinionId, expectedId: b.expectedId };
  assert.equal((await f.post('/api/rolling-plan', body, 'https://wrong.example')).status, 403);
  const made = await f.post('/api/rolling-plan', body); assert.equal(made.status, 200, await made.clone().text());
  const live = await f.get('/api/production-line'), forecast = await f.get();
  assert.equal(live.balanced.status, 'ready'); assert.equal(live.counts.rolling, 40); assert.equal(forecast.rolling.balanced, true);
  for (const item of forecast.rolling.items) assert.equal(live.rows.find(r => r.chassis === item.chassis).auEnd, item.auEnd);
  const saved = (await createStore(f.firebase).readState()).state;
  assert.equal(saved.rollingPlan.quantity, 40); assert.deepEqual(saved.orders, {}); assert.ok(saved.rollingPlan.weeks.every(w => w.ratioMet));
  const sheets = forecastExportSheets(forecast);
  assert.equal(sheets.find(s => s.name === '滚动排产订单').rows.length, 40);
  assert.equal(sheets.find(s => s.name === '每周AU下线比例').rows.length, 2);
  const wb = await buildForecastWorkbook(forecast); assert.ok((await wb.xlsx.writeBuffer()).byteLength > 5000);
  assert.equal((await f.post('/api/rolling-plan', body)).status, 409);
  assert.equal((await f.post('/api/stock-forecast/admissions', { mode: 'add', planId: forecast.rolling.planId, token: forecast.rolling.token, chassis: [forecast.rolling.items[0].chassis] })).status, 409);
  const clear = await f.post('/api/rolling-plan/clear', { expectedId: live.balanced.expectedId }); assert.equal(clear.status, 200);
  assert.equal((await f.get('/api/production-line')).balanced.status, 'empty');
});

test('a generation job leaves liveness responsive and rejects overlapping generation requests', async () => {
  const f = await apiFixture(); await f.save(await f.get());
  const { balanced: b } = await f.get('/api/production-line'), body = { ...b, quantity: 40 };
  const pending = f.post('/api/rolling-plan', body);
  const repeated = await f.post('/api/rolling-plan', body);
  assert.equal(repeated.status, 409);
  assert.equal((await f.app.request('/api/health')).status, 200);
  assert.equal((await pending).status, 200);
});

test('independent settings persist and invalidate stale opinions and rolling schedules without cancelling missing-data orders', async () => {
  const f = await apiFixture(); await f.save(await f.get());
  let report = await f.get();
  const payload = { dealers: [{ slug: 'unknown', target: 12, travelDays: 7 }], previous: report.dealerSettingsToken };
  assert.equal((await f.post('/api/stock-forecast/dealers', payload)).status, 200);
  report = await f.get(); assert.equal(report.rolling.status, 'stale');
  assert.equal(report.independent.dealers.find(d => d.slug === 'unknown').cap, 15);
  assert.deepEqual((await createStore(f.firebase).readState()).state.stockDealerSettings.unknown, { target: 12, travelDays: 7 });
  assert.equal((await f.post('/api/stock-forecast/dealers', payload)).status, 409);
  assert.equal((await f.post('/api/stock-forecast/dealers', { dealers: [{ slug: 'frankston', target: 10, travelDays: 7 }], previous: report.dealerSettingsToken })).status, 400);
  await f.save(report);
  let live = await f.get('/api/production-line');
  assert.equal((await f.post('/api/rolling-plan', { ...live.balanced, quantity: 20 })).status, 200);
  f.sources.board.rows[0].signedAt = '';
  live = await f.get('/api/production-line'); assert.equal(live.balanced.status, 'stale');
  assert.equal(live.rows.filter(r => r.rollingKind === 'stock').length, 0);
  f.auth.user = () => null; assert.equal((await f.post('/api/rolling-plan', {})).status, 401);
});
