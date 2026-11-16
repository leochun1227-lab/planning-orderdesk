import test from 'node:test';
import assert from 'node:assert/strict';
import { towableQuantities, buildPlanSlots, loadWorkCalendar } from '../lib/build-plan.mjs';
test('Towable = Portal total − SRV − SRM, spread over calendar working days', () => {
  const months = Array.from({ length: 12 }, () => ({ models: [0], workingDays: 20 }));
  const q = towableQuantities({ dispatchPlan: { 2026: { totalProduction: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 324, 272] }, 2027: { totalProduction: { 0: 165, 1: 230, 2: 226 } } },
    motorhomePlans: { 2026: [...months.slice(0, 10), { models: [10, 8], workingDays: 18 }, { models: [10, 7], workingDays: 17 }], 2027: [{ models: [28] }, { models: [36] }, { models: [37] }] } });
  assert.equal(q.get('2026-11').towable, 306); assert.equal(q.get('2026-12').towable, 255); assert.equal(q.get('2027-03').towable, 189); assert.equal(q.get('2027-04').towable, 0);
  const cal = { days: new Set(['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04']) };
  const { rows, months: m } = buildPlanSlots(new Map([['2027-03', { towable: 42 }]]), cal);
  assert.equal(rows.length, 42); assert.equal(m[0].perDay, 10.5);
  assert.equal(rows.filter(r => r.date <= '2027-03-02').length, 21, '10.5 a day = 21 slots over two days');
  assert.deepEqual([...new Set(rows.map(r => r.date))], ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04']);
});
test('the VIC calendar matches the Portal working days for Nov / Dec 2026', () => {
  const cal = loadWorkCalendar();
  assert.equal([...cal.days].filter(d => d.startsWith('2026-11')).length, 18);
  assert.equal([...cal.days].filter(d => d.startsWith('2026-12')).length, 17);
  assert.ok(!cal.days.has('2026-11-03'), 'Melbourne Cup');
});

test('AU finish forecast: SRM / SRV use their own capacity, queue by line progress from today', async () => {
  const { planQuantities, dailyCapacity } = await import('../lib/build-plan.mjs');
  const { forecastAuFinish } = await import('../lib/production-line.mjs');
  const q = planQuantities({ dispatchPlan: { 2026: { totalProduction: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0] } }, motorhomePlans: { 2026: Object.assign(Array.from({ length: 12 }, () => ({ models: [] })), { 10: { models: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }) }, modelNames: ['SRM 22.1', 'SRM 22.2', 'SRM 24.1', 'SRM 25.1', 'SRM 26.1', 'SRM 29.1', 'SRV19.1', 'SRV22.1', 'SRV22.2', 'SRV22.3'] });
  assert.deepEqual({ ...q.get('2026-11'), portalWorkingDays: 0 }, { total: 6, srm: 2, srv: 0, srvSrm: 2, towable: 4, portalWorkingDays: 0 });
  const cap = dailyCapacity(new Map([['2026-11', q.get('2026-11')]]), { days: new Set(['2026-11-12', '2026-11-13']) });
  assert.deepEqual(cap.get('2026-11-13'), { towable: 2, srm: 1, srv: 0 });
  const row = (chassis, model, location, since, regent = 'Van Arrived') => ({ chassis, model, group: 'au', regent, live: { location, stationSince: since, grAt: '2026-10-01' }, auEnd: '' });
  const rows = [row('A', 'SRC', 'received', '2026-11-01'), row('B', 'SRH', 'qc', '2026-11-10'), row('C', 'SRT', 'production', '2026-11-05'), row('D', 'SRM 22', 'received', '2026-11-01'), row('E', 'SRV', 'qc', '')];
  const s = forecastAuFinish(rows, cap, '2026-11-13');
  const by = Object.fromEntries(rows.map(r => [r.chassis, r]));
  assert.equal(by.B.auEnd, '2026-11-13'); assert.equal(by.C.auEnd, '2026-11-13'); assert.equal(by.A.auEnd, '');
  assert.equal(by.A.auForecast.note, 'overflow'); assert.equal(by.D.auEnd, '2026-11-13'); assert.equal(by.E.auForecast.note, 'overflow');
  assert.equal(s.towable, 2); assert.equal(s.overflow, 2);
});

test('AU finish forecast queue: AU production → shipping → China production → rolling 60 days', async () => {
  const { forecastAuFinish } = await import('../lib/production-line.mjs');
  const cap = new Map([['2026-11-17', { towable: 2, srm: 0, srv: 0 }], ['2026-11-18', { towable: 2, srm: 0, srv: 0 }], ['2027-03-01', { towable: 2, srm: 0, srv: 0 }]]);
  const rows = [{ chassis: 'R', group: 'rolling', planOrder: 1, model: 'SRC', cnPlanEnd: '2026-12-01' }, { chassis: 'C', group: 'cn', model: 'SRH', ltRank: 3, cnPlanEnd: '2026-11-30' }, { chassis: 'S', group: 'sea', model: 'SRT', live: { eta: '2026-11-01', ship: { eta: '2026-12-01', arrived: false } } }, { chassis: 'A', group: 'au', model: 'SRP', live: { location: 'qc' } }, { chassis: 'T', group: 'transport', model: 'SRC' }];
  forecastAuFinish(rows, cap, '2026-11-16');
  const by = Object.fromEntries(rows.map(r => [r.chassis, r]));
  assert.deepEqual(['A', 'S', 'C', 'R', 'T'].map(c => by[c].auEnd || ''), ['2026-11-17', '2026-11-17', '2026-11-18', '2026-11-18', '']);
  assert.equal(by.S.auForecast.beforeArrival, '2026-12-01', 'slot before the Shipment page ETA');
  assert.equal(by.C.auForecast.beforeArrival, undefined, 'no Shipment ETA = nothing estimated');
});
