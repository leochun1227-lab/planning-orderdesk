import { capacityKind } from './build-plan.mjs';
import { dealerSlug, leadDays } from './dealership.mjs';
const norm = v => String(v || '').toUpperCase().replace(/[-\s]/g, '');
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const fixed = new Set(['au', 'sea', 'cn', 'locked']);
/** Apply the confirmed basis before booking rolling capacity. Physical rows retain
 * their dates unless explicitly postponed. Repack surviving locked orders after
 * physical production, reserving confirmed delays and updating arrival curves. */
export function replayInventoryBasis({ line, report, capacity, dealers = [], includeRolling = false }) {
  line = structuredClone(line); report = structuredClone(report);
  const actions = ['own', 'jv', 'independent'].flatMap(g => report[g]?.actions || []);
  const by = new Map(actions.map(a => [norm(a.chassis), a]));
  const used = new Map(), take = (day, kind) => {
    const k = `${day}:${kind}`, n = used.get(k) || 0;
    if (n >= (capacity.get(day)?.[kind] || 0)) return false;
    used.set(k, n + 1); return true;
  };
  const dates = [...capacity.keys()].filter(d => d >= line.today).sort();
  const offsets = new Map(), totals = { towable: 0, srm: 0, srv: 0 };
  for (const day of dates) for (const kind of Object.keys(totals)) {
    offsets.set(`${day}:${kind}`, totals[kind]); totals[kind] += capacity.get(day)?.[kind] || 0;
  }
  const changed = [], cancelled = [], physical = [], locked = [];
  function assign(r, day, a) {
    const kind = capacityKind(r.model), original = r.auEnd;
    r.auEnd = day; r.auForecast = { ...r.auForecast, kind, seq: offsets.get(`${day}:${kind}`) + used.get(`${day}:${kind}`), perDay: capacity.get(day)[kind] };
    delete r.auForecast.note;
    if (a?.reallocated) {
      r.originalDealer ||= r.dealer; r.plannedReallocation = true;
      const target = dealers.find(d => d.slug === a.to);
      r.dealer = a.proposedDealer || target?.name || r.dealer;
    }
    if (a && (a.delayed || a.reallocated)) { r.inventoryAdjustment = a.action; changed.push({ r, a }); }
    if (original !== day) r.inventoryDateChanged = true;
    if (!a) return;
    a.plannedAu = day;
    a.delayDays = a.originalAu ? Math.round((Date.parse(day) - Date.parse(a.originalAu)) / 86400000) : null;
    const dealer = dealers.find(d => d.slug === (a.to || dealerSlug(dealers, r.dealer))), lead = dealer && leadDays(dealer);
    if ((a.receive || ['pending', 'blocked'].includes(a.action)) && lead != null) {
      a.plannedArrival = plus(day, lead);
      a.arrivalDelayDays = a.originalArrival ? Math.round((Date.parse(a.plannedArrival) - Date.parse(a.originalArrival)) / 86400000) : null;
    }
  }
  function book(r, earliest, a) {
    const day = dates.find(d => d >= earliest && take(d, capacityKind(r.model)));
    if (!day) throw new Error('已确认调整超出有效AU产能，请补齐产能 / Confirmed adjustments exceed available AU capacity');
    assign(r, day, a);
  }
  const pendingCn = [];
  for (const r of line.rows.filter(r => fixed.has(r.group) && !r.empty)) {
    const a = by.get(norm(r.chassis));
    if (r.group === 'locked') {
      if (a?.action === 'cancel') {
        r.group = 'customers'; r.returnedToPool = true; r.locked = false; r.inventoryAdjustment = 'returnToPool';
        for (const key of ['auEnd', 'auStart', 'auPlanStart', 'auPlanEnd', 'cnStart', 'cnPlanStart', 'cnPlanEnd', 'cnPlanMonth', 'planStart', 'planEnd', 'expectedEnd', 'planRef', 'planWeld', 'planAssembly', 'rollingNotBefore']) r[key] = '';
        r.planOrder = null; r.auForecast = undefined; cancelled.push(r.chassis);
      }
      else locked.push({ r, a });
      continue;
    }
    physical.push(r);
    if (r.group === 'cn' && a?.delayed) { pendingCn.push({ r, a }); continue; }
    if (r.auEnd && !take(r.auEnd, capacityKind(r.model))) throw new Error(`前序产能冲突 / Fixed capacity conflict: ${r.auEnd}`);
    if (r.group === 'cn' && a?.reallocated && r.auEnd) assign(r, r.auEnd, a);
  }
  for (const { r, a } of pendingCn.sort((x,y) => (x.a.plannedAu || '').localeCompare(y.a.plannedAu || ''))) book(r, a.plannedAu || r.auEnd || line.today, a);
  const physicalEnd = kind => physical.filter(r => capacityKind(r.model) === kind).reduce((last,r) => r.auEnd > last ? r.auEnd : last, line.today);
  const order = (x,y) => (x.r.auForecast?.seq ?? Infinity) - (y.r.auForecast?.seq ?? Infinity);
  // Reserve explicit delays first. Other locked orders close cancelled gaps in
  // their original sequence; reallocations alone never create a time delay.
  for (const { r, a } of locked.filter(x => x.a?.delayed).sort((x,y) => (x.a.plannedAu || '').localeCompare(y.a.plannedAu || '') || order(x,y)))
    book(r, [physicalEnd(capacityKind(r.model)), a.plannedAu || r.auEnd || line.today].sort().at(-1), a);
  for (const { r, a } of locked.filter(x => !x.a?.delayed).sort(order)) book(r, physicalEnd(capacityKind(r.model)), a);
  const lastOf = predicate => line.rows.filter(r => !r.planningExcluded && !r.empty && predicate(r)).reduce((last,r) => r.auEnd > last ? r.auEnd : last, '');
  const lastLocked = lastOf(r => r.group === 'locked' && capacityKind(r.model) === 'towable');
  const boundary = lastLocked || lastOf(r => fixed.has(r.group) && capacityKind(r.model) === 'towable') || line.today;
  if (includeRolling) for (const r of line.rows.filter(r => r.group === 'rolling' && !r.empty)) {
    const day = r.rollingNotBefore || r.auEnd;
    if (!day || day < boundary || !take(day, capacityKind(r.model))) throw new Error('滚动排产与调整后的产能冲突，请重新生成 / Rolling capacity conflict after adjustments');
    assign(r, day);
  }
  const replay = { cancelled: cancelled.length, shifted: changed.filter(x => x.a.delayed).length, reallocated: changed.filter(x => x.a.reallocated).length,
    rescheduledLocked: locked.filter(x => x.r.inventoryDateChanged).length, cancelledChassis: cancelled, lastLocked, rollingBoundary: boundary,
    lastFixed: lastOf(r => fixed.has(r.group)) };
  line.basisReplay = replay;
  return { line, report, used, replay };
}
export function availableRollingSlots(line, capacity, earliest, latest) {
  const occupied = new Map();
  for (const r of line.rows) if (fixed.has(r.group) && !r.planningExcluded && r.auEnd && capacityKind(r.model) === 'towable') occupied.set(r.auEnd, (occupied.get(r.auEnd) || 0) + 1);
  return [...capacity].sort(([a],[b]) => a.localeCompare(b)).flatMap(([day,c]) => day >= earliest && day <= latest ? Array(Math.max(0,c.towable-(occupied.get(day)||0))).fill(day) : []);
}

