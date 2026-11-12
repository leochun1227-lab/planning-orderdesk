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
