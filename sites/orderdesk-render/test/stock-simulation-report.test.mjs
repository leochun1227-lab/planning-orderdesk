import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { buildSimulationReport, reportModel } from '../lib/stock-simulation-report.mjs';
import { buildSimulationPdf } from '../server/stock-simulation-pdf.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { fixture } from './helpers/rolling-fixture.mjs';

const dealer = (slug, own) => ({ slug, name: slug === 'a' ? 'Original Dealer' : 'Receiving Dealer', own, jv: !own, target: 20, travelDays: 0,
  yard: { stock: 2 }, transit: { stock: 0 }, vehicles: [{ chassis: `${slug}YARD`, model: 'SRC19', modelYear: '2027', category: 'stock', where: 'yard' }],
  handover: { avgStock: 2, months: [], thisMonth: { stock: 0 } } });
function reportFixture(months = 8) {
  const report = buildStockSimulation({ dealers: [dealer('a', true), dealer('b', false)], rows: [], today: '2026-11-19', months, displayModels: ['SRC19', 'SRP19F 2 Bunks', 'SRH16', 'SRH14'] });
  const action = (chassis, model, from, to, arrival, extra = {}) => ({ chassis, model, modelYear: '2027', from, to, originalDealer: from === 'a' ? 'Original Dealer' : 'Receiving Dealer', proposedDealer: to === 'a' ? 'Original Dealer' : 'Receiving Dealer',
    group: 'locked', originalAu: '2026-12-28', simulatedAu: '2026-12-28', plannedAu: '2026-12-28', plannedArrival: arrival, originalArrival: arrival, receive: true, action: from === to ? 'keep' : 'reallocate', reallocated: from !== to, reason: 'balance', ...extra });
  report.own.actions = [action('CANCEL1', 'SRP17', 'a', '', '', { action: 'cancel', reallocated: false, receive: false, reason: 'notOnYard' }), action('MOVE1', 'SRC19', 'a', 'b', '2027-01-04'), action('MOVE3', 'SRH14', 'a', 'b', '2028-03-01'),
    action('OLD26', 'SRC19', 'a', 'a', '2027-01-04', { modelYear: '2026' }), action('REVIEW1', 'SRP19F 2 Bunks', 'a', '', '', { action: 'pending', receive: false, reallocated: false })];
  report.jv.actions = [action('MOVE2', 'SRH16', 'b', 'a', '2027-02-04'), action('KEEP1', 'SRP19F 2 Bunks', 'b', 'b', '2027-01-08'), action('KEEP2', 'SRH16', 'b', 'b', '2027-03-01'), action('KEEP3', 'SRH14', 'b', 'b', '2027-03-02'), action('POOL1', 'SRP19F 2 Bunks', 'b', '', '', { action: 'pool', receive: false, reallocated: false })];
  return report;
}

test('SRC and SRP retain exact models; other prefixes aggregate and monthly distribution uses receiving dealers after adjustments', () => {
  const report = reportFixture(), before = structuredClone(report), result = buildSimulationReport(report), b = result.dealers[1];
  assert.equal(reportModel(' SRC22F 3 Bunks '), 'SRC22F 3 BUNKS'); assert.equal(reportModel('SRP19F 2 Bunks'), 'SRP19F 2 BUNKS'); assert.equal(reportModel('SRH16F 1 Bunk'), 'SRH');
  const src = b.distribution.find(r => r.label === 'SRC19'); assert.equal(src.yard, 1); assert.equal(src.arrivals['2027-01'], 1);
  const srp = b.distribution.find(r => r.label === 'SRP19F 2 BUNKS'); assert.equal(srp.arrivals['2027-01'], 1, 'cancelled and pool vans are excluded');
  const srh = b.distribution.find(r => r.label === 'SRH'); assert.equal(srh.arrivals['2027-03'], 2); assert.equal(srh.later, 1); assert.equal(srh.total, 3);
  assert.equal(result.dealers[0].distribution.find(r => r.label === 'SRC19').total, 1, 'outgoing MOVE1 and MY2026 OLD26 do not remain as MY2027 supply');
  assert.equal(result.dealers[0].distribution.find(r => r.label === 'SRP19F 2 BUNKS').review, 1); assert.equal(b.showLater, true);
  assert.deepEqual(report, before, 'report generation does not change a simulation');
});

