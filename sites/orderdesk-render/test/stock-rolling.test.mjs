import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionLine } from '../lib/production-line.mjs';
import { buildStockForecast } from '../lib/stock-forecast.mjs';
import { dealerSnapshot } from '../lib/dealership.mjs';
import { stockInputFingerprint, saveStockOpinion, recommendPoolStock, productionLineDisplay } from '../lib/stock-rolling.mjs';
import { reviewStockWithAI } from '../lib/stock-rolling-ai.mjs';
import { forecastExportSheets } from '../lib/stock-forecast-export.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { dayInSydney } from '../lib/order-engine.mjs';

const today = dayInSydney(), plus = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const row = (chassis, extra = {}) => ({ id: chassis, chassis, model: 'SRC21', modelYear: '2027', line: 'Towable', customer: 'Stock', dealer: 'Frankston', group: 'customers', signedAt: today, cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });
function fixture(rows = [row('SRC270001'), row('SRC270002', { model: 'SRC19' }), row('SRC270003', { dealer: 'Bundaberg', model: 'SRH16' }), row('SRC270004', { customer: 'Jane Customer' })]) {
  const dealers = dealerSnapshot({ yard: {} }, today, { all: true, towableOnly: true });
  const capacity = new Map([0, 110, 111, 112, 113, 114].map(n => [plus(n), { towable: 2, srm: 1, srv: 1 }]));
  const sources = { board: { rows, completed: 0, averages: {} }, longtree: new Map(), prod: new Map(), portal: new Map(), settings: { cnDays: 20, seaDays: 50, auDays: 40 }, dealers, forecastDealers: dealers, auCapacity: capacity, status: {} };
  const line = buildProductionLine({ ...sources, today, orders: {} });
  const fingerprint = stockInputFingerprint({ line, dealers, capacity, settings: sources.settings });
  const report = buildStockForecast({ dealers, rows: line.rows, today });
  const plan = saveStockOpinion({ report, fingerprint, actor: 'Planner' });
  const input = { plan, fingerprint, line, dealers, capacity, settings: sources.settings };
  return { rows, dealers, capacity, sources, line, fingerprint, report, plan, input };
}

test('saved opinions produce jointly feasible Towable recommendations, without automatically admitting any stock', () => {
  const f = fixture(), before = structuredClone(f.input), result = recommendPoolStock(f.input);
  assert.equal(result.status, 'ready'); assert.equal(result.items.length, 3); assert.equal(result.admitted.length, 0);
  assert.equal(f.line.rows.filter(r => r.group === 'rolling').length, 0);
  assert.ok(result.items.every(a => a.auEnd >= plus(110) && a.cnStart >= today && a.cnStart <= plus(60) && a.stockAfter <= a.cap));
  assert.equal(result.items.find(a => a.jv).slug, 'bundaberg');
  assert.deepEqual(f.input, before);
  const noOpinion = recommendPoolStock({ ...f.input, plan: null }); assert.equal(noOpinion.status, 'unsaved'); assert.equal(noOpinion.items.length, 0);
  assert.equal(recommendPoolStock({ ...f.input, fingerprint: 'new data' }).status, 'stale');
  assert.equal(recommendPoolStock({ ...f.input, blockers: ['portal'] }).status, 'sources');
  assert.equal(recommendPoolStock({ ...f.input, capacity: null }).status, 'capacity');
});

