// Production schedule: the website version of Planning Schedule's Orderlist.
//
// state.schedule = { rows: [{ chassis: <order id> | null, dealer }], pending: [<order id>] }
//   rows[i] is Orderlist row i + 2 (row 1 is the header). A row without chassis is a
//   slot reserved for its dealer. Row order is never changed by daily processing.
// state.calendar = { weeks: [{ row, monday, workingDays, daily, weekly, modification, start }] }
//   Mirrors the Calendar sheet (rows 4..268); `start` is column L, `monday` column C.
//
// Business rules confirmed by Planning (2026-11-05):
//   - a new order takes its dealer's earliest empty slot (smallest row number);
//   - a dealer without an empty slot leaves the order in `pending` (rule to be decided);
//   - a cancelled order's row is cleared back into an empty slot for that dealer,
//     rows below do not move up.
import { normalizeChassis } from './order-engine.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Excel LOOKUP(ROW(), Calendar!L4:L268, Calendar!C4:C268) — reproduces Excel's binary
 * search including blanks and the non-monotonic start rows created by Modification,
 * verified against all 8,947 Orderlist rows of Planning Schedule 2025 (4).
 */
export function excelLookup(keys, values, x) {
  let lo = 0, hi = keys.length - 1, ans = -1;
  while (lo <= hi) {
    let j = Math.floor((lo + hi) / 2);
    if (!isNum(keys[j])) {
      let k = j; while (k >= lo && !isNum(keys[k])) k--;
      if (k < lo) { k = j; while (k <= hi && !isNum(keys[k])) k++; if (k > hi) break; }
      j = k;
    }
    if (keys[j] === x) {
      // An exact hit advances over following equal keys (blanks in between are skipped).
      for (;;) {
        let k = j + 1; while (k < keys.length && !isNum(keys[k])) k++;
        if (k < keys.length && keys[k] === x) j = k; else break;
      }
      ans = j; break;
    }
    if (keys[j] < x) { ans = j; lo = j + 1; } else hi = j - 1;
  }
  return ans < 0 ? null : values[ans] ?? null;
}

export function forecastResolver(calendar) {
  const weeks = calendar?.weeks || [];
  const keys = weeks.map(w => w.start), values = weeks.map(w => w.monday);
  const cache = new Map();
  return excelRow => {
    if (!cache.has(excelRow)) cache.set(excelRow, excelLookup(keys, values, excelRow));
    return cache.get(excelRow);
  };
}

/** Recalculate Calendar J and L after editing working days / daily slots / modification. */
export function recomputeCalendar(calendar, { fromRow = 66 } = {}) {
  const weeks = calendar.weeks.map(w => ({ ...w }));
  for (const w of weeks) if (w.row >= 64 && isNum(w.workingDays) && isNum(w.daily)) w.weekly = Math.floor(w.workingDays * w.daily);
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    if (w.row === 65) w.start = weeks[i - 1].start;                    // L65 = L64
    else if (w.row >= fromRow) { const p = weeks[i - 1]; w.start = (p.start || 0) + (p.modification || 0) + (p.weekly || 0); }
  }
  return { ...calendar, weeks };
}

export const excelRowOf = index => index + 2;

/** Map of order id -> row index in schedule.rows. */
export function slotIndex(schedule) {
  const map = new Map();
  (schedule?.rows || []).forEach((r, i) => { if (r.chassis) map.set(r.chassis, i); });
  return map;
}

/**
 * Keep the schedule consistent with orders after any save. Pure: returns a new state.
 * Called for every write, so CRM imports from the browser, the Planning PC and Graph
 * mail sync all follow the same slot rules without changing the CRM business engine.
 */
export function reconcileSchedule(prev, next, { now = new Date().toISOString() } = {}) {
  if (!next?.schedule?.rows) return next;
  const rows = next.schedule.rows.map(r => ({ ...r }));
  const pending = new Set(next.schedule.pending || []);
  const where = new Map(); rows.forEach((r, i) => { if (r.chassis) where.set(r.chassis, i); });
  const forecast = forecastResolver(next.calendar);
  const orders = { ...next.orders }, events = { ...next.events };
  let changed = false;
  const log = (order, type, changes, extra = {}) => {
    const id = `schedule_${type}_${order.id}_${now.replace(/\D/g, '').slice(0, 14)}`;
    events[id] = { id, orderId: order.id, chassis: order.chassis, dealer: order.dealer, type: 'changed', date: extra.date || now.slice(0, 10), at: now, changes, scheduleAction: type };
  };
  for (const [id, order] of Object.entries(orders)) {
    const before = prev?.orders?.[id];
    const at = where.get(id);
    if (order.status === 'cancelled') {
      pending.delete(id);
      if (at !== undefined) {
        rows[at] = { chassis: null, dealer: rows[at].dealer };          // clear, never shift
        where.delete(id);
        orders[id] = { ...order, slotRow: null };
        log(order, 'released', [{ field: 'slotRow', before: excelRowOf(at), after: null }], { date: order.cancelledAt });
        changed = true;
      }
      continue;
    }
    const isNewOrder = !before && order.status === 'active';
    if (at === undefined && isNewOrder && !pending.has(id)) {
      const slot = rows.findIndex(r => !r.chassis && r.dealer === order.dealer);
      if (slot >= 0) {
        rows[slot] = { chassis: id, dealer: rows[slot].dealer };
        where.set(id, slot);
        const date = forecast(excelRowOf(slot));
        orders[id] = { ...order, slotRow: excelRowOf(slot), forecastDate: date };
        log(order, 'assigned', [{ field: 'forecastDate', before: order.forecastDate ?? null, after: date }], { date: order.receivedAt });
      } else {
        pending.add(id);
      }
      changed = true;
    }
  }
  // An order that left pending some other way (cancelled / manually placed) is removed.
  for (const id of pending) if (!orders[id] || where.has(id)) { pending.delete(id); changed = true; }
  if (!changed) return next;
  return { ...next, orders, events, schedule: { ...next.schedule, rows, pending: [...pending] } };
}

/** Rows for display / export: every Orderlist row in order, with its forecast date. */
export function scheduleView(state) {
  const forecast = forecastResolver(state.calendar);
  return (state.schedule?.rows || []).map((r, i) => {
    const excelRow = excelRowOf(i);
    const order = r.chassis ? state.orders?.[r.chassis] : null;
    return { excelRow, dealer: r.dealer, forecastDate: forecast(excelRow), order: order || null };
  });
}

export { normalizeChassis };
