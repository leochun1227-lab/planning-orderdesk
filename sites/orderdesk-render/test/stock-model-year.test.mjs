import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProtectionCheck } from '../lib/protected-stock.mjs';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
import { dealerStockMetrics, reallocationYears } from '../lib/stock-simulation-metrics.mjs';
import { buildSimulationReport } from '../lib/stock-simulation-report.mjs';
import { simulationExportSheets } from '../lib/stock-simulation-export.mjs';

const digest = v => createHash('sha256').update(v).digest('hex');
const dealer = slug => ({ slug, name: slug, own: true, target: 30, travelDays: 2, yard: { stock: 0, customer: 0, second: 0, total: 0 }, transit: { stock: 0, customer: 0, total: 0 }, vehicles: [], handover: { months: [], avgStock: 0, thisMonth: { stock: 0 } } });
const action = (chassis, year, from, to, arrival, extra = {}) => ({ chassis, kind: 'stock', model: 'SRC21', modelYear: String(year), group: 'locked', from, to, originalDealer: from, proposedDealer: to, action: from === to ? 'keep' : 'reallocate', reallocated: from !== to, receive: true, plannedArrival: arrival, ...extra });

test('retained source vehicles participate normally and protection prevents cancellation without deleting stock', () => {
  const protectedId = 'SRT000123', protect = createProtectionCheck(new Set([digest(protectedId)]));
  const d = dealer('a'), rows = [{ chassis: protectedId, dealer: 'a', model: 'SRT18', modelYear: '2027', customer: 'Stock', group: 'locked', auEnd: '2027-01-01' }];
  const result = buildStockSimulation({ dealers: [d], rows, today: '2026-11-19', protectChassis: protect });
  assert.equal(result.own.actions.length, 1); assert.notEqual(result.own.actions[0].action, 'cancel');
  assert.equal(result.own.actions[0].receive, true); assert.equal(result.own.actions[0].cancellationProtected, true);
  assert.equal(result.finishRows.length, 1); assert.equal(result.totals.canceled, 0);
  assert.equal(protect(' srt-000123 '), true);
});

test('latest MY2026 arrival follows the receiving dealer, includes dates beyond chart range and flags unknown supply; customer/cancel/pool rows do not count', () => {
  const rows = [action('A', 2026, 'a', 'b', '2027-10-15'), action('B', 2026, 'b', 'b', '2028-01-30'), action('C', 2027, 'b', 'b', '2029-01-01'), action('D', 2026, 'b', 'b', '2029-02-01', { kind: 'customer' }), action('E', 2026, 'b', '', '', { action: 'cancel', receive: false }), action('F', 2026, 'b', '', '', { action: 'pool', receive: false }), action('G', 2026, 'b', '', '', { action: 'pending', reallocated: false, receive: false })];
  const a = dealerStockMetrics('a', rows), b = dealerStockMetrics('b', rows);
  assert.equal(a.latestMY2026Arrival, ''); assert.equal(b.latestMY2026Arrival, '2028-01-30'); assert.equal(b.pendingMY2026Arrivals, 1);
});

test('MY2026 and MY2027 transfers have independent IN/OUT counts; unknown years remain visible and globally count once', () => {
  const rows = [action('A', 2026, 'a', 'b', '2027-01-01'), action('B', 2027, 'b', 'a', '2027-02-01'), action('C', '', 'a', 'b', '2027-02-02'), action('D', 2027, 'a', 'b', '2027-03-01', { kind: 'customer' })];
  assert.deepEqual(reallocationYears(rows), { '2026': 1, '2027': 1, other: 1 });
  const a = dealerStockMetrics('a', rows); assert.deepEqual(a.reallocationByMY['2026'], { incoming: 0, outgoing: 1 }); assert.deepEqual(a.reallocationByMY['2027'], { incoming: 1, outgoing: 0 });
  const report = buildStockSimulation({ dealers: [dealer('a'), dealer('b')], rows: [], today: '2026-11-19' }); report.own.actions = rows;
  const projection = buildSimulationReport(report); assert.equal(projection.totals.reallocations, 3); assert.equal(projection.dealers[0].reallocationGroups.find(g => g.year === '2026').outgoing.length, 1);
});

test('top arrival bars cover all twelve months of calendar 2027, count MY2027 SRC/SRP Stock only, and do not hide outside-year or unknown arrivals', () => {
  const rows = [action('A', 2027, 'a', 'b', '2027-01-01'), action('B', 2027, 'a', 'b', '2027-12-31', { model: 'SRP19F 2 Bunks' }), action('C', 2026, 'a', 'b', '2027-03-01'), action('D', 2027, 'a', 'b', '2027-03-01', { model: 'SRH16' }), action('E', 2027, 'a', 'b', '2026-12-01'), action('F', 2027, 'b', '', '', { action: 'pending', receive: false, reallocated: false }), action('G', 2027, 'a', 'b', '2027-03-01', { kind: 'customer' })];
  const m = dealerStockMetrics('b', rows).my2027SrcSrpArrivals;
  assert.equal(m.months.length, 12); assert.deepEqual(m.months[0], { month: '2027-01', src: 1, srp: 0 }); assert.deepEqual(m.months[11], { month: '2027-12', src: 0, srp: 1 }); assert.equal(m.outsideYear, 1); assert.equal(m.unresolved, 1);
  assert.equal(m.months.reduce((n, v) => n + v.src + v.srp, 0), 2);
  assert.equal(dealerStockMetrics('a', rows).my2027SrcSrpArrivals.months.reduce((n, v) => n + v.src + v.srp, 0), 0);
});

test('Excel exports separate year-specific transfers and latest MY2026 arrival summaries', () => {
  const report = buildStockSimulation({ dealers: [dealer('a'), dealer('b')], rows: [], today: '2026-11-19' });
  report.own.actions = [action('A', 2026, 'a', 'b', '2027-02-01'), action('B', 2027, 'a', 'b', '2027-03-01')];
  const sheets = simulationExportSheets(report, false);
  assert.equal(sheets.find(s => s.name === 'MY2026 Reallocation').rows.length, 1); assert.equal(sheets.find(s => s.name === 'MY2027 Reallocation').rows.length, 1); assert.equal(sheets.find(s => s.name === 'MY2027 SRC SRP arrivals').rows.length, 24);
});
