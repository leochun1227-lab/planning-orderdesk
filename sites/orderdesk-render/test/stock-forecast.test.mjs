import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockForecast, addCalendarMonth, forecastMultiplier, DISPLAY_MODELS } from '../lib/stock-forecast.mjs';
import { dealerSnapshot } from '../lib/dealership.mjs';
import { forecastExportSheets, buildForecastWorkbook } from '../lib/stock-forecast-export.mjs';
import { createApp } from '../server/app.mjs';

const today = '2026-11-17';
function dealer(slug, { yard = 0, avg = 0, target = 40, own = false, travelDays = 7, paused = false, vehicles = [] } = {}) {
  const names = { frankston: 'Frankston', geelong: 'Geelong', 'st-james': 'St James', traralgon: 'Traralgon', bundaberg: 'Bundaberg', heatherbrae: 'Heatherbrae' };
  return { slug, name: names[slug], target, own, jv: !own, travelDays, paused,
    yard: { stock: yard, customer: 0, second: 0, total: yard }, transit: { stock: vehicles.filter(v => v.where === 'transit').length }, vehicles,
    handover: { avgStock: avg, avgCustomer: 0, months: [], thisMonth: { stock: 0 }, stockByModel: {} } };
}
const row = (chassis, dealer, group = 'locked', auEnd = '2027-01-31', extra = {}) => ({ chassis, dealer, group, auEnd, customer: 'Stock', model: 'SRC21', modelYear: '2027', line: 'Towable', ...extra });
const run = (dealers, rows, extra = {}) => buildStockForecast({ dealers, rows, today, ...extra });
const find = (report, chassis) => [...report.own.actions, ...report.jv.actions].find(a => a.chassis === chassis);

test('Towable snapshot excludes SRV/SRM from yard, PGI and three-month stock sales without altering the original snapshot', () => {
  const raw = { yard: { frankston: { SRC1: { model: 'SRC21', wholesaleBillToName: 'Regent' }, SRM1: { model: 'SRM22.1', wholesaleBillToName: 'Regent' }, BADKEY: { model: 'SRV19.1', wholesaleBillToName: 'Regent' } } },
    pgi: { SRV2: { model: 'SRV19.1', dealer: 'Frankston', customer: 'Stock', pgidate: '17/11/2026' } },
    schedule: [{ Chassis: 'SRC3', Customer: 'Stock', Model: 'SRC21' }, { Chassis: 'SRM3', Customer: 'Stock' }],
    handover: { frankston: { SRC3: { handoverAt: '2026-10-04' }, SRM3: { handoverAt: '2026-10-04' } } } };
  const all = dealerSnapshot(raw, today), filtered = dealerSnapshot(raw, today, { towableOnly: true });
  assert.equal(all[0].yard.stock, 3); assert.equal(all[0].transit.stock, 1); assert.equal(all[0].handover.avgStock, 0.7);
  assert.equal(filtered[0].yard.stock, 1); assert.equal(filtered[0].transit.stock, 0); assert.equal(filtered[0].handover.avgStock, 0.3);
  assert.equal(filtered[0].handover.stockByModel.SRC21, 1 / 3);
});

test('higher multiplier changes real cancellations, while JV never reallocates and pool never counts as cancellation or arrival', () => {
  const dealers = [dealer('bundaberg', { yard: 52 }), dealer('heatherbrae')];
  const rows = [row('SRC1', 'Bundaberg', 'cn'), row('SRC2', 'Bundaberg', 'locked', '2027-01-31', { model: 'SRC19' }), row('SRC3', 'Bundaberg', 'customers'), row('SRC4', 'Bundaberg', 'processing')];
  const before = structuredClone({ dealers, rows }), low = run(dealers, rows), high = run(dealers, rows, { multiplier: 1.5 });
  assert.equal(low.jv.summary.canceled, 1); assert.equal(low.jv.summary.poolNotBuilt, 1); assert.equal(low.jv.summary.pending, 2);
  assert.equal(high.jv.summary.canceled, 0); assert.equal(high.jv.summary.poolNotBuilt, 1);
  assert.equal(find(low, 'SRC1').action, 'pending', 'started stock is unresolved rather than cancelled');
  assert.equal(find(high, 'SRC1').action, 'keep'); assert.equal(find(high, 'SRC2').action, 'keep');
  assert.ok([...low.jv.actions, ...high.jv.actions].every(a => !a.reallocated && (!a.receive || a.from === a.to)));
  assert.equal(low.jv.dealers[0].monthly.reduce((s, m) => s + m.stockIn, 0), 0);
  assert.equal(high.jv.dealers[0].monthly.reduce((s, m) => s + m.stockIn, 0), 2);
  assert.deepEqual({ dealers, rows }, before, 'cached Portal and line inputs remain untouched');
  assert.deepEqual(run(dealers, rows, { months: 14 }).jv.summary, low.jv.summary, 'chart length does not change the planning recommendations');
});

