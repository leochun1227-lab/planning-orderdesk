import { capacityKind } from './build-plan.mjs';
import { isStockCustomer } from './dealership.mjs';
const physical = new Set(['au', 'sea', 'cn']);
const flexible = r => r.group === 'locked' && isStockCustomer(r.customer) && capacityKind(r.model) === 'towable';
const sum = values => values.reduce((n, v) => n + v, 0);

/** Source AU quantities include motorhomes. Only remaining Towable slots are
 * available to the Stock simulator; physical supply and named locked customers
 * retain their dates. Editing a month never silently expands that month's plan. */
export function stockProductionPlan({ capacity, rows, today, monthly = {}, shiftDays = 0, finishDates = {}, managedLocked = null }) {
  if (!monthly || typeof monthly !== 'object' || Array.isArray(monthly)) throw new Error('Invalid monthly AU production');
  const mayExchange = r => flexible(r) && (!managedLocked || managedLocked.has(String(r.chassis).toUpperCase().replace(/[-\s]/g, '')));
  const source = [...(capacity || new Map())].sort(([a], [b]) => a.localeCompare(b));
  const keys = [...new Set(source.map(([d]) => d.slice(0, 7)))].filter(m => m >= today.slice(0, 7));
  for (const [m, n] of Object.entries(monthly)) if (!keys.includes(m) || !Number.isInteger(n) || n < 0 || n > 10000) throw new Error(`AU月度产量无效 / Invalid AU monthly production: ${m}`);
  const sourceTotals = new Map(keys.map(m => [m, sum(source.filter(([d]) => d.startsWith(m)).map(([, c]) => c.towable + (c.srm || 0) + (c.srv || 0)))]));
  const overrides = Object.fromEntries(Object.entries(monthly).filter(([m, n]) => n !== sourceTotals.get(m)).sort(([a], [b]) => a.localeCompare(b)));
  if (!source.length) {
    if (Object.keys(overrides).length) throw new Error('AU source capacity is unavailable');
    return null;
  }
  const dayOf = r => physical.has(r.group) && isStockCustomer(r.customer) && capacityKind(r.model) === 'towable'
    ? finishDates[r.chassis] || (r.auEnd && new Date(Date.parse(`${r.auEnd}T00:00:00Z`) + shiftDays * 86400000).toISOString().slice(0, 10)) : r.auEnd;
  const reserved = rows.filter(r => !r.empty && capacityKind(r.model) === 'towable' && (physical.has(r.group) || r.group === 'locked' && !mayExchange(r)) && dayOf(r) >= today);
  const counts = new Map();
  for (const r of reserved) counts.set(dayOf(r), (counts.get(dayOf(r)) || 0) + 1);
  const daily = new Map(source.map(([d, c]) => [d, { ...c }])), months = [];
  for (const month of keys) {
    const all = source.filter(([d]) => d.startsWith(month)), days = all.filter(([d]) => d >= today).map(([d]) => d);
    const sourceTowable = sum(all.map(([, c]) => c.towable)), srm = sum(all.map(([, c]) => c.srm || 0)), srv = sum(all.map(([, c]) => c.srv || 0));
    const sourceTotal = sourceTowable + srm + srv, total = overrides[month] ?? sourceTotal;
    const elapsed = sum(all.filter(([d]) => d < today).map(([, c]) => c.towable));
    const fixed = sum([...counts].filter(([d]) => d.startsWith(month)).map(([, n]) => n));
    const minimum = srm + srv + elapsed + fixed;
    if (total < minimum) throw new Error(`${month} AU产量至少 ${minimum}（SRM/SRV、已过产能及固定订单） / Minimum AU production ${minimum}`);
    const towable = total - srm - srv, remaining = towable - elapsed;
    if (remaining && !days.length) throw new Error(`${month}: no remaining AU working days`);
    if (overrides[month] !== undefined) {
      let made = 0;
      days.forEach((d, i) => { const upto = Math.round((remaining - fixed) * (i + 1) / days.length); daily.get(d).towable = (counts.get(d) || 0) + upto - made; made = upto; });
    }
    // Explicit virtual physical dates must also fit the chosen working calendar.
    const conflicts = [...counts].filter(([d, n]) => d.startsWith(month) && (!daily.has(d) || daily.get(d).towable < n));
    if (conflicts.length) throw new Error(`${month}: 固定订单或虚拟日期超出当日产能 / Fixed orders or virtual dates exceed daily capacity`);
    months.push({ month, sourceTotal, total, srm, srv, towable, elapsedTowable: elapsed, fixedTowable: fixed, minimum, availableStockSlots: remaining - fixed, plannedStock: 0, unfilled: 0 });
  }
  const physicalEnd = reserved.filter(r => physical.has(r.group)).map(dayOf).sort().at(-1) || today;
  const firstLocked = rows.filter(r => mayExchange(r) && r.auEnd).map(r => finishDates[r.chassis] || new Date(Date.parse(`${r.auEnd}T00:00:00Z`) + shiftDays * 86400000).toISOString().slice(0, 10)).sort()[0];
  // A virtual monthly increase can create earlier spare places alongside already
  // reserved physical work. Do not discard those places behind the old boundary.
  const start = Object.keys(overrides).length ? today : [today, physicalEnd, firstLocked || today].sort().at(-1);
  const slots = [...daily].filter(([d]) => d >= start).flatMap(([d, c]) => Array(Math.max(0, c.towable - (counts.get(d) || 0))).fill(d));
  return { months, daily: [...daily], slots, start, overrides };
}

export const effectiveSimulationCapacity = (report, fallback) => report?.auProduction?.daily ? new Map(report.auProduction.daily) : fallback;
