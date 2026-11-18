import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBalancedRolling, rollingCustomerPercent, weekOf } from '../lib/balanced-rolling.mjs';
import { buildProductionLine } from '../lib/production-line.mjs';
import { buildStockForecast } from '../lib/stock-forecast.mjs';
import { recommendPoolStock, stockInputFingerprint, saveStockOpinion } from '../lib/stock-rolling.mjs';
import { buildRollingReport } from '../lib/rolling-report.mjs';
import { today, plus, row, fixture } from './helpers/rolling-fixture.mjs';

function refresh(f) {
  f.input.fingerprint = stockInputFingerprint({ line: f.line, dealers: f.dealers, capacity: f.capacity, settings: f.sources.settings });
  f.input.plan = saveStockOpinion({ report: buildStockForecast({ dealers: f.dealers, rows: f.line.rows, today }), fingerprint: f.input.fingerprint, actor: 'Test' });
  return f;
}
test('all signed customers remain pooled without consuming capacity until explicitly selected', () => {
  const f = fixture(); assert.equal(f.line.counts.rolling, 0);
  assert.equal(f.line.rows.filter(r => r.group === 'customers' && r.customer.startsWith('Customer')).length, 40);
  assert.ok(f.line.rows.filter(r => r.group === 'customers').every(r => !r.auForecast));
  const p = buildBalancedRolling({ ...f.input, quantity: 20 });
  const applied = buildProductionLine({ ...f.sources, today, orders: {}, rollingSchedule: p.schedule });
  assert.equal(applied.counts.rolling, 20);
  assert.equal(applied.rows.filter(r => r.group === 'customers' && r.waitingRolling).length, 40 - p.customerCount);
});
test('settable weekly mix is spread across weeks with cumulative whole-unit rounding', () => {
  for (const percent of [0, 25, 35, 50, 100]) {
    const f = fixture({ customerCount: 100, stockCount: 160 });
    const p = buildBalancedRolling({ ...f.input, quantity: 80, customerPercent: percent });
    assert.equal(p.scheduled, 80); assert.equal(p.customerCount, Math.round(80 * percent / 100));
    assert.equal(p.customerPercent, percent); assert.equal(p.weeks.length, 4);
    for (const w of p.weeks) { assert.ok(Math.abs(w.customer - w.target * percent / 100) < 1.00001); assert.equal(w.ratioMet, true); }
    assert.equal(p.quantityMet, true); assert.equal(p.actualGap, 0);
  }
  for (const v of ['', null, -1, 101, Infinity, 'no']) assert.throws(() => rollingCustomerPercent(v));
});
test('quantity wins over mix: use ready signed customers when safe real Stock is insufficient', () => {
  const f = fixture({ stockCount: 3 }), p = buildBalancedRolling({ ...f.input, quantity: 20, customerPercent: 35 });
  assert.equal(p.scheduled, 20); assert.equal(p.stockCount, 3); assert.equal(p.customerCount, 17); assert.equal(p.newOrders, 0);
  assert.ok(p.weeks.some(w => !w.ratioMet));
  const over = fixture({ overstock: true }), q = buildBalancedRolling({ ...over.input, quantity: 20 });
  assert.equal(q.customerCount, 20); assert.equal(q.stockCount, 0); assert.equal(q.scheduled, 20);
});
test('customer receipt date is FIFO; later request dates gate AU finish without losing earlier signatures', () => {
  const f = fixture({ customerCount: 0, stockCount: 0, extraRows: [
    row('SRCFIFO1', { customer: 'Old', signedAt: plus(today, -25), inSchedule: true, requestDate: plus(today, 128) }),
    row('SRCFIFO2', { customer: 'Second', signedAt: plus(today, -20), inSchedule: true, requestDate: plus(today, 111) }),
    row('SRCFIFO3', { customer: 'Third', signedAt: plus(today, -10), inSchedule: true, requestDate: plus(today, 111) }),
    row('SRCUNSIGNED', { customer: 'Unsigned', signedAt: '' }),
    row('SRCBADDATE', { customer: 'Bad date', signedAt: today, inSchedule: true, requestDate: '(fixed in August)' }),
  ] });
  const p = buildBalancedRolling({ ...f.input, quantity: 3, customerPercent: 100 });
  assert.equal(p.customerCount, 3);
  assert.ok(p.schedule.every(a => a.requestDate <= a.auEnd));
  assert.ok(p.customerHolds.some(h => h.chassis === 'SRCUNSIGNED' && h.reason === 'unsigned'));
  assert.ok(p.customerHolds.some(h => h.chassis === 'SRCBADDATE' && h.reason === 'deliveryDate'));
  const same = fixture({ customerCount: 0, stockCount: 0, extraRows: [
    row('SRCNEW', { customer: 'New', signedAt: plus(today, -1) }), row('SRCOLD', { customer: 'Old', signedAt: plus(today, -20) }), row('SRCMID', { customer: 'Middle', signedAt: plus(today, -10) })] });
  const q = buildBalancedRolling({ ...same.input, quantity: 2, customerPercent: 100 });
  assert.deepEqual(q.schedule.map(a => a.chassis).sort(), ['SRCMID', 'SRCOLD']);
});
test('Stock priority serves own first, then JV then independent; lowest stock / ideal within group wins', () => {
  const f = fixture({ customerCount: 0, stockCount: 0, extraRows: [row('SRCOWN', { dealer: 'Geelong' }), row('SRCJV', { dealer: 'Bundaberg' }), row('SRCIND', { dealer: 'ABCO' })] });
  const p = buildBalancedRolling({ ...f.input, quantity: 3, customerPercent: 0 });
  assert.deepEqual(p.stockResult.items.map(a => a.group), ['own', 'jv', 'independent']);
  const even = fixture({ customerCount: 0, stockCount: 0, extraRows: [row('SRCLOW', { dealer: 'Geelong' }), row('SRCHIGH', { dealer: 'Frankston' })] });
  even.dealers.find(d => d.slug === 'geelong').yard.stock = 0;
  even.dealers.find(d => d.slug === 'frankston').yard.stock = 5; refresh(even);
  const q = buildBalancedRolling({ ...even.input, quantity: 1, customerPercent: 0 });
  assert.equal(q.schedule[0].dealer, 'Geelong');
});
test('group coverage is weighted, preserves zero-denominator N/A and separates actual from draft orders', () => {
  const f = fixture({ customerCount: 1, stockCount: 1 }), p = buildBalancedRolling({ ...f.input, quantity: 20 });
  assert.equal(p.scheduled, 2); assert.equal(p.newOrders, 18); assert.equal(p.quantityMet, false); assert.equal(p.actualGap, 18);
  assert.equal(p.report.models.reduce((n, r) => n + r.totalActual, 0), p.scheduled);
  assert.equal(p.report.ranges.reduce((n, r) => n + r.newOrders, 0), p.newOrders);
  assert.ok(p.report.groups.every(g => g.stockMonths === null));
  const own = p.report.groups.find(g => g.group === 'own'), list = p.report.dealers.filter(d => d.group === 'own' && d.actual != null);
  assert.equal(own.actualIdeal, list.reduce((n, d) => n + d.actual, 0) / list.reduce((n, d) => n + d.ideal, 0));
  assert.ok(own.plannedIdeal > own.actualIdeal);
  assert.equal(p.scheduled + p.newOrders + p.inventoryBlocked + p.capacityGap, p.quantity);
  assert.ok(p.stockResult.inventory.every(d => d.peakPlanned == null || d.peakPlanned <= Math.max(d.cap, d.peakActual) + 1e-8));
});
test('physical customers, cancelled orders and duplicate chassis cannot fill quantity', () => {
  const f = fixture({ customerCount: 0, stockCount: 0, extraRows: [row('SRCPHYSICAL', { customer: 'Physical' }), row('SRCGONE', { customer: 'Gone' }), row('SRCDUP', { customer: 'Dup' }), row('SRCDUP', { customer: 'Dup' })],
    orders: { SRCGONE: { chassis: 'SRCGONE', status: 'cancelled' } } });
  f.dealers[0].vehicles.push({ chassis: 'SRCPHYSICAL', where: 'yard', category: 'customer' }); refresh(f);
  const p = buildBalancedRolling({ ...f.input, quantity: 5, customerPercent: 100 });
  assert.equal(p.customerCount, 0); assert.ok(p.customerHolds.some(h => h.chassis === 'SRCPHYSICAL'));
});
test('real orders later than 60 days of CN starts can fill the quantity within the saved forecast horizon', () => {
  const ready = plus(today, 180), f = fixture({ stockCount: 0, customerCount: 0, weeks: 16, extraRows: [row('SRCLATER', { customer: 'Later', inSchedule: true, requestDate: ready })] });
  const p = buildBalancedRolling({ ...f.input, quantity: 1, customerPercent: 100 });
  assert.equal(p.scheduled, 1); assert.equal(p.schedule[0].chassis, 'SRCLATER'); assert.ok(p.schedule[0].auEnd >= ready);
});