test('calendar month limit clamps Jan31 to Feb28 and checks AU completion as well as arrival', () => {
  assert.equal(addCalendarMonth('2027-01-31'), '2027-02-28'); assert.equal(addCalendarMonth('2028-01-31'), '2028-02-29');
  const result = run([dealer('bundaberg', { yard: 14, avg: 3, target: 10 })], [row('SRC1', 'Bundaberg', 'cn')], { today: '2027-01-31' });
  const a = find(result, 'SRC1'); assert.equal(a.action, 'delay'); assert.ok(a.delayDays > 0);
  assert.ok(a.plannedAu <= '2027-02-28'); assert.ok(a.plannedArrival <= addCalendarMonth(a.originalArrival));
  const noSpace = run([dealer('bundaberg', { yard: 100, avg: 0.1 })], [row('SRC2', 'Bundaberg')]);
  assert.equal(find(noSpace, 'SRC2').action, 'cancel'); assert.equal(find(noSpace, 'SRC2').plannedArrival, '');
});

test('self-owned supply can reallocate with route-only delay; Traralgon receives zero and shortages never become negative stock', () => {
  const dealers = [dealer('frankston', { own: true, yard: 100, travelDays: 1 }), dealer('st-james', { own: true, target: 60, travelDays: 20 }), dealer('traralgon', { own: true, yard: 18, avg: 6, travelDays: null, paused: true, vehicles: [{ chassis: 'SRH1', where: 'transit', category: 'stock', model: 'SRH16', arrive: '' }] })];
  const r = run(dealers, [row('SRC1', 'Frankston', 'cn'), row('SRC2', 'Traralgon', 'au')]);
  const a = find(r, 'SRC1'); assert.equal(a.action, 'reallocate'); assert.equal(a.to, 'st-james'); assert.equal(a.delayDays, 0); assert.equal(a.arrivalDelayDays, 19); assert.equal(a.delayed, true);
  assert.equal(r.own.summary.cnDelayed, 1); assert.equal(r.own.summary.cnCompletionDelayed, 0);
  const t = r.own.dealers.find(d => d.slug === 'traralgon'); assert.equal(t.stopReceiving, true); assert.ok(t.monthly.every(m => m.stockIn === 0 && m.endStock >= 0)); assert.equal(t.monthly.at(-1).endStock, 0);
  assert.equal(find(r, 'SRC2').action, 'blocked'); assert.equal(find(r, 'SRH1').action, 'blocked');
});

test('fixed arrivals and source deduplication remain visible; deleted / non-yard stock is not silently manufactured', () => {
  const d = dealer('bundaberg', { yard: 52, vehicles: [{ chassis: 'SRC1', model: 'SRC21', where: 'transit', category: 'stock', arrive: '2026-11-20' }] });
  const r = run([d], [row('SRC1', 'Bundaberg', 'transport'), row('SRC2', 'Bundaberg', 'au'), row('SRC3', 'Bundaberg', 'locked', '2027-01-31', { model: 'SRT18' }), row('SRC4', 'Bundaberg', 'cn', '2027-01-31', { model: 'SRC20' }), row('SRC5', 'Bundaberg', 'customers', '2027-01-31', { model: 'SRC20' }), row('SRC6', 'Bundaberg', 'locked', '2027-01-31', { model: 'UNKNOWN' }), row('SRM7', 'Bundaberg'), row('SRC8', 'Bundaberg', 'locked', '2027-01-31', { customer: 'Jane' })]);
  assert.equal(r.jv.actions.filter(a => a.chassis === 'SRC1').length, 1); assert.equal(r.warnings.length, 1);
  assert.equal(find(r, 'SRC3').action, 'cancel'); assert.equal(find(r, 'SRC4').action, 'pending'); assert.equal(find(r, 'SRC5').action, 'pool'); assert.equal(find(r, 'SRC6').action, 'pending');
  assert.equal(find(r, 'SRM7'), undefined); assert.equal(find(r, 'SRC8'), undefined);
  assert.ok(r.jv.dealers[0].overCapMonths > 0, 'existing physical excess is not hidden by cancelling unstarted orders');
  assert.equal(r.jv.dealers[0].monthly[0].stockIn, 1);
});

