import { excludedPlanningDealer } from './dealership.mjs';
// Quantity is the first objective. Weekly mix is a soft target; physical capacity,
// valid signatures and lead times remain hard constraints; inventory is optimised.
import { randomUUID } from 'node:crypto';
import { isRollingCustomer, isStockCustomer, dealerSlug, leadDays } from './dealership.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { recommendPoolStock } from './stock-rolling.mjs';
import { replayInventoryBasis, availableRollingSlots } from './inventory-basis-replay.mjs';
import { confirmedStockPlan } from './stock-plan-confirmation.mjs';
import { buildRollingReport } from './rolling-report.mjs';

const MS = 86400000, stamp = d => Date.parse(`${d}T00:00:00Z`);
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
const norm = s => String(s || '').toUpperCase().replace(/[-\s]/g, '');
const fixedGroups = new Set(['au', 'sea', 'cn', 'locked']);
const dateOnly = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(stamp(s)) && new Date(stamp(s)).toISOString().slice(0, 10) === s ? s : '';
export function weekOf(day) { const d = new Date(stamp(day)); return plus(day, -((d.getUTCDay() + 6) % 7)); }
export function rollingQuantity(value) {
  if (value === '' || value == null || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3000) throw new Error('滚动排产数量须为1–3000的整数 / Rolling quantity must be an integer from 1 to 3000');
  return Number(value);
}
export function rollingCustomerPercent(value = 35) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) throw new Error('客户比例须为0–100 / Customer percentage must be between 0 and 100');
  return Number(value);
}