test('incoming and outgoing reallocations appear on both relevant dealer pages but global totals count each chassis once', () => {
  const report = reportFixture(); report.independent.actions.push(report.own.actions[1]);
  const result = buildSimulationReport(report), [a, b] = result.dealers;
  assert.deepEqual(result.totals, { cancellations: 1, reallocations: 3, dealers: 2 });
  assert.equal(a.summary.reallocationIn, 1); assert.equal(a.summary.reallocationOut, 2); assert.equal(a.summary.cancellations, 1);
  assert.equal(b.summary.reallocationIn, 2); assert.equal(b.summary.reallocationOut, 1); assert.equal(b.summary.cancellations, 0);
  assert.equal(result.dealers.reduce((n, d) => n + d.summary.reallocationIn, 0), result.totals.reallocations);
  assert.equal(result.dealers.reduce((n, d) => n + d.summary.reallocationOut, 0), result.totals.reallocations);
  assert.equal(b.incoming.find(a => a.chassis === 'MOVE1').originalDealer, 'Original Dealer');
});

test('the engine exposes retained MY2027 yard models for the report, including off-lineup units and excluding virtual unknown / MY2026', () => {
  const d = dealer('a', true); d.vehicles.push({ chassis: 'DELETED', model: 'SRT18', modelYear: '2027', category: 'stock', where: 'yard' }, { chassis: 'OLD', model: 'SRC19', modelYear: '2026', category: 'stock', where: 'yard' });
  const r = buildStockSimulation({ dealers: [d], rows: [], today: '2026-11-19', assumptions: { dealers: [{ slug: 'a', currentStock: 10 }] } });
  assert.equal(r.own.dealers[0].my2027Yard.length, 2); assert.equal(buildSimulationReport(r).dealers[0].distribution.find(r => r.label === 'SRT').yard, 1);
});

test('PDF has one assumptions page plus one page per dealer, with no overflow pages even for large action lists and 14 months', async () => {
  const report = reportFixture(14), prototype = report.own.actions.find(a => a.chassis === 'MOVE1');
  report.own.actions.push(...Array.from({ length: 220 }, (_, i) => ({ ...prototype, chassis: `MANY${String(i).padStart(5, '0')}` })));
  const before = structuredClone(report), bytes = await buildSimulationPdf(report, { generatedAt: '2026-11-19T00:00:00Z' }), text = bytes.toString('latin1');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 3);
  const heights = [...text.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map(m => Number(m[1].trim().split(/\s+/).at(-1)));
  assert.ok(heights.some(h => h > 5000), 'long dealer pages expand instead of truncating or generating continuation pages');
  assert.deepEqual(report, before);
});

test('PDF download uses the complete current preview, requires the normal session/origin, rejects stale or changed assumptions and never writes state', async () => {
  const f = fixture({ stockCount: 3, customerCount: 2 }), store = createStore(createMemoryFirebase());
  await store.writeState({ orders: {}, events: {}, imports: {}, meta: {}, refs: {} }, '0');
  const auth = { user: () => ({ name: 'Planner' }) }, app = createApp({ store, auth, env: {}, productionSource: { current: async () => f.sources } });
  const r = await (await app.request('/api/stock-forecast')).json(), before = await store.readState();
  const payload = { multiplier: r.multiplier, months: r.months, assumptions: r.assumptions, previewToken: r.previewToken };
  const post = (body, origin = 'http://localhost') => app.request('/api/stock-forecast/report.pdf', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post(payload); assert.equal(ok.status, 200, await ok.clone().text()); assert.equal(ok.headers.get('Content-Type'), 'application/pdf'); assert.match(ok.headers.get('Content-Disposition'), /Dealer_Allocations_and_Adjustments/);
  const pdf = Buffer.from(await ok.arrayBuffer()); assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, ['own', 'jv', 'independent'].reduce((n, g) => n + r[g].dealers.length, 1));
  assert.deepEqual(await store.readState(), before);
  const changed = structuredClone(payload); changed.assumptions.dealers[0].currentStock++;
  assert.equal((await post(changed)).status, 409); assert.equal((await post({ ...payload, previewToken: 'stale' })).status, 409);
  assert.equal((await post(payload, 'https://wrong.example')).status, 403);
  auth.user = () => null; assert.equal((await post(payload)).status, 401);
});
