import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { configureDealers, dealerSnapshot } from '../lib/dealership.mjs';
import { simulationExportSheets, buildSimulationWorkbook } from '../lib/stock-simulation-export.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { replayInventoryBasis } from '../lib/inventory-basis-replay.mjs';
import { fixture } from './helpers/rolling-fixture.mjs';

const today = '2026-11-19';
const dealer = (slug, extra = {}) => ({ slug, name: slug, target: 20, travelDays: 0, own: false, independent: true, yard: { stock: 0, customer: 0, second: 0 }, transit: { stock: 0 }, handover: { avgStock: 0, months: [], thisMonth: { stock: 0 }, stockByModel: {} }, vehicles: [], ...extra });
const row = (chassis, extra = {}) => ({ chassis, model: 'SRC21', modelYear: '2027', customer: 'Stock', dealer: 'a', group: 'locked', auEnd: '2027-01-15', ...extra });
const yard = (chassis, extra = {}) => ({ chassis, model: 'SRC21', modelYear: '2027', category: 'stock', where: 'yard', ...extra });
const allDealers = r => ['own', 'jv', 'independent'].flatMap(g => r[g].dealers);
const allActions = r => ['own', 'jv', 'independent'].flatMap(g => r[g].actions);
const run = (dealers, rows = [], extra = {}) => buildStockSimulation({ today, dealers, rows, displayModels: ['SRC21', 'SRC19'], ...extra });

test('includes every dealer, derives weekly defaults from exact completed-month days, and preserves source inputs', () => {
  const dealers = [dealer('a', { handover: { avgStock: 30.7, months: [{ month: '2026-08', stock: 31 }, { month: '2026-09', stock: 30 }, { month: '2026-10', stock: 31 }], thisMonth: { stock: 999 } } }), dealer('missing', { target: null, travelDays: null })];
  const before = structuredClone(dealers), result = run(dealers);
  assert.equal(allDealers(result).length, 2); assert.equal(result.defaults.find(d => d.slug === 'a').weeklyStock, 7);
  const missing = allDealers(result).find(d => d.slug === 'missing'); assert.equal(missing.settingsNeeded, true); assert.equal(missing.monthly[0].idealMultiple, null);
  assert.deepEqual(dealers, before);
  assert.equal(configureDealers([dealers[1]], {}, today).length, 1, 'unknown Ideal does not remove a dealer before simulation');
});

test('MY2027 coverage precedes ratio balancing, uses yard and future transit, and supports cross-group reallocation', () => {
  const dealers = [dealer('a', { own: true, yard: { stock: 1 }, vehicles: [yard('YARD1')] }), dealer('b', { jv: true, yard: { stock: 10 }, vehicles: [yard('OLD', { modelYear: '2026' })] }), dealer('c', { target: 40, vehicles: [yard('PGI1', { where: 'transit', since: '2026-12-01', arrive: '2026-12-01' })] })];
  const r = run(dealers, [row('SRC1'), row('SRC2', { model: 'SRC19', auEnd: '2027-01-16' }), row('SRC3', { model: 'SRC19', auEnd: '2027-02-16' }), row('SRC4', { model: 'SRC19', auEnd: '2027-03-16' })]);
  assert.equal(allActions(r).find(a => a.chassis === 'SRC1').to, 'b', 'missing MY2027 model wins even though another dealer has a lower stock/Ideal');
  assert.equal(r.totals.canceled, 0); assert.equal(r.coverage.covered, 6); assert.equal(r.coverage.missing, 0);
  for (const d of allDealers(r)) assert.deepEqual([...d.coverage.models].sort(), ['SRC19', 'SRC21']);
  assert.equal(allActions(r).filter(a => a.model === 'SRC19' && a.coverageAdded).length, 3, 'coverage is not reset in February/March');
  assert.ok(allActions(r).some(a => a.from === 'a' && a.to === 'b' && a.reallocated));
});