export function buildBalancedRolling({ plan, fingerprint, line, dealers = [], capacity, settings = {}, orders = {}, quantity, customerPercent = 35, maxStockMonths = 3, blockers = [], actor = 'Planning' }) {
  quantity = rollingQuantity(quantity); customerPercent = rollingCustomerPercent(customerPercent);
  maxStockMonths = Number(maxStockMonths);
  if (!Number.isFinite(maxStockMonths) || maxStockMonths <= 0 || maxStockMonths > 24) throw new Error('Stock覆盖月数须大于0且不超过24 / Invalid Stock cover target');
  const share = customerPercent / 100;
  if (!plan || plan.fingerprint !== fingerprint || blockers.length) throw new Error('请先在库存调整预测中保存当前意见，再生成滚动排产 / Save the current stock opinion first');
  plan = confirmedStockPlan(plan, fingerprint);
  if (!capacity?.size) throw new Error('AU产能尚未准备');
  const replayed = replayInventoryBasis({ line, report: plan.report, capacity, dealers });
  line = replayed.line; plan = { ...plan, report: replayed.report };
  const duration = (k, d) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : d);
  const today = line.today, lead = duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40);
  const earliest = [plus(today, lead), replayed.replay.rollingBoundary].sort().at(-1), latest = plan.report.planningEnd;
  const fixed = line.rows.filter(r => fixedGroups.has(r.group) && !r.planningExcluded && !r.empty && r.auForecast?.kind === 'towable');
  const available = availableRollingSlots(line, capacity, earliest, latest);
  const inactive = new Set(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => norm(o.chassis)));
  const physical = new Set(dealers.flatMap(d => (d.vehicles || []).map(v => norm(v.chassis))));
  const counts = new Map(); for (const r of line.rows) if (!r.empty) counts.set(norm(r.chassis), (counts.get(norm(r.chassis)) || 0) + 1);
  const customers = [], customerHolds = [];
  for (const r of line.rows.filter(r => ['customers', 'later', 'rolling', 'processing'].includes(r.group) && !r.empty && !excludedPlanningDealer(r.dealer) && isRollingCustomer(r))) {
    const signedAt = signedPlansDate([r.signedAt], today), request = dateOnly(r.requestDate);
    const reason = !norm(r.chassis) || counts.get(norm(r.chassis)) !== 1 || physical.has(norm(r.chassis)) ? 'duplicateOrPhysical'
      : inactive.has(norm(r.chassis)) ? 'inactive' : !signedAt ? 'unsigned'
      : r.requestDate && !request && !/^(urgent|紧急|asap)$/i.test(r.requestDate.trim()) ? 'deliveryDate' : '';
    if (reason) { customerHolds.push({ chassis: r.chassis, dealer: r.dealer, model: r.model, signedAt, requestDate: r.requestDate || '', reason }); continue; }
    // Requested delivery <= AU finish, as explicitly requested by Planning.
    const ready = [earliest, request].sort().at(-1);
    customers.push({ r, signedAt, ready });
  }
  customers.sort((a, b) => a.signedAt.localeCompare(b.signedAt) || (a.r.orderRow ?? 1e9) - (b.r.orderRow ?? 1e9) || a.r.chassis.localeCompare(b.r.chassis));
  const fixedByWeek = new Map();
  for (const r of fixed.filter(r => r.auEnd)) {
    const k = weekOf(r.auEnd), v = fixedByWeek.get(k) || { customer: 0, stock: 0, unknown: 0 };
    v[isStockCustomer(r.customer) ? 'stock' : String(r.customer || '').trim() ? 'customer' : 'unknown']++; fixedByWeek.set(k, v);
  }
  const admitted = line.rows.filter(r => isStockCustomer(r.customer)).map(r => norm(r.chassis));
  const stockInput = { plan: { ...plan, admitted }, fingerprint, line, dealers, capacity, settings, orders, blockers, fillToCap: true, horizonEnd: latest, fullTarget: true, allowDrafts: false, maxStockMonths };
  function chooseCustomers(days) {
    const chosen = new Set();
    return [...days].sort().flatMap(day => {
      const c = customers.find(c => !chosen.has(c) && c.ready <= day);
      if (!c) return [];
      chosen.add(c);
      const slug = dealerSlug(dealers, c.r.dealer), dealer = dealers.find(d => d.slug === slug), transit = dealer && leadDays(dealer);
      return [{ chassis: norm(c.r.chassis), model: c.r.model, range: c.r.range || '', modelYear: c.r.modelYear || '', dealer: c.r.dealer, slug,
        customer: c.r.customer, signedAt: c.signedAt, requestDate: c.r.requestDate || '', kind: 'customer', auEnd: day, cnStart: plus(day, -lead),
        arrival: transit != null ? plus(day, transit) : '', week: weekOf(day) }];
    });
  }
  function allocateWindow(window) {
    const byWeek = new Map(); for (const day of window) { const w = weekOf(day); byWeek.set(w, [...(byWeek.get(w) || []), day]); }
    let cumulative = 0, priorGoal = 0; const desiredCustomerDays = [];
    for (const days of byWeek.values()) {
      cumulative += days.length;
      const goal = Math.round(cumulative * share) - priorGoal; priorGoal += goal;
      // Spread customers across the week instead of putting them at its beginning.
      for (let i = 0; i < days.length; i++) if (Math.floor((i + 1) * goal / days.length) > Math.floor(i * goal / days.length)) desiredCustomerDays.push(days[i]);
    }
    let customerItems = chooseCustomers(desiredCustomerDays);
    const subtractDays = (all, occupied) => { const count = new Map(); for (const d of occupied) count.set(d, (count.get(d) || 0) + 1); return all.filter(d => { if (!count.get(d)) return true; count.set(d, count.get(d) - 1); return false; }); };
    let stockSlots = subtractDays(window, customerItems.map(a => a.auEnd));
    const maxDealerLead = Math.max(0, ...dealers.filter(d => !d.paused && d.target > 0).map(d => leadDays(d) ?? 0));
    const snapshotDate = [today, ...customerItems.map(a => a.arrival || a.auEnd), window.length ? plus(window.at(-1), maxDealerLead) : today].sort().at(-1);
    const actual = recommendPoolStock({ ...stockInput, candidateSlots: stockSlots, snapshotDate });
    // Fill unoccupied places with ready signed customers before creating any draft
    // Stock orders. A requested mix must never leave usable real orders unplanned.
    const gaps = subtractDays(stockSlots, actual.items.map(a => a.auEnd));
    const fallbackDays = [...customerItems.map(a => a.auEnd), ...gaps];
    customerItems = chooseCustomers(fallbackDays);
    stockSlots = subtractDays(window, customerItems.map(a => a.auEnd));
    const stock = recommendPoolStock({ ...stockInput, candidateSlots: stockSlots, includeRequests: true, preallocatedStock: actual.items, snapshotDate });
    stock.requested = stock.admitted;
    return { byWeek, customerItems, stock, window };
  }
  // The period is the first N remaining places after the adjusted locked line.
  // Inventory cover and weekly mix must never move or skip these places.
  const { byWeek, customerItems, stock, window } = allocateWindow(available.slice(0, quantity));
  const schedule = [...customerItems, ...stock.items.map(a => ({ ...a, kind: 'stock', week: weekOf(a.auEnd) }))]
    .sort((a, b) => a.auEnd.localeCompare(b.auEnd) || (a.kind === 'customer' ? 0 : 1) - (b.kind === 'customer' ? 0 : 1) || (a.signedAt || '').localeCompare(b.signedAt || '') || a.chassis.localeCompare(b.chassis));
  const requests = stock.requests.map(a => ({ ...a, week: weekOf(a.requestedAu) }));
  const weeks = [...byWeek].map(([week, days]) => {
    const f = fixedByWeek.get(week) || { customer: 0, stock: 0, unknown: 0 }, mine = schedule.filter(a => a.week === week), missing = requests.filter(a => a.week === week);
    const customer = mine.filter(a => a.kind === 'customer').length, realStock = mine.length - customer, newOrders = missing.filter(a => a.status === 'newOrder').length;
    const total = mine.length, plannedTotal = total + newOrders, customerTarget = days.length * share;
    const ratio = total ? customer / total : null, plannedRatio = plannedTotal ? customer / plannedTotal : null;
    const met = n => n > 0 && customer >= Math.floor(n * share + 1e-8) && customer <= Math.ceil(n * share - 1e-8);
    return { week, fixedCustomer: f.customer, fixedStock: f.stock, unknown: f.unknown, target: days.length, customerTarget,
      customer, stock: realStock, newOrders, blocked: missing.length - newOrders, customerShare: ratio, plannedCustomerShare: plannedRatio,
      ratioMet: met(total), plannedRatioMet: met(plannedTotal),
      note: met(total) ? '' : 'Quantity prioritised; eligible orders or delivery dates limit this week’s mix.' };
  });
  const selected = new Set(customerItems.map(a => a.chassis));
  for (const c of customers) if (!selected.has(norm(c.r.chassis))) customerHolds.push({ chassis: c.r.chassis, dealer: c.r.dealer, model: c.r.model, signedAt: c.signedAt,
    requestDate: c.r.requestDate || '', ready: c.ready, reason: c.ready > latest ? 'notReady' : 'quantityOrMix' });
  if (schedule.length !== quantity) {
    const reason = window.length < quantity ? `当前有效AU产能仅有 ${window.length} 个位置` : `锁定线后连续产能窗口内可排的已签字Towable真实订单仅 ${schedule.length} 台`;
    throw new Error(`本期必须排满 ${quantity} 台，${reason}，不能保存未排满的方案。请补齐合格订单、交付日期或有效产能后重试。 / Cannot save an incomplete rolling plan (${schedule.length}/${quantity}).`);
  }
  const c = plan.confirmation;
  const adjustmentBasis = { planId: plan.id, confirmationId: c.id, confirmedAt: c.confirmedAt, confirmedBy: c.confirmedBy, summary: c.summary };
  const result = { algorithmVersion: 6, confirmationId: c.id, adjustmentBasis, basisReplay: replayed.replay, maxStockMonths, confirmedAdjustments: ['own', 'jv', 'independent'].flatMap(g => plan.report[g]?.actions || []).filter(a => a.action === 'cancel' || a.delayed || a.reallocated), fullTarget: true, id: randomUUID(), opinionId: plan.id, fingerprint, createdAt: new Date().toISOString(), createdBy: String(actor).slice(0, 60), quantity, customerPercent,
    deliveryRule: 'requestDate<=auEnd', ratioScope: 'rolling-week', start: window[0] || '', end: window.at(-1) || '', earliest, latest, windowSlots: window.length, availableSlots: available.length,
    scheduled: schedule.length, customerCount: customerItems.length, stockCount: stock.items.length,
    newOrders: requests.filter(a => a.status === 'newOrder').length, inventoryBlocked: requests.filter(a => a.status === 'blocked').length,
    capacityGap: Math.max(0, quantity - window.length), customerWaiting: customers.length - customerItems.length, customerHolds,
    actualGap: quantity - schedule.length, plannedQuantity: schedule.length + requests.filter(a => a.status === 'newOrder').length,
    quantityMet: schedule.length === quantity, schedule, requests, weeks, stockResult: stock };
  result.report = buildRollingReport(result, dealers, plan);
  return result;
}
