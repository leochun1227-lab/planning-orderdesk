import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionLine } from '../lib/production-line.mjs';

const today = '2026-11-18';
const row = (chassis, extra = {}) => ({ id: chassis, chassis, group: 'au', customer: 'Jane', dealer: 'Frankston', model: 'SRC21', signedAt: '2026-10-01',
  cnPlanStart: '', cnPlanEnd: '', auPlanStart: '', auPlanEnd: '', warnings: [], ...extra });

test('Request Delivery Date: as the Orderlist (Portal schedule) has it, blank and text included; else the Orderdesk date', () => {
  const orders = { SRC1: { chassis: 'SRC-1', customer: 'Jane', status: 'active', requestDate: '2027-02-01' }, SRC2: { chassis: 'SRC-2', customer: 'Jane', status: 'active', requestDate: '2027-01-01' },
    SRM3: { chassis: 'SRM-3', customer: 'Jane', status: 'active', requestDate: '2027-03-01' }, SRM5: { chassis: 'SRM-5', customer: 'Jane', status: 'active', requestDate: 'ASAP' } };
  const rows = [row('SRC1', { inSchedule: true, requestDate: '2026-12-01' }), row('SRC2', { inSchedule: true, requestDate: '' }), row('SRM3'), row('SRC4', { inSchedule: true, requestDate: '(fixed in August)' }), row('SRM5')];
  const line = buildProductionLine({ board: { rows, completed: 0, averages: {} }, orders, longtree: new Map(), prod: new Map(), portal: new Map(), today, settings: {} });
  const by = Object.fromEntries(line.rows.map(r => [r.chassis, r.requestDate]));
  assert.deepEqual(by, { SRC1: '2026-12-01', SRC2: '', SRM3: '2027-03-01', SRC4: '(fixed in August)', SRM5: '' });
});