test('balances projected Ideal ratios even when all stores are below their ceilings', () => {
  const dealers = [dealer('a', { own: true, target: 10, yard: { stock: 1 }, vehicles: [yard('YA')] }), dealer('b', { jv: true, target: 20, yard: { stock: 1 }, vehicles: [yard('YB')] }), dealer('c', { target: 30, yard: { stock: 1 }, vehicles: [yard('YC')] })];
  const rows = Array.from({ length: 20 }, (_, i) => row(`SRC${String(i).padStart(4, '0')}`));
  const r = run(dealers, rows, { displayModels: ['SRC21'], multiplier: 3 });
  assert.ok(r.totals.reallocated > 0);
  const ratios = allDealers(r).map(d => d.monthly.find(m => m.month === '2027-01').idealMultiple);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) <= .1, JSON.stringify(ratios));
  assert.deepEqual(allActions(run(dealers, rows, { displayModels: ['SRC21'], multiplier: 3, months: 14 })), allActions(r), 'chart range cannot change allocations');
});

test('uses future depletion and fixed arrivals instead of ranking today-only yard stock', () => {
  const dealers = [dealer('a', { target: 10, yard: { stock: 10 }, vehicles: [yard('YA')] }), dealer('b', { target: 10, yard: { stock: 1 }, vehicles: [yard('YB')] })];
  const r = run(dealers, [row('SRC1', { group: 'au' })], { displayModels: ['SRC21'], assumptions: { dealers: [{ slug: 'a', weeklyStock: 7 }] } });
  assert.equal(allActions(r)[0].to, 'a', 'high current inventory is consumed before this supply arrives');
  const future = structuredClone(dealers); future[0].vehicles.push(...Array.from({ length: 10 }, (_, i) => yard(`PGI${i}`, { where: 'transit', since: '2027-01-01', arrive: '2027-01-01' })));
  const reserved = run(future, [row('SRC1', { group: 'au' })], { displayModels: ['SRC21'] });
  assert.equal(allActions(reserved).find(a => a.chassis === 'SRC1').to, 'b', 'already committed future arrivals are reserved before allocation');
});

test('only locked not-on-yard/deleted models cancel; retained models and started supply survive impossible ceilings', () => {
  const rows = ['au', 'sea', 'cn', 'locked', 'rolling'].flatMap((group, i) => [row(`SRC${i}N`, { group, model: 'SRC20' }), row(`SRC${i}D`, { group, model: 'SRT18' }), row(`SRC${i}R`, { group })]);
  rows.push(row('SRP1', { model: 'SRP18F 2 Bunks' }), row('UNKNOWN', { model: 'SRC99' }));
  const r = run([dealer('a', { target: 1, yard: { stock: 20 } })], rows, { assumptions: { dealers: [{ slug: 'a', cap: 0 }] } });
  assert.equal(r.totals.canceled, 3);
  assert.ok(allActions(r).filter(a => a.action === 'cancel').every(a => a.group === 'locked' && ['notOnYard', 'deleted'].includes(a.policy)));
  assert.ok(allActions(r).filter(a => ['au', 'sea', 'cn'].includes(a.group)).every(a => a.receive && !a.delayed));
  assert.ok(allActions(r).filter(a => a.model === 'SRC21').every(a => a.receive));
  assert.ok(r.totals.limitConflicts > 0); assert.ok(allDealers(r)[0].overCapMonths > 0);
  assert.ok(allActions(r).every(a => a.action !== 'delay'));
});

test('virtual finish overrides, per-dealer transit and global shifts change arrival months with no operational delays', () => {
  const rows = [row('SRC1', { auEnd: '2026-12-31' }), row('SRC2', { auEnd: '' })], dealers = [dealer('a')];
  const r = run(dealers, rows, { assumptions: { shiftDays: 20, finishDates: { SRC1: '2027-02-26', SRC2: '2027-03-01' }, dealers: [{ slug: 'a', leadDays: 3 }] } });
  const a = allActions(r).find(a => a.chassis === 'SRC1'); assert.equal(a.simulatedAu, '2027-02-26'); assert.equal(a.plannedArrival, '2027-03-01'); assert.equal(a.delayed, false);
  const d = allDealers(r)[0]; assert.equal(d.monthly.find(m => m.month === '2027-03').stockIn, 2); assert.equal(d.monthly.find(m => m.month === '2027-01').stockIn, 0);
  assert.equal(r.startLocked, '2027-02-26');
});

