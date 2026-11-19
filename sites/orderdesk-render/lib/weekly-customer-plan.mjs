import { dealerSlug, excludedPlanningDealer, isStockCustomer } from './dealership.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { isTowable } from './stock-forecast.mjs';
const key = v => String(v || '').toUpperCase().replace(/[-\s]/g, '');
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export function mondayOf(day) { const d = new Date(`${day}T00:00:00Z`); return plus(day, -((d.getUTCDay() + 6) % 7)); }
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Only signed named customers in the editable queues can enter the mix.
 * Physical/duplicate vehicles and excluded dealerships never re-enter it. */
export function customerCandidates({ rows, dealers = [], today, settings = {} }) {
  const counts = new Map(); for (const r of rows) if (!r.empty) counts.set(key(r.chassis), (counts.get(key(r.chassis)) || 0) + 1);
  const physical = new Set(dealers.flatMap(d => (d.vehicles || []).map(v => key(v.chassis))));
  const known = new Set(dealers.map(d => d.slug));
  const duration = (k, fallback) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : fallback);
  const poolReady = plus(today, duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40));
  return rows.flatMap(r => {
    const chassis = key(r.chassis), name = String(r.customer || '').trim(), signedAt = signedPlansDate([r.signedAt], today);
    if (r.empty || !chassis || counts.get(chassis) !== 1 || physical.has(chassis) || !['locked', 'customers'].includes(r.group)
      || !name || isStockCustomer(name) || !isTowable(r) || !signedAt || excludedPlanningDealer(r.dealer)) return [];
    const slug = dealerSlug(dealers, r.dealer);
    if (!known.has(slug)) return [];
    const requested = String(r.requestDate || '').trim();
    if (requested && !validDate(requested) && !/^(urgent|asap|紧急)$/i.test(requested)) return [];
    return [{ ...r, chassis, slug, signedAt, ready: [r.group === 'locked' ? today : poolReady, validDate(requested) ? requested : ''].sort().at(-1) }];
  }).sort((a, b) => Number(a.group !== 'locked') - Number(b.group !== 'locked') || a.signedAt.localeCompare(b.signedAt) || (a.orderRow ?? 1e9) - (b.orderRow ?? 1e9) || a.chassis.localeCompare(b.chassis));
}

/** Carry rounding through individual places, bounding both weekly and monthly
 * reservation error below one vehicle. Missing customers leave visible empty
 * places; they never become Stock places. */
export function weeklyCustomerPlan({ slots, candidates = [], percent = 35 }) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('客户比例须为0–100 / Customer percentage must be 0–100');
  const grouped = new Map();
  for (const day of [...slots].sort()) { const week = mondayOf(day); if (!grouped.has(week)) grouped.set(week, []); grouped.get(week).push(day); }
  const stockSlots = [], stockPlaces = [], customerRows = [], weeks = [], used = new Set();
  let sequence = 0;
  for (const [week, days] of grouped) {
    const start = sequence;
    const customerSlots = Math.round((start + days.length) * percent / 100) - Math.round(start * percent / 100);
    let customerOrders = 0, waiting = 0;
    days.forEach(day => {
      sequence++;
      const customerPlace = Math.round(sequence * percent / 100) > Math.round((sequence - 1) * percent / 100);
      if (!customerPlace) { stockSlots.push(day); stockPlaces.push({ day, slotOrder: sequence }); return; }
      const r = candidates.find(r => !used.has(r.chassis) && r.ready <= day);
      if (!r) {
        waiting++;
        customerRows.push({ slotId: `customer-place-${sequence}`, slotOrder: sequence, chassis: '', model: '', modelYear: '', customer: '', kind: 'customer-gap', group: 'customers', from: '', to: '',
          originalDealer: '', proposedDealer: '', plannedAu: day, simulatedAu: day, plannedArrival: '', receive: true, reallocated: false, action: 'waitingCustomer' });
        return;
      }
      used.add(r.chassis); customerOrders++;
      customerRows.push({ slotId: `customer-place-${sequence}`, slotOrder: sequence, chassis: r.chassis, model: r.model || '', modelYear: String(r.modelYear || ''), customer: r.customer,
        kind: 'customer', group: r.group, from: r.slug, to: r.slug, originalDealer: r.dealer, proposedDealer: r.dealer,
        originalAu: r.auEnd || '', plannedAu: day, simulatedAu: day, plannedArrival: '', signedAt: r.signedAt, ready: r.ready, receive: true, reallocated: false, action: 'customer' });
    });
    weeks.push({ week, slots: days.length, customerSlots, stockSlots: days.length - customerSlots, customerOrders, waiting });
  }
  const monthKeys = [...new Set(slots.map(day => day.slice(0, 7)))].sort();
  const months = monthKeys.map(month => {
    const total = slots.filter(day => day.startsWith(month)).length, selected = customerRows.filter(r => r.plannedAu.startsWith(month));
    return { month, slots: total, customerSlots: selected.length, stockSlots: total - selected.length, customerOrders: selected.filter(r => r.kind === 'customer').length, waiting: selected.filter(r => r.kind === 'customer-gap').length };
  });
  return { percent, months, stockSlots, stockPlaces, rows: customerRows, weeks, unplanned: candidates.filter(r => !used.has(r.chassis)).map(r => ({ chassis: r.chassis, group: r.group, customer: r.customer })) };
}
