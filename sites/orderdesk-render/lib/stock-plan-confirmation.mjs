// A saved inventory opinion becomes a rolling prerequisite only after explicit
// confirmation. Pool "do not build" rows are neither cancellations nor exclusions.
import { createHash, randomUUID } from 'node:crypto';
const groups = ['own', 'jv', 'independent'];
const pool = a => !a.slotScheduled && !a.slotReleased && (a.action === 'pool' || ['customers', 'processing', 'later'].includes(a.group));
const chassis = a => String(a.chassis || '').toUpperCase().replace(/[-\s]/g, '');
const allActions = report => groups.flatMap(g => report?.[g]?.actions || []);
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

export function stockAdjustmentActions(report) {
  return allActions(report).filter(a => !pool(a) && (a.action === 'cancel' || a.delayed || a.reallocated || a.scheduleChanged || a.slotReleased));
}
export function stockAdjustmentSummary(report) {
  const actions = stockAdjustmentActions(report), count = test => new Set(actions.filter(test).map(chassis)).size;
  return { total: count(() => true), cancellations: count(a => a.action === 'cancel'),
    delays: count(a => a.action !== 'cancel' && a.delayed), reallocations: count(a => a.action !== 'cancel' && a.reallocated),
    ...(report?.auProduction ? { slotChanges: count(a => a.scheduleChanged || a.slotReleased) } : {}),
    poolExcluded: new Set(allActions(report).filter(pool).map(chassis)).size };
}
export function stockAdjustmentReport(report) {
  const copy = structuredClone(report);
  for (const g of groups) if (copy[g]) {
    copy[g].actions = (copy[g].actions || []).filter(a => !pool(a));
    if (copy[g].summary) copy[g].summary.poolNotBuilt = 0;
    for (const d of copy[g].dealers || []) if (d.stats) d.stats.poolNotBuilt = 0;
  }
  if (copy.totals) copy.totals.poolNotBuilt = 0;
  return copy;
}
export const stockAdjustmentToken = plan => plan ? hash([plan.id, plan.fingerprint, stockAdjustmentReport(plan.report)]) : '';
export function stockPlanConfirmation(plan, fingerprint) {
  const saved = plan?.confirmation, reportToken = stockAdjustmentToken(plan);
  const valid = typeof saved?.id === 'string' && Boolean(saved.id) && saved.planId === plan.id && saved.fingerprint === fingerprint && plan.fingerprint === fingerprint
    && saved.reportToken === reportToken && hash(saved.actions) === hash(stockAdjustmentActions(plan.report)) && hash(saved.report) === hash(stockAdjustmentReport(plan.report));
  return { status: !plan ? 'unsaved' : plan.fingerprint !== fingerprint ? 'stale' : valid ? 'confirmed' : saved ? 'stale' : 'unconfirmed',
    inputToken: fingerprint, planId: plan?.id || null, id: saved?.id || null, reportToken,
    confirmedAt: saved?.confirmedAt || '', confirmedBy: saved?.confirmedBy || '', summary: plan ? stockAdjustmentSummary(plan.report) : null };
}
export function confirmStockAdjustments({ plan, fingerprint, actor = 'Planning', now = new Date().toISOString() }) {
  if (!plan || plan.fingerprint !== fingerprint) throw new Error('库存调整计划已变化，请重新保存后确认 / Save the current inventory plan before confirming');
  if (stockPlanConfirmation(plan, fingerprint).status === 'confirmed') return plan.confirmation;
  return { id: randomUUID(), planId: plan.id, fingerprint, reportToken: stockAdjustmentToken(plan), confirmedAt: now,
    confirmedBy: String(actor).slice(0, 60), summary: stockAdjustmentSummary(plan.report),
    actions: structuredClone(stockAdjustmentActions(plan.report)), report: stockAdjustmentReport(plan.report) };
}
export function confirmedStockPlan(plan, fingerprint) {
  if (stockPlanConfirmation(plan, fingerprint).status !== 'confirmed') throw new Error('请先确认已保存的库存调整计划作为排产前提 / Confirm the saved stock adjustments before scheduling');
  return { ...plan, report: structuredClone(plan.confirmation.report) };
}