test('confirmation preserves displayed dates, customer priority and Stock identity, and is reversible', () => {
  const f = fixture(), first = recommendPoolStock(f.input);
  const chosen = first.items.find(a => a.jv);
  f.plan.admitted = [chosen.chassis];
  const confirmed = recommendPoolStock(f.input);
  assert.deepEqual(confirmed.items.map(a => [a.chassis, a.auEnd, a.arrival]), first.items.map(a => [a.chassis, a.auEnd, a.arrival]), 'confirmation must not reshuffle a reviewed schedule');
  const out = buildProductionLine({ ...f.sources, today, orders: {}, rollingAdmissions: confirmed.items.filter(a => a.admitted) });
  assert.equal(out.counts.rolling, 1);
  const added = out.rows.find(r => r.chassis === f.plan.admitted[0]);
  assert.equal(added.rollingKind, 'stock'); assert.equal(added.customer, 'Stock'); assert.equal(added.auEnd, chosen.auEnd);
  const monthly = confirmed.monthly.find(d => d.slug === chosen.slug).months;
  assert.equal(monthly.reduce((n, m) => n + m.confirmedIn, 0), 1);
  assert.ok(monthly.every(m => m.confirmed >= m.before && m.confirmed <= m.after));
  assert.equal(out.rows.find(r => r.customer === 'Jane Customer').group, 'customers');
  assert.equal(out.dealership.jvDealers.find(d => d.slug === 'bundaberg').stockPicked, 1);
  assert.equal(buildProductionLine({ ...f.sources, today, orders: {}, rollingAdmissions: [] }).counts.rolling, 0);
});

test('recommendations reject motorhome metadata, duplicates, physical stock, Traralgon, non-display models and cancelled orders', () => {
  const rows = [row('SRM270001'), row('SRC270002', { model: 'SRV22.1' }), row('SRC270003', { range: 'SRM' }), row('SRC270004', { dealer: 'Traralgon' }),
    row('SRC270005', { model: 'SRC20' }), row('SRC270006', { model: 'SRT18' }), row('SRC270007'), row('SRC270008'), row('SRC270008')];
  const f = fixture(rows), result = recommendPoolStock({ ...f.input, orders: { cancelled: { chassis: 'SRC270007', status: 'cancelled' } } });
  assert.equal(result.items.length, 0);
  assert.ok(result.held.motorhome > 0 && result.held.receiving > 0 && result.held.model > 0 && result.held.cancelled > 0 && result.held.duplicate > 0);
  const unsigned = fixture([row('SRC270010', { signedAt: '' })]);
  assert.equal(recommendPoolStock(unsigned.input).items.length, 0);
});

test('saved cancellations remove planned supply, while downstream inventory, model buffers and unresolved arrivals constrain replenishment', () => {
  const f = fixture([row('SRC270001'), row('SRC270002')]), d = f.dealers.find(d => d.slug === 'frankston');
  d.target = 1; f.plan.report.own.actions.push({ chassis: 'CANCELLED', from: 'frankston', to: '', action: 'cancel', group: 'locked', model: 'SRC21', receive: false });
  const result = recommendPoolStock(f.input); assert.equal(result.items.length, 1);
  f.plan.report.own.actions.push({ chassis: 'FIXED', from: 'frankston', to: 'frankston', action: 'keep', group: 'sea', model: 'SRC21', receive: true, plannedArrival: plus(100) });
  assert.equal(recommendPoolStock(f.input).items.length, 0);
  f.plan.report.own.actions.pop();
  f.plan.report.own.actions.push({ chassis: 'UNKNOWN', from: 'frankston', action: 'pending', group: 'cn' });
  const held = recommendPoolStock(f.input); assert.equal(held.items.length, 0); assert.equal(held.held.unresolved, 2);
  const same = fixture([1, 2, 3, 4].map(n => row(`SRC27000${n}`)));
  assert.equal(recommendPoolStock(same.input).items.length, 2, 'same-model buffer must constrain the joint recommendation set');
});

test('input fingerprint changes on stock, signatures, cancellation, capacity and day, but not source refresh timestamps', () => {
  const f = fixture(), input = { line: f.line, dealers: f.dealers, capacity: f.sources.auCapacity, settings: f.sources.settings };
  const original = stockInputFingerprint(input);
  for (const change of [x => { x.line.rows[0].signedAt = ''; }, x => { x.dealers[0].yard.stock++; }, x => { x.capacity.set(plus(115), { towable: 8 }); }, x => { x.line.today = plus(1); }]) {
    const next = structuredClone(input); change(next); assert.notEqual(stockInputFingerprint(next), original);
  }
  assert.equal(stockInputFingerprint({ ...input, refreshedAt: new Date().toISOString() }), original);
  assert.notEqual(stockInputFingerprint({ ...input, orders: { C: { chassis: 'C', status: 'cancelled' } } }), original);
});