test('deduplicates physical Stock, excludes customers/second-hand/motorhomes, and conserves monthly inventory', () => {
  const dealers = [dealer('a', { own: true, yard: { stock: 5 }, vehicles: [yard('SRC1', { where: 'transit', arrive: '2026-12-01' }), yard('Y1')] }), dealer('b')];
  const r = run(dealers, [row('SRC1', { group: 'sea' }), row('SRC2'), row('SRC2'), row('CUSTOMER', { customer: 'Alice' }), row('SRM1'), row('SRV2')], { assumptions: { dealers: [{ slug: 'a', weeklyStock: 1.25 }, { slug: 'b', weeklyStock: 1.5 }] } });
  assert.equal(new Set(allActions(r).map(a => a.chassis)).size, allActions(r).length);
  assert.equal(r.warnings.filter(w => w.code === 'duplicate').length, 2);
  assert.ok(!allActions(r).some(a => ['SRM1', 'SRV2', 'CUSTOMER'].includes(a.chassis)));
  for (const d of allDealers(r)) { let previous = d.yard.stock; for (const m of d.monthly) { assert.ok(Math.abs(previous + m.stockIn - m.stockOut - m.endStock) < .025); assert.ok(m.endStock >= 0); previous = m.endStock; } }
  assert.ok(allDealers(r).some(d => d.monthly.some(m => m.unmet > 0)));
});

test('applicable-model exclusions, receiving pauses and missing settings remain explicit; normal vehicles never cancel', () => {
  const r = run([dealer('a', { target: null, travelDays: null }), dealer('b'), dealer('c', { paused: true })], [row('SRC1')], { assumptions: { dealers: [{ slug: 'b', models: ['SRC19'] }] } });
  assert.equal(r.totals.canceled, 0); assert.equal(allActions(r)[0].action, 'pending');
  assert.equal(allDealers(r).length, 3); assert.equal(allDealers(r).find(d => d.slug === 'c').stopReceiving, true);
  const configured = run([dealer('a', { target: null, travelDays: null })], [row('SRC1')], { assumptions: { dealers: [{ slug: 'a', ideal: 15, cap: 20, leadDays: 7 }] } });
  assert.equal(allActions(configured)[0].receive, true);
  const virtual = run([dealer('a')], [], { assumptions: { dealers: [{ slug: 'a', currentStock: 100 }] } }); assert.equal(virtual.coverage.covered, 0);
});

test('model year is carried from physical sources or the exact chassis schedule, without inferring from chassis digits', () => {
  const raw = { yard: { frankston: { SRC1: { model: 'SRC21', wholesaleBillToName: 'Regent' }, SRC2: { model: 'SRC19', modelYear: '2027', wholesaleBillToName: 'Regent' } } }, schedule: [{ Chassis: 'SRC1', Model: 'SRC21', 'Model Year': 2027 }] };
  const snapshot = dealerSnapshot(raw, today, { all: true, towableOnly: true });
  assert.ok(snapshot[0].vehicles.every(v => v.modelYear === '2027')); assert.equal(run(snapshot).own.dealers[0].coverage.covered, 2);
});

test('physical coverage can use exact production chassis metadata; a reduced virtual yard preserves applicable MY2027 first', () => {
  const ds = [dealer('a', { yard: { stock: 3 }, vehicles: [yard('KEEP', { modelYear: '' }), yard('DELETED', { model: 'SRT18' }), yard('OLD', { model: 'SRC19', modelYear: '2026' })] })];
  const r = run(ds, [row('KEEP')], { assumptions: { dealers: [{ slug: 'a', currentStock: 1 }] } });
  assert.equal(r.coverage.covered, 1); assert.deepEqual(allDealers(r)[0].coverage.models, ['SRC21']); assert.equal(allActions(r).length, 0, 'the physical vehicle does not become a second production arrival');
  const t = run([dealer('a')], [row('TRANSPORT', { group: 'transport' })]);
  assert.equal(allDealers(t)[0].transit.stock, 1, 'the transit heading includes Transport Stock');
});

test('rejects malformed or unknown assumptions rather than silently losing edits', () => {
  for (const assumptions of [null, [], { shiftDays: 1.1 }, { shiftDays: 366 }, { dealers: [{ slug: 'other' }] }, { dealers: [{ slug: 'a' }, { slug: 'a' }] }, { dealers: [{ slug: 'a', ideal: 0 }] }, { dealers: [{ slug: 'a', leadDays: -1 }] }, { dealers: [{ slug: 'a', currentStock: '50' }] }, { finishDates: { UNKNOWN: '2027-01-01' } }, { finishDates: { SRC1: '2027-02-30' } }])
    assert.throws(() => run([dealer('a')], [row('SRC1')], { assumptions }));
});

