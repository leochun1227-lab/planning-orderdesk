import { capacityKind } from './build-plan.mjs';
import { dealerSlug, leadDays } from './dealership.mjs';
const norm = v => String(v || '').toUpperCase().replace(/[-\s]/g, '');
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const fixed = new Set(['au', 'sea', 'cn', 'locked']);
/** Rebook only confirmed adjustments. Unchanged physical/fixed rows retain dates;
 * cancellations release slots, delays reserve later slots, rolling uses the gaps. */
export function replayInventoryBasis({ line, report, capacity, dealers = [], includeRolling = false }) {
  line = structuredClone(line); report = structuredClone(report);
  const actions = ['own', 'jv', 'independent'].flatMap(g => report[g]?.actions || []);
  const by = new Map(actions.filter(a => a.action === 'cancel' || a.delayed || a.reallocated).map(a => [norm(a.chassis), a]));
  const used = new Map(), take = (day, kind) => { const k = `${day}:${kind}`, n = used.get(k) || 0; if (n >= (capacity.get(day)?.[kind] || 0)) return false; used.set(k, n + 1); return true; };
  const dates = [...capacity.keys()].filter(d => d >= line.today).sort();
  const affected = [], cancelled = [];
  for (const r of line.rows.filter(r => fixed.has(r.group) && !r.empty)) {
    const a = by.get(norm(r.chassis));
    if (a?.action === 'cancel' && r.group === 'locked') {
      r.planningExcluded = true; r.auEnd = ''; r.auForecast = undefined; cancelled.push(r.chassis); continue;
    }
    if (a && ['cn', 'locked'].includes(r.group) && (a.delayed || a.reallocated)) { affected.push({ r, a }); continue; }
    if (r.auEnd && !take(r.auEnd, capacityKind(r.model))) throw new Error(`前序产能冲突 / Fixed capacity conflict: ${r.auEnd}`);
  }
  for (const { r, a } of affected.sort((x, y) => (x.a.plannedAu || x.r.auEnd || '').localeCompare(y.a.plannedAu || y.r.auEnd || ''))) {
    const earliest = a.plannedAu || r.auEnd || line.today, kind = capacityKind(r.model);
    const day = dates.find(d => d >= earliest && take(d, kind));
    if (!day) throw new Error('已确认调整超出有效AU产能，请补齐产能 / Confirmed adjustments exceed available AU capacity');
    r.originalDealer = r.originalDealer || r.dealer;
    if (a.reallocated && a.proposedDealer) r.dealer = a.proposedDealer;
    r.auEnd = day; r.auForecast = { ...r.auForecast, kind }; delete r.auForecast.note; r.inventoryAdjustment = a.action;
    a.plannedAu = day; a.delayDays = a.originalAu ? Math.round((Date.parse(day) - Date.parse(a.originalAu)) / 86400000) : null;
    const dealer = dealers.find(d => d.slug === (a.to || dealerSlug(dealers, r.dealer))), lead = dealer && leadDays(dealer);
    if (a.receive && lead != null) { a.plannedArrival = plus(day, lead); a.arrivalDelayDays = a.originalArrival ? Math.round((Date.parse(a.plannedArrival) - Date.parse(a.originalArrival)) / 86400000) : null; }
  }
  if (includeRolling) for (const r of line.rows.filter(r => r.group === 'rolling' && !r.empty)) {
    const day = r.rollingNotBefore || r.auEnd;
    if (!day || !take(day, capacityKind(r.model))) throw new Error('滚动排产与调整后的产能冲突，请重新生成 / Rolling capacity conflict after adjustments');
    r.auEnd = day; r.auForecast = { ...r.auForecast, kind: capacityKind(r.model) }; delete r.auForecast.note;
  }
  const replay = { cancelled: cancelled.length, shifted: affected.filter(x => x.a.delayed).length, reallocated: affected.filter(x => x.a.reallocated).length,
    cancelledChassis: cancelled, lastFixed: line.rows.filter(r => fixed.has(r.group) && !r.planningExcluded).reduce((s, r) => r.auEnd > s ? r.auEnd : s, '') };
  line.basisReplay = replay;
  return { line, report, used, replay };
}
export function availableRollingSlots(line, capacity, earliest, latest) {
  const occupied = new Map();
  for (const r of line.rows) if (fixed.has(r.group) && !r.planningExcluded && r.auEnd && capacityKind(r.model) === 'towable') occupied.set(r.auEnd, (occupied.get(r.auEnd) || 0) + 1);
  return [...capacity].sort(([a],[b]) => a.localeCompare(b)).flatMap(([day,c]) => day >= earliest && day <= latest ? Array(Math.max(0,c.towable-(occupied.get(day)||0))).fill(day) : []);
}