test('nameless processing orders disappear consistently from display and counts while source rows remain intact', () => {
  const f = fixture([row('SRC270001', { signedAt: '', customer: '  ' }), row('SRC270002', { signedAt: '', customer: 'Jane' }), row('SRC270003', { signedAt: '', customer: 'Stock' })]);
  const shown = productionLineDisplay(f.line);
  assert.equal(shown.counts.processing, 2); assert.ok(!shown.rows.some(r => r.chassis === 'SRC270001'));
  assert.equal(f.line.rows.length, 3); assert.equal(f.line.counts.processing, 3);
});

test('Excel adds saved-opinion recommendations and monthly comparisons with correct JV scope', () => {
  const f = fixture(), rolling = recommendPoolStock(f.input), sheets = forecastExportSheets({ ...f.report, rolling }, 'jv');
  const candidates = sheets.find(s => s.name === '库存池补货建议');
  assert.deepEqual(candidates.rows.map(r => r[0]), rolling.items.filter(a => a.jv).map(a => a.chassis));
  assert.ok(!sheets.some(s => /Reallocation/.test(s.name)));
});

test('AI uses only the existing OPENAI_API env on the server, minimizes data and cannot add candidate IDs', async () => {
  const f = fixture(), rolling = recommendPoolStock(f.input);
  let request;
  const result = await reviewStockWithAI({ env: { OPENAI_API: 'server-test-secret' }, rolling, report: f.report, fetcher: async (url, options) => {
    request = { url, ...options }; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '先落实调整。', notes: [{ id: 0, note: '核对收车窗口。' }, { id: 999, note: '不能新增' }] }) } }] }) };
  } });
  assert.equal(request.headers.Authorization, 'Bearer server-test-secret');
  const body = JSON.parse(request.body); assert.equal(body.store, false); assert.equal(body.response_format.json_schema.strict, true);
  assert.doesNotMatch(request.body, /SRC270001|Jane Customer|signedAt|server-test-secret/);
  assert.equal(result.notes.length, 1); assert.equal(result.notes[0].chassis, rolling.items[0].chassis);
  await assert.rejects(reviewStockWithAI({ env: {}, rolling, report: f.report }), /OPENAI_API/);
  await assert.rejects(reviewStockWithAI({ env: { OPENAI_API: 'private' }, rolling, report: f.report, fetcher: async () => { throw new Error('private'); } }), e => !e.message.includes('private'));
});

