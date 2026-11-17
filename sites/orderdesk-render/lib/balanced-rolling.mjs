// A feasible rolling proposal, not a factory execution instruction. Stock is
// checked against the same saved inventory opinion used by Stock Forecast.
import { randomUUID } from 'node:crypto';
import { isRollingCustomer, isStockCustomer } from './dealership.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { recommendPoolStock } from './stock-rolling.mjs';

const MS = 86400000, stamp = d => Date.parse(`${d}T00:00:00Z`);
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
const norm = s => String(s || '').toUpperCase().replace(/[-\s]/g, '');
const fixedGroups = new Set(['au', 'sea', 'cn', 'locked']);
export function weekOf(day) { const d = new Date(stamp(day)); return plus(day, -((d.getUTCDay() + 6) % 7)); }
export function rollingQuantity(value) {
  if (value === '' || value == null || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3000) throw new Error('滚动排产数量须为1–3000的整数 / Rolling quantity must be an integer from 1 to 3000');
  return Number(value);
}

export function buildBalancedRolling({ plan, fingerprint, line, dealers, capacity, settings = {}, orders = {}, quantity, blockers = [], actor = 'Planning' }) {
  quantity = rollingQuantity(quantity);
  if (!plan || plan.fingerprint !== fingerprint || blockers.length) throw new Error('请先在库存调整预测中保存当前意见，再生成滚动排产 / Save the current stock opinion first');
  if (!capacity?.size) throw new Error('AU产能尚未准备');
  const duration = (k, d) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : d);
  const today = line.today, lead = duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40);
  const earliest = plus(today, lead), latest = plus(earliest, 60), slots = [];
  for (const [d, c] of [...capacity].sort(([a], [b]) => a.localeCompare(b))) if (d >= today) for (let i = 0; i < c.towable; i++) slots.push(d);
  const fixed = line.rows.filter(r => fixedGroups.has(r.group) && !r.empty && r.auForecast?.kind === 'towable');
  const used = fixed.reduce((n, r) => Math.max(n, r.auForecast?.seq || 0), 0);
  const available = slots.slice(used).filter(d => d >= earliest && d <= latest);
  let window = available.slice(0, quantity);
  const inactive = new Set(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => norm(o.chassis)));
  const counts = new Map(); for (const r of line.rows) counts.set(norm(r.chassis), (counts.get(norm(r.chassis)) || 0) + 1);
  const duePriority = r => /urgent|紧急/i.test(r.requestDate || '') ? '0000' : /^\d{4}-\d{2}-\d{2}$/.test(r.requestDate || '') ? r.requestDate : r.forecast || '9999';
  const customers = line.rows.filter(r => ['customers', 'later', 'rolling'].includes(r.group) && !r.empty && counts.get(norm(r.chassis)) === 1
    && !inactive.has(norm(r.chassis)) && r.regentRank >= 6 && isRollingCustomer(r) && signedPlansDate([r.signedAt], today))
    .map(r => ({ r, ready: r.forecast && /^\d{4}-\d{2}-\d{2}$/.test(r.forecast) ? [earliest, plus(r.forecast, duration('auDays', 40))].sort().at(-1) : earliest }))
    .sort((a, b) => duePriority(a.r).localeCompare(duePriority(b.r)) || (a.r.orderRow ?? 1e9) - (b.r.orderRow ?? 1e9) || a.r.chassis.localeCompare(b.r.chassis));
  const probeInput = { plan, fingerprint, line, dealers, capacity, settings, orders, candidateSlots: available };
  const poolProbe = recommendPoolStock(probeInput);
  const probe = poolProbe.items.length ? poolProbe : recommendPoolStock({ ...probeInput, includeRequests: true });
  const firstStock = [...probe.items.map(a => a.auEnd), ...probe.requests.filter(a => a.status === 'newOrder').map(a => a.auEnd)].sort()[0];
  if (firstStock) window = available.filter(d => weekOf(d) >= weekOf(firstStock)).slice(0, quantity);
  const fixedByWeek = new Map();
  for (const r of fixed.filter(r => r.auEnd)) {
    const k = weekOf(r.auEnd), v = fixedByWeek.get(k) || { customer: 0, stock: 0, unknown: 0 };
    v[isStockCustomer(r.customer) ? 'stock' : String(r.customer || '').trim() ? 'customer' : 'unknown']++; fixedByWeek.set(k, v);
  }
  function allocateWindow(daysToUse) {
    for (const c of customers) c.selected = false;
    const byWeek = new Map(); for (const d of daysToUse) { const w = weekOf(d); byWeek.set(w, [...(byWeek.get(w) || []), d]); }
    const customerItems = [], stockSlots = [];
    for (const [week, days] of byWeek) {
      const f = fixedByWeek.get(week) || { customer: 0, stock: 0, unknown: 0 }, n = days.length, total = n + f.customer + f.stock + f.unknown;
      const ready = customers.filter(c => !c.selected && c.ready <= days.at(-1)).length;
      const min = Math.max(0, Math.ceil(total * .3) - f.customer), max = Math.max(0, Math.floor(total * .4) - f.customer);
      const goal = Math.min(n, ready, Math.max(min, Math.min(max, Math.round(total * .35) - f.customer)));
      let assigned = 0;
      for (let i = 0; i < n; i++) {
        const due = Math.floor((i + 1) * goal / n) > assigned || n - i <= goal - assigned;
        const candidate = due && customers.find(c => !c.selected && c.ready <= days[i]);
        if (!candidate) { stockSlots.push(days[i]); continue; }
        candidate.selected = true; assigned++;
        customerItems.push({ chassis: norm(candidate.r.chassis), model: candidate.r.model, dealer: candidate.r.dealer, customer: candidate.r.customer, requestDate: candidate.r.requestDate || '',
          kind: 'customer', auEnd: days[i], cnStart: plus(days[i], -lead), week });
      }
    }
    // Use the pool across the whole horizon first. Only then propose new orders,
    // reserving those actual arrivals so early suggestions cannot displace them.
    const admitted = line.rows.filter(r => isStockCustomer(r.customer)).map(r => norm(r.chassis));
    const input = { plan: { ...plan, admitted }, fingerprint, line, dealers, capacity, settings, orders, blockers, candidateSlots: stockSlots };
    const actual = recommendPoolStock(input);
    const stock = recommendPoolStock({ ...input, includeRequests: true, preallocatedStock: actual.items });
    stock.requested = stock.admitted;
    return { byWeek, customerItems, stock, window: daysToUse };
  }
  const eligible = firstStock ? available.filter(d => weekOf(d) >= weekOf(firstStock)) : available;
  let current = allocateWindow(window), best = current, cursor = window.length, futureRequests = null;
  const score = r => {
    let deviation = 0;
    for (const [week] of r.byWeek) {
      const f = fixedByWeek.get(week) || { customer: 0, stock: 0, unknown: 0 };
      const customer = r.customerItems.filter(a => a.week === week).length + f.customer;
      const n = customer + f.stock + f.unknown + r.stock.items.filter(a => weekOf(a.auEnd) === week).length + r.stock.requests.filter(a => a.status === 'newOrder' && weekOf(a.auEnd) === week).length;
      const ratio = n ? customer / n : 0; deviation += Math.max(0, .3 - ratio, ratio - .4);
    }
    return [r.stock.items.length, r.stock.items.length + r.customerItems.length,
      r.stock.items.length + r.customerItems.length + r.stock.requests.filter(a => a.status === 'newOrder').length, -deviation, -stamp(r.window.at(-1) || today)];
  };
  const better = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  // Recheck later receiving weeks before creating more stock orders. Keep the
  // best feasible pool usage; never move orders beyond the rolling horizon.
  for (let attempt = 0; attempt < 20 && current.stock.requests.length && cursor < eligible.length; attempt++) {
    const ids = new Set(current.stock.items.map(a => a.chassis)), last = current.window.at(-1);
    let next = poolProbe.items.filter(a => !ids.has(a.chassis) && a.auEnd > last).map(a => a.auEnd).sort()[0];
    if (!next && current.stock.requests.some(a => a.status === 'blocked')) {
      futureRequests ??= recommendPoolStock({ ...probeInput, includeRequests: true, preallocatedStock: poolProbe.items });
      next = futureRequests.requests.filter(a => a.status === 'newOrder' && a.auEnd > last).map(a => a.auEnd).sort()[0];
    }
    if (!next) break;
    const at = eligible.findIndex((d, i) => i >= cursor && weekOf(d) >= weekOf(next)); if (at < 0) break;
    const count = Math.min(current.stock.requests.length, eligible.length - at), remove = new Map();
    for (const r of current.stock.requests.slice().sort((a, b) => a.requestedAu.localeCompare(b.requestedAu)).slice(0, count)) remove.set(r.requestedAu, (remove.get(r.requestedAu) || 0) + 1);
    const days = current.window.filter(d => { if (!remove.get(d)) return true; remove.set(d, remove.get(d) - 1); return false; });
    days.push(...eligible.slice(at, at + count)); days.sort(); cursor = at + count;
    current = allocateWindow(days); if (better(current, best)) best = current;
  }
  const { byWeek, customerItems, stock } = best; window = best.window;
  const schedule = [...customerItems, ...stock.items.map(a => ({ ...a, kind: 'stock', week: weekOf(a.auEnd) }))]
    .sort((a, b) => a.auEnd.localeCompare(b.auEnd) || (a.kind === 'customer' ? -1 : 1) - (b.kind === 'customer' ? -1 : 1) || a.chassis.localeCompare(b.chassis));
  const requests = stock.requests.map(a => ({ ...a, week: weekOf(a.requestedAu) }));
  const weeks = [...byWeek].map(([week, days]) => {
    const f = fixedByWeek.get(week) || { customer: 0, stock: 0, unknown: 0 }, mine = schedule.filter(a => a.week === week), missing = requests.filter(a => a.week === week);
    const customer = mine.filter(a => a.kind === 'customer').length, realStock = mine.length - customer, newOrders = missing.filter(a => a.status === 'newOrder').length;
    const total = f.customer + f.stock + f.unknown + mine.length, plannedTotal = total + newOrders;
    const ratio = f.unknown || !total ? null : (f.customer + customer) / total;
    const plannedRatio = f.unknown || !plannedTotal ? null : (f.customer + customer) / plannedTotal;
    return { week, fixedCustomer: f.customer, fixedStock: f.stock, unknown: f.unknown, target: days.length,
      customer, stock: realStock, newOrders, blocked: missing.length - newOrders, customerShare: ratio, plannedCustomerShare: plannedRatio,
      ratioMet: ratio != null && ratio >= .3 && ratio <= .4, plannedRatioMet: plannedRatio != null && plannedRatio >= .3 && plannedRatio <= .4 };
  });
  return { id: randomUUID(), opinionId: plan.id, fingerprint, createdAt: new Date().toISOString(), createdBy: String(actor).slice(0, 60), quantity,
    earliest, latest, windowSlots: window.length, availableSlots: available.length, scheduled: schedule.length, customerCount: customerItems.length, stockCount: stock.items.length,
    newOrders: requests.filter(a => a.status === 'newOrder').length, inventoryBlocked: requests.filter(a => a.status === 'blocked').length,
    capacityGap: Math.max(0, quantity - window.length), customerWaiting: customers.length - customerItems.length,
    schedule, requests, weeks, stockResult: stock, ratioMin: .3, ratioMax: .4 };
}
