import test from 'node:test';
import assert from 'node:assert/strict';
import { stockAdjustmentActions, stockAdjustmentSummary, stockAdjustmentToken, stockPlanConfirmation, confirmStockAdjustments, confirmedStockPlan } from '../lib/stock-plan-confirmation.mjs';
import { buildBalancedRolling } from '../lib/balanced-rolling.mjs';
import { fixture } from './helpers/rolling-fixture.mjs';

const report = () => ({ today: '2026-11-18', totals: { poolNotBuilt: 1 }, own: { summary: { poolNotBuilt: 1 }, dealers: [{ stats: { poolNotBuilt: 1 } }], actions: [
  { chassis: 'C1', group: 'locked', action: 'cancel' },
  { chassis: 'B1', group: 'cn', action: 'reallocate', delayed: true, reallocated: true, originalAu: '2027-01-02', plannedAu: '2027-02-02', to: 'geelong' },
  { chassis: 'P1', group: 'customers', action: 'pool', delayed: true },
]}, jv: { actions: [{ chassis: 'J1', group: 'locked', action: 'delay', delayed: true }] }, independent: { actions: [{ chassis: 'I1', group: 'locked', action: 'cancel' }] } });
const plan = () => ({ id: 'plan-1', fingerprint: 'inputs-1', report: report(), events: [] });

test('confirmation covers cancellation, delay and reallocation across all groups, excluding pool do-not-build', () => {
  const p = plan();
  assert.deepEqual(stockAdjustmentSummary(p.report), { total: 4, cancellations: 2, delays: 2, reallocations: 1, poolExcluded: 1 });
  assert.equal(stockAdjustmentActions(p.report).length, 4);
  const original = structuredClone(p);
  p.confirmation = confirmStockAdjustments({ plan: p, fingerprint: p.fingerprint, actor: 'Planner', now: '2026-11-18T03:00:00Z' });
  assert.equal(p.confirmation.confirmedBy, 'Planner'); assert.equal(p.confirmation.confirmedAt, '2026-11-18T03:00:00Z');
  assert.ok(!p.confirmation.actions.some(a => a.chassis === 'P1'));
  assert.ok(!p.confirmation.report.own.actions.some(a => a.chassis === 'P1'));
  assert.equal(p.confirmation.report.totals.poolNotBuilt, 0);
  assert.deepEqual(p.report, original.report, 'saving a confirmation cannot edit the original report');
  assert.equal(stockPlanConfirmation(p, p.fingerprint).status, 'confirmed');
  const forRolling = confirmedStockPlan(p, p.fingerprint); forRolling.report.own.actions[0].action = 'keep';
  assert.equal(p.confirmation.report.own.actions[0].action, 'cancel', 'the frozen snapshot must not be mutated by consumers');
});

test('source changes, a replacement plan, edited actions or a damaged snapshot invalidate the confirmation', () => {
  const p = plan(); p.confirmation = confirmStockAdjustments({ plan: p, fingerprint: p.fingerprint });
  assert.equal(stockPlanConfirmation(p, 'new-inputs').status, 'stale');
  assert.throws(() => confirmedStockPlan(p, 'new-inputs'), /确认/);
  for (const edit of [x => x.id = 'new-plan', x => x.report.own.actions[1].plannedAu = '2027-02-03', x => x.confirmation.report.own.actions[0].action = 'keep', x => x.confirmation.actions[0].action = 'keep']) {
    const next = structuredClone(p); edit(next); assert.equal(stockPlanConfirmation(next, p.fingerprint).status, 'stale');
  }
});

test('pool-only changes and object key order do not change the confirmed adjustment token', () => {
  const p = plan(); p.confirmation = confirmStockAdjustments({ plan: p, fingerprint: p.fingerprint });
  const token = stockAdjustmentToken(p);
  p.report.own.actions.push({ chassis: 'P2', group: 'customers', action: 'pool' }); p.report.totals.poolNotBuilt = 2;
  assert.equal(stockAdjustmentToken(p), token); assert.equal(stockPlanConfirmation(p, p.fingerprint).status, 'confirmed');
  const q = plan(); q.report.own.actions[0] = { action: 'cancel', group: 'locked', chassis: 'C1' };
  assert.equal(stockAdjustmentToken(q), stockAdjustmentToken(plan()));
});

test('zero adjustments still require explicit confirmation, and confirmed pool Stock remains eligible', () => {
  const f = fixture(); delete f.input.plan.confirmation;
  assert.equal(stockPlanConfirmation(f.input.plan, f.input.fingerprint).status, 'unconfirmed');
  assert.throws(() => buildBalancedRolling(f.input), /确认/);
  f.input.plan.confirmation = confirmStockAdjustments({ plan: f.input.plan, fingerprint: f.input.fingerprint, actor: 'Planner' });
  const p = buildBalancedRolling({ ...f.input, quantity: 20 });
  assert.equal(p.scheduled, 20); assert.ok(p.stockCount > 0);
  assert.equal(p.confirmationId, f.input.plan.confirmation.id);
  assert.equal(p.adjustmentBasis.confirmedBy, 'Planner'); assert.equal(p.adjustmentBasis.summary.total, 0);
  assert.ok(p.adjustmentBasis.summary.poolExcluded > 0);
});

test('quantity scheduling replays the confirmed cancellation, deferred arrival and receiving dealer', () => {
  const f = fixture({ customerCount: 20, stockCount: 20 });
  const plus = n => new Date(Date.parse(`${f.line.today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  f.plan.report.own.actions.push(
    { chassis: 'KEEP', group: 'locked', action: 'keep', from: 'frankston', to: 'frankston', model: 'SRC21', receive: true, plannedArrival: plus(120) },
    { chassis: 'CANCEL', group: 'locked', action: 'cancel', from: 'frankston', model: 'SRC21', originalArrival: plus(120), receive: false },
    { chassis: 'DELAY', group: 'locked', action: 'delay', delayed: true, from: 'frankston', to: 'frankston', model: 'SRC21', receive: true, originalArrival: plus(125), plannedArrival: plus(150) },
    { chassis: 'MOVE', group: 'locked', action: 'reallocate', reallocated: true, from: 'frankston', to: 'geelong', model: 'SRC21', receive: true, plannedArrival: plus(120) },
  );
  f.plan.confirmation = confirmStockAdjustments({ plan: f.plan, fingerprint: f.fingerprint, actor: 'Planner' });
  const p = buildBalancedRolling({ ...f.input, quantity: 20 });
  assert.equal(p.confirmedAdjustments.length, 3); assert.equal(p.adjustmentBasis.summary.cancellations, 1);
  assert.equal(p.adjustmentBasis.summary.delays, 1); assert.equal(p.adjustmentBasis.summary.reallocations, 1);
  assert.ok(p.stockResult.inventoryDate < plus(150));
  assert.equal(p.stockResult.inventory.find(d => d.slug === 'frankston').before, 1, 'cancelled supply is absent and deferred supply is not yet received');
  assert.equal(p.stockResult.inventory.find(d => d.slug === 'geelong').before, 1, 'the saved receiving dealer receives the reallocated van');
});
