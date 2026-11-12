// Towable build plan (pre-schedule): empty AU production slots with dates, no vehicles yet.
// Monthly quantity = Dealer Portal "Production & dispatch" Towable = total AU production − SRV − SRM
// (productionDispatchPlanning/<year>.totalProduction minus the SRV/SRM slot quantities in
// motorhomeSchedule/plans/<year>[month].models). Each month is spread over the working days of the
// VIC work calendar (data/work-calendar.json) with cumulative rounding, so 10.5 a day gives 21 slots
// over two days and the month adds up exactly.
import { readFileSync } from 'node:fs';

export const BUILD_PLAN_MONTHS = ['2026-11', '2026-12', ...Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`)];

export function loadWorkCalendar(url = new URL('../data/work-calendar.json', import.meta.url)) {
  try { const doc = JSON.parse(readFileSync(url, 'utf8')); return { ...doc, days: new Set(doc.workdays) }; } catch { return null; }
}

const int = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const listOf = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]) : []);

/** Towable quantity per month (yyyy-mm) from the Portal nodes. */
export function towableQuantities({ dispatchPlan, motorhomePlans }) {
  const out = new Map();
  for (const key of BUILD_PLAN_MONTHS) {
    const [y, m] = key.split('-'), i = Number(m) - 1;
    const totals = listOf(dispatchPlan?.[y]?.totalProduction);
    const month = listOf(motorhomePlans?.[y])[i] || {};
    const motorhome = listOf(month.models).reduce((s, q) => s + int(q), 0);
    const total = int(totals[i]);
    out.set(key, { total, srvSrm: motorhome, towable: Math.max(0, total - motorhome), portalWorkingDays: int(month.workingDays) });
  }
  return out;
}

export function buildPlanSlots(quantities, calendar) {
  const rows = [], months = [];
  for (const [key, q] of quantities) {
    const days = calendar ? [...calendar.days].filter(d => d.startsWith(key)).sort() : [];
    months.push({ month: key, ...q, workingDays: days.length, perDay: days.length ? q.towable / days.length : null });
    if (!days.length || !q.towable) continue;
    let made = 0;
    days.forEach((date, i) => {
      const upto = Math.round((q.towable * (i + 1)) / days.length), n = upto - made;
      for (let k = 0; k < n; k++) {
        made++;
        rows.push({ id: `build-${key}-${String(made).padStart(3, '0')}`, month: key, seq: made, date, day: i + 1, perDay: n });
      }
    });
  }
  return { rows, months };
}