test('exports the displayed assumptions, cross-group allocations, coverage, actual handovers and month-end ratios', async () => {
  const r = run([dealer('a'), dealer('b', { own: true })], [row('SRC1'), row('SRC2')]);
  const sheets = simulationExportSheets(r, false); assert.equal(sheets.length, 12); assert.ok(sheets.some(s => s.name === 'MY2026 Reallocation')); assert.ok(sheets.some(s => s.name === 'MY2027 Reallocation')); assert.equal(sheets.find(s => s.name === 'Vehicle allocations').rows.length, 2);
  assert.equal(sheets.find(s => s.name === 'Monthly inventory').rows.length, 16);
  const wb = await buildSimulationWorkbook(r, false), buffer = await wb.xlsx.writeBuffer(); assert.ok(buffer.byteLength > 8000);
  const ExcelJS = (await import('exceljs')).default, loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(buffer);
  assert.equal(loaded.getWorksheet('Assumptions').getCell('A6').value, 'b');
});

test('simulation API is read-only; saving binds the complete assumptions to the preview and persists overrides', async () => {
  const f = fixture(), firebase = createMemoryFirebase(), store = createStore(firebase);
  await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const before = await store.readState(), auth = { user: () => ({ name: 'Planner' }) }, app = createApp({ store, auth, env: {}, productionSource: { current: async () => f.sources } });
  const post = (path, body, origin = 'http://localhost') => app.request(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const initial = await (await app.request('/api/stock-forecast')).json();
  assert.ok(initial.independent.dealers.some(d => d.slug === 'unknown'), 'dealer with missing Ideal is present in the live API');
  const assumptions = structuredClone(initial.assumptions); assumptions.dealers.find(d => d.slug === 'frankston').currentStock = 99;
  const response = await post('/api/stock-forecast/simulate', { assumptions, months: 14 }); assert.equal(response.status, 200, await response.clone().text());
  const report = await response.json(); assert.notEqual(report.previewToken, initial.previewToken); assert.deepEqual(await store.readState(), before, 'preview does not write state');
  const payload = { multiplier: report.multiplier, months: report.months, assumptions: report.assumptions, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId };
  const changed = structuredClone(payload); changed.assumptions.dealers.find(d => d.slug === 'frankston').currentStock++;
  assert.equal((await post('/api/stock-forecast/save', changed)).status, 409);
  assert.equal((await post('/api/stock-forecast/save', payload)).status, 200);
  const persisted = await (await app.request('/api/stock-forecast?months=14')).json(); assert.equal(persisted.own.dealers.find(d => d.slug === 'frankston').yard.stock, 99);
  assert.equal(persisted.savedCurrent, true); assert.deepEqual((await store.readState()).state.orders, {});
  assert.equal((await post('/api/stock-forecast/save', payload)).status, 409, 'concurrent/stale plan IDs cannot overwrite a newer plan');
  assert.equal((await post('/api/stock-forecast/simulate', { assumptions }, 'https://elsewhere.example')).status, 403);
  auth.user = () => null; assert.equal((await post('/api/stock-forecast/simulate', {})).status, 401);
});

test('applying reallocations updates AU and sea dealers while preserving physical dates', () => {
  const rows = ['au', 'sea'].map((group, i) => row(`SRC${i}`, { group, auEnd: `2027-01-${15 + i}` }));
  const dealers = [dealer('a', { yard: { stock: 20 }, target: 1 }), dealer('b')];
  const report = run(dealers, rows), capacity = new Map(rows.map(r => [r.auEnd, { towable: 1, srm: 0, srv: 0 }]));
  assert.equal(allActions(report).filter(a => a.reallocated).length, 1, 'retain the sender’s last MY2027 model instead of transferring it twice');
  const applied = replayInventoryBasis({ line: { today, rows }, report, capacity, dealers });
  assert.ok(applied.line.rows.every((r, i) => r.dealer === allActions(report).find(a => a.chassis === r.chassis).proposedDealer && r.auEnd === rows[i].auEnd));
});