/** Add the saved rolling dates to a basis that was already applied before pool selection. */
export function appendRollingToBasis({ rows, capacity, today, basis }) {
  const used = new Map(), offsets = new Map(), totals = { towable: 0, srm: 0, srv: 0 };
  for (const day of [...capacity.keys()].filter(d => d >= today).sort()) for (const kind of Object.keys(totals)) {
    offsets.set(`${day}:${kind}`, totals[kind]); totals[kind] += capacity.get(day)?.[kind] || 0;
  }
  for (const r of rows.filter(r => fixed.has(r.group) && !r.empty && r.auEnd)) {
    const key = `${r.auEnd}:${capacityKind(r.model)}`; used.set(key, (used.get(key) || 0) + 1);
  }
  for (const r of rows.filter(r => r.group === 'rolling' && !r.empty)) {
    const day = r.rollingNotBefore, kind = capacityKind(r.model), key = `${day}:${kind}`, occupied = used.get(key) || 0;
    if (!day || day < basis.rollingBoundary || occupied >= (capacity.get(day)?.[kind] || 0)) throw new Error('滚动排产与已应用调整后的产能冲突，请重新生成 / Rolling capacity conflict with applied inventory basis');
    used.set(key, occupied + 1); r.auEnd = day;
    r.auForecast = { ...r.auForecast, kind, seq: offsets.get(key) + occupied + 1, perDay: capacity.get(day)[kind] };
    delete r.auForecast.note;
  }
}
