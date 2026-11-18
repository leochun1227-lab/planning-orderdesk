import { dealerGroup, dealerSlug, HANDOVER_MONTHS } from './dealership.mjs';
const divide = (a, b) => a != null && Number.isFinite(b) && b > 0 ? a / b : null;
const sum = (rows, field) => rows.reduce((n, r) => n + (r[field] || 0), 0);
const rangeOf = a => (String(a.model || '').match(/^[A-Za-z]+/) || ['Unknown'])[0].toUpperCase();
function breakdown(items, field) {
  const rows = new Map();
  for (const a of items) {
    const key = field === 'range' ? rangeOf(a) : a.model || 'Unknown';
    const r = rows.get(key) || { name: key, customer: 0, stock: 0, newOrders: 0, totalActual: 0 };
    if (a.status === 'newOrder') r.newOrders += a.quantity || 1;
    else { r[a.kind === 'customer' ? 'customer' : 'stock']++; r.totalActual++; }
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function buildRollingReport(proposal, dealers, plan) {
  const schedule = proposal.schedule, requests = proposal.requests.filter(a => a.status === 'newOrder');
  const rows = (proposal.stockResult.inventory || []).map(d => {
    const actual = schedule.filter(a => dealerSlug(dealers, a.dealer) === d.slug);
    return { ...d, customer: actual.filter(a => a.kind === 'customer').length, stock: actual.filter(a => a.kind === 'stock').length,
      newOrders: requests.filter(a => a.slug === d.slug).length,
      actualIdeal: divide(d.actual, d.ideal), plannedIdeal: divide(d.planned, d.ideal),
      peakIdeal: divide(d.peakActual, d.ideal), referenceExcess: d.actual != null && d.cap != null ? Math.max(0, d.actual - d.cap) : null,
      stockMonths: divide(d.actual, d.avgStock), plannedStockMonths: divide(d.planned, d.avgStock),
      allNewMonths: divide(d.actual, d.avgStock == null || d.avgCustomer == null ? null : d.avgStock + d.avgCustomer) };
  });
  const groups = ['own', 'jv', 'independent'].map(group => {
    const list = rows.filter(d => d.group === group), covered = list.filter(d => d.actual != null && d.planned != null && d.ideal > 0);
    const matching = a => { const d = dealers.find(d => d.slug === dealerSlug(dealers, a.dealer)); return d && dealerGroup(d) === group; };
    const avgNew = covered.every(d => d.avgStock != null && d.avgCustomer != null) ? sum(covered, 'avgStock') + sum(covered, 'avgCustomer') : null;
    const actual = sum(covered, 'actual'), planned = sum(covered, 'planned'), ideal = sum(covered, 'ideal'), avgStock = covered.every(d => d.avgStock != null) ? sum(covered, 'avgStock') : null;
    return { group, dealers: list.length, missing: list.length - covered.length, actual: covered.length ? actual : null, planned: covered.length ? planned : null, ideal,
      customer: schedule.filter(a => a.kind === 'customer' && matching(a)).length, stock: schedule.filter(a => a.kind === 'stock' && matching(a)).length,
      newOrders: requests.filter(matching).length, avgStock, avgNew, allNewMonths: covered.length ? divide(actual, avgNew) : null,
      uncertainIncoming: sum(list, 'uncertainIncoming'), referenceExcess: sum(covered, 'referenceExcess'), actualIdeal: covered.length ? divide(actual, ideal) : null, plannedIdeal: covered.length ? divide(planned, ideal) : null,
      stockMonths: covered.length ? divide(actual, avgStock) : null, plannedStockMonths: covered.length ? divide(planned, avgStock) : null };
  });
  return { version: 2, fullTarget: true, nonRecommendedCount: schedule.filter(a => a.kind === 'stock' && a.modelPolicy && a.modelPolicy !== 'display').length, reallocationCount: schedule.filter(a => a.reallocated).length, uncertainIncoming: sum(rows, 'uncertainIncoming'), asOf: proposal.stockResult.inventoryDate, handoverMonths: HANDOVER_MONTHS, stockCeilingMultiplier: plan.multiplier,
    inventoryBasis: 'Towable Stock; saved adjustments and fixed inbound supply replayed, daily Stock handovers deducted. Pending existing arrivals are reserved at their known original date or conservatively from today when undated.',
    ratioBasis: 'New rolling orders per AU-finish week, with floor/ceiling rounding; fixed production shown separately.',
    optimisation: 'Fill the exact real-order quantity. Meet Ideal deficits for own, then JV, then independent; distribute remaining units to the lowest projected peak Stock / Ideal. Reference ceilings and model buffers are soft costs, not reasons to leave capacity empty. Own pool Stock may have a planned receiving-dealer reallocation.',
    groups, dealers: rows, models: breakdown([...schedule, ...requests], 'model'), ranges: breakdown([...schedule, ...requests], 'range'),
    unclassified: schedule.filter(a => !dealers.some(d => d.slug === dealerSlug(dealers, a.dealer))).length };
}