async function apiFixture() {
  const f = fixture(), firebase = createMemoryFirebase(), store = createStore(firebase);
  await store.writeState({ orders: { SRC270001: { id: 'SRC270001', chassis: 'SRC270001', customer: 'Stock', dealer: 'Frankston', status: 'active', signedAt: today } }, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const auth = { user: () => ({ name: 'Planning Test' }) }, productionSource = { current: async () => f.sources };
  const app = createApp({ store, auth, env: {}, productionSource });
  const get = async () => (await app.request('/api/stock-forecast')).json();
  const post = (path, body, origin = 'http://localhost') => app.request(`/api/stock-forecast/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const save = async report => { const response = await post('save', { multiplier: report.multiplier, months: report.months, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  return { ...f, firebase, store, app, auth, get, post, save };
}

test('API save → recommend → confirm → refresh survives persistence, excludes nameless processing, and never changes actual orders', async () => {
  const f = await apiFixture(), before = (await f.store.readState()).state.orders;
  f.sources.board.rows.push(row('SRC270009', { customer: ' ', signedAt: '' }));
  const initial = await f.get(); assert.equal(initial.rolling.status, 'unsaved'); await f.save(initial);
  const saved = await f.get(); assert.equal(saved.rolling.status, 'ready'); assert.equal(saved.rolling.items.length, 3);
  const ids = saved.rolling.items.map(a => a.chassis), admission = { mode: 'add', planId: saved.rolling.planId, token: saved.rolling.token, chassis: ids };
  assert.equal((await f.post('admissions', admission, 'https://wrong.example')).status, 403);
  assert.equal((await f.post('admissions', admission)).status, 200);
  const live = await (await f.app.request('/api/production-line')).json();
  assert.equal(live.counts.rolling, 3); assert.equal(live.stockRolling.admitted.length, 3);
  assert.ok(live.rows.filter(r => r.rollingKind === 'stock').every(r => r.stockRecommendation.admitted));
  assert.ok(!live.rows.some(r => r.chassis === 'SRC270009')); assert.equal(live.counts.processing, 0);
  assert.deepEqual((await f.store.readState()).state.orders, before);
  assert.equal((await f.post('admissions', admission)).status, 409, 'replayed admission is rejected');
  assert.equal((await f.post('admissions', { mode: 'remove', planId: saved.rolling.planId, chassis: ids })).status, 200);
  const removed = await (await f.app.request('/api/production-line')).json(); assert.equal(removed.counts.rolling, 0);
  const state = (await f.store.readState()).state; assert.equal(state.stockForecastPlan.events.length, 3); assert.ok(state.stockForecastPlan.report.own.actions.length);
});

test('API rejects stale sources, changed opinions, forged IDs, unsigned/SRV/SRM/Traralgon admissions and preserves history', async () => {
  const f = await apiFixture(), preview = await f.get(); await f.save(preview);
  assert.equal((await f.post('save', { multiplier: preview.multiplier, months: preview.months, previewToken: preview.previewToken, expectedPlanId: null })).status, 409);
  let saved = await f.get();
  for (const id of ['SRM270001', 'SRV270001', 'SRC_UNKNOWN']) assert.equal((await f.post('admissions', { mode: 'add', planId: saved.rolling.planId, token: saved.rolling.token, chassis: [id] })).status, 409);
  f.sources.board.rows[1].signedAt = '';
  let stale = await f.get(); assert.equal(stale.rolling.status, 'stale'); assert.equal(stale.rolling.items.length, 0);
  assert.equal((await f.post('admissions', { mode: 'add', planId: saved.rolling.planId, token: saved.rolling.token, chassis: [saved.rolling.items[0].chassis] })).status, 409);
  await f.save(stale); saved = await f.get(); assert.ok(!saved.rolling.items.some(a => a.chassis === 'SRC270002'));
  assert.equal((await f.store.readState()).state.stockForecastHistory.length, 1);
  f.sources.status.portal = { configured: true, error: 'offline' };
  stale = await f.get(); assert.equal(stale.rolling.status, 'sources'); assert.equal(stale.canSave, false);
  assert.equal((await f.post('save', { multiplier: stale.multiplier, months: stale.months, previewToken: stale.previewToken, expectedPlanId: stale.expectedPlanId })).status, 400);
  f.auth.user = () => null;
  assert.equal((await f.post('admissions', {})).status, 401);
});

test('concurrent admission writes cannot overwrite each other, and stock changes hold old approvals for review', async () => {
  const f = await apiFixture(); await f.save(await f.get());
  const saved = await f.get(), p = saved.rolling;
  const results = await Promise.all(p.items.slice(0, 2).map(a => f.post('admissions', { mode: 'add', planId: p.planId, token: p.token, chassis: [a.chassis] })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await f.store.readState()).state.stockForecastPlan.admitted.length, 1);
  f.sources.forecastDealers.find(d => d.slug === 'frankston').yard.stock++;
  const held = await f.get(); assert.equal(held.rolling.status, 'stale'); assert.equal(held.rolling.requested.length, 1);
  const live = await (await f.app.request('/api/production-line')).json();
  assert.equal(live.rows.filter(r => r.rollingKind === 'stock').length, 0);
  assert.equal((await f.post('admissions', { mode: 'remove', planId: p.planId, chassis: held.rolling.requested })).status, 200);
});

test('both model lists persist together; moving a model to not recommended invalidates the old opinion and its admissions', async () => {
  const f = await apiFixture(), initial = await f.get(); await f.save(initial);
  const ready = await f.get(), p = ready.rolling;
  assert.ok(p.items.some(a => a.chassis === 'SRC270001'));
  assert.equal((await f.post('admissions', { mode: 'add', planId: p.planId, token: p.token, chassis: ['SRC270001'] })).status, 200);
  const beforeOrders = (await f.store.readState()).state.orders;
  const body = { models: ready.displayModels.filter(m => m !== 'SRC21'), notOnYardModels: [...ready.notOnYardModels, ' src21 '], previous: ready.displayModels, previousNotOnYardModels: ready.notOnYardModels };
  assert.equal((await f.post('models', body, 'https://wrong.example')).status, 403);
  assert.equal((await f.post('models', body)).status, 200);
  const updated = await f.get(), persisted = (await createStore(f.firebase).readState()).state;
  assert.ok(updated.notOnYardModels.includes('SRC21')); assert.ok(!updated.displayModels.includes('SRC21'));
  assert.deepEqual(persisted.stockNotOnYardModels, updated.notOnYardModels);
  assert.deepEqual(persisted.stockDisplayModels, updated.displayModels);
  assert.deepEqual(persisted.orders, beforeOrders);
  assert.equal(updated.rolling.status, 'stale'); assert.notEqual(updated.previewToken, ready.previewToken);
  assert.equal((await f.post('admissions', { mode: 'add', planId: p.planId, token: p.token, chassis: ['SRC270001'] })).status, 409);
  await f.save(updated);
  const replanned = await f.get(); assert.equal(replanned.rolling.status, 'ready');
  assert.ok(!replanned.rolling.items.some(a => a.model === 'SRC21'));
  assert.deepEqual((await f.store.readState()).state.stockForecastPlan.report.notOnYardModels, updated.notOnYardModels);
  const live = await (await f.app.request('/api/production-line')).json();
  assert.equal(live.rows.find(r => r.chassis === 'SRC270001').group, 'customers');
  assert.equal(live.rows.find(r => r.customer === 'Jane Customer').group, 'customers', 'customers stay in the pool until explicitly selected, including nonrecommended stock models');
});

test('nonrecommended-only edits invalidate previews, reject stale or overlapping lists, and preserve explicit empty lists', async () => {
  const f = await apiFixture(), initial = await f.get();
  const payload = (current, extra = {}) => ({ models: current.displayModels, notOnYardModels: current.notOnYardModels, previous: current.displayModels, previousNotOnYardModels: current.notOnYardModels, ...extra });
  assert.equal((await f.post('models', payload(initial))).status, 200);
  const normalized = await f.get(); await f.save(normalized);
  assert.equal((await f.post('models', payload(normalized, { notOnYardModels: ['SRC99'] }))).status, 200);
  const changed = await f.get(); assert.equal(changed.rolling.status, 'stale'); assert.notEqual(changed.previewToken, normalized.previewToken);
  assert.equal((await f.post('models', payload(changed, { previousNotOnYardModels: normalized.notOnYardModels }))).status, 409);
  const before = (await f.store.readState()).state;
  assert.equal((await f.post('models', payload(changed, { notOnYardModels: ['src21'] }))).status, 400);
  assert.equal((await f.post('models', payload(changed, { notOnYardModels: null }))).status, 400);
  assert.deepEqual((await f.store.readState()).state, before, 'invalid edits must not partially save either list');
  assert.equal((await f.post('models', payload(changed, { notOnYardModels: [] }))).status, 200);
  const cleared = await f.get(); assert.deepEqual(cleared.notOnYardModels, []);
  assert.deepEqual((await createStore(f.firebase).readState()).state.stockNotOnYardModels, []);
  assert.equal((await f.post('models', { models: cleared.displayModels, previous: cleared.displayModels })).status, 200, 'existing clients can save the recommended list without resetting exclusions');
  assert.deepEqual((await f.get()).notOnYardModels, []);
  f.auth.user = () => null;
  assert.equal((await f.post('models', payload(cleared))).status, 401);
});