test('download rows and a real XLSX preserve the displayed multiplier, IDs and JV no-reallocation scope', async () => {
  const r = run([dealer('frankston', { own: true, yard: 100, travelDays: 1 }), dealer('st-james', { own: true, target: 60, travelDays: 20 }), dealer('bundaberg', { yard: 52 })], [row('SRC1', 'Frankston', 'cn'), row('SRC2', 'Bundaberg'), row('SRC3', 'Bundaberg', 'customers')]);
  const sheets = forecastExportSheets(r, 'jv'); assert.ok(sheets.every(s => !s.name.includes('Reallocation')));
  assert.ok(!sheets[0].headers.includes('Reallocation'));
  assert.equal(sheets.find(s => s.name === 'JV-取消').rows.length, r.jv.summary.canceled);
  assert.equal(sheets.find(s => s.name === 'JV-库存池不生产').rows.length, r.jv.summary.poolNotBuilt);
  const all = forecastExportSheets(r); assert.equal(all.find(s => s.name === '直营-延期').rows[0][1], 'SRC1'); assert.equal(all.find(s => s.name === '直营-Reallocation').rows[0][1], 'SRC1');
  const wb = await buildForecastWorkbook(r, 'all'), buf = await wb.xlsx.writeBuffer();
  const ExcelJS = (await import('exceljs')).default, loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(buf);
  assert.equal(loaded.getWorksheet('JV-取消').getCell('B6').value, 'SRC2'); assert.match(loaded.getWorksheet('汇总').getCell('A2').value, /Ideal × 1.3/);
  assert.ok(loaded.getWorksheet('直营-延期').getCell('I6').value instanceof Date); assert.equal(loaded.getWorksheet('JV-Reallocation'), undefined);
});

test('yard transfers conserve physical vehicles, distinguish in-transit stock and do not depend on chart length', () => {
  const vehicles = DISPLAY_MODELS.slice(0, 14).flatMap((model, i) => [0, 1].map(j => ({ chassis: `SRCY${i}X${j}`, model, category: 'stock', where: 'yard', days: 100 })));
  const ds = [dealer('frankston', { own: true, yard: 28, target: 10, travelDays: 1, vehicles }), dealer('st-james', { own: true, target: 60, travelDays: 20 })];
  const result = run(ds, []), extended = run(ds, [], { months: 14 });
  assert.ok(result.own.summary.reallocated > 0);
  assert.deepEqual(result.own.actions, extended.own.actions);
  assert.equal(new Set(result.own.actions.map(a => a.chassis)).size, result.own.actions.length);
  for (const m of result.own.dealers[0].monthly) {
    const nextMonth = addCalendarMonth(m.month + '-01'), last = new Date(Date.parse(nextMonth + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const travelling = result.own.actions.filter(a => a.depart <= last && a.plannedArrival > last).length;
    const yard = result.own.dealers.reduce((sum, d) => sum + d.monthly.find(x => x.month === m.month).endStock, 0);
    assert.equal(yard + travelling, 28);
  }
});

test('invalid parameters fail before loading data; the forecast API requires the normal session', async () => {
  for (const n of [NaN, Infinity, '', null, 'bad', 0, -1, 11]) assert.throws(() => forecastMultiplier(n));
  assert.equal(forecastMultiplier('1.5'), 1.5);
  const app = createApp({ store: {}, auth: { user: () => ({ name: 'Test' }) }, env: {} });
  const bad = await app.request('/api/stock-forecast?multiplier=bad'); assert.equal(bad.status, 400);
  assert.equal((await app.request('/api/stock-forecast?months=9')).status, 400);
  const signedOut = createApp({ store: {}, auth: { user: () => null }, env: {} });
  assert.equal((await signedOut.request('/api/stock-forecast?multiplier=1.3')).status, 401);
});
