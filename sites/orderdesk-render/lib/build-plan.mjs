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

// motorhomeSchedule/models order: SRM 22.1, SRM 22.2, SRM 24.1, SRM 25.1, SRM 26.1, SRM 29.1, SRV19.1, SRV22.1, SRV22.2, SRV22.3.
const isSrv = name => /^SRV/i.test(String(name || '').trim());

/** Monthly AU production plan (yyyy-mm) from the Portal "Production & dispatch" nodes: total, SRM, SRV and Towable (= total − SRM − SRV). */
export function planQuantities({ dispatchPlan, motorhomePlans, modelNames = [] }) {
  const out = new Map();
  for (const key of BUILD_PLAN_MONTHS) {
    const [y, m] = key.split('-'), i = Number(m) - 1;
    const totals = listOf(dispatchPlan?.[y]?.totalProduction);
    const month = listOf(motorhomePlans?.[y])[i] || {};
    let srm = 0, srv = 0;
    listOf(month.models).forEach((q, k) => { const name = listOf(modelNames)[k] || (k >= 6 ? 'SRV' : 'SRM'); if (isSrv(name)) srv += int(q); else srm += int(q); });
    const total = int(totals[i]);
    out.set(key, { total, srm, srv, srvSrm: srm + srv, towable: Math.max(0, total - srm - srv), portalWorkingDays: int(month.workingDays) });
  }
  return out;
}
/** Towable quantity per month (kept for the build-plan tab). */
export const towableQuantities = args => planQuantities(args);

/** Spread a month quantity over its working days with cumulative rounding (10.5 a day → 10, 11, 10, 11 …; the month adds up exactly). */
function spread(total, days) {
  let made = 0;
  return days.map((_, i) => { const upto = Math.round((total * (i + 1)) / days.length), n = upto - made; made = upto; return n; });
}

/** AU finish capacity per working day: Map date → { towable, srm, srv }. */
export function dailyCapacity(quantities, calendar) {
  const out = new Map();
  if (!calendar) return out;
  for (const [key, q] of quantities) {
    const days = [...calendar.days].filter(d => d.startsWith(key)).sort();
    if (!days.length) continue;
    const t = spread(q.towable, days), m = spread(q.srm, days), v = spread(q.srv, days);
    days.forEach((d, i) => out.set(d, { towable: t[i], srm: m[i], srv: v[i] }));
  }
  return out;
}

/** Which capacity a vehicle uses: SRV and SRM have their own monthly numbers and do not take Towable places. */
export function capacityKind(model) {
  const m = String(model || '').trim().toUpperCase();
  return m.startsWith('SRV') ? 'srv' : m.startsWith('SRM') ? 'srm' : 'towable';
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
