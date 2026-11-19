// A deterministic, read-only simulation. Existing snapshots/legacy calculations remain readable.
import { isCancellationProtected } from './protected-stock.mjs';
import { stockProductionPlan } from './stock-production-plan.mjs';
import { dealerStockMetrics, reallocationYears } from './stock-simulation-metrics.mjs';
import { dealerGroup, dealerSlug, leadDays, isStockCustomer } from './dealership.mjs';
import { DISPLAY_MODELS, NOT_ON_YARD, isTowable, modelPolicy, addCalendarMonth, forecastMultiplier, validateDisplayModels } from './stock-forecast.mjs';

export const SIMULATOR_VERSION = 'dealer-balance-v2-slots';
const MS = 86400000;
const stamp = d => Date.parse(`${d}T00:00:00Z`);
const valid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(stamp(d)) && new Date(stamp(d)).toISOString().slice(0, 10) === d;
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
const key = v => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
const id = v => key(v).replace(/[-\s]/g, '');
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const groups = ['own', 'jv', 'independent'];
const adjustable = new Set(['au', 'sea', 'cn', 'locked']);
const stage = { au: '澳洲生产', sea: '海运', cn: '国内生产', locked: '排产锁定线', rolling: '滚动排产线', customers: '库存订单池', processing: '处理中订单', later: '日期待补', pgi: 'PGI在途', transport: 'Transport' };
const rank = { transport: 0, au: 1, sea: 2, cn: 3, locked: 4, rolling: 5, customers: 6, processing: 7, later: 8 };
const stockVehicle = v => v.category === 'stock' && isTowable(v);
const year2027 = v => String(v.modelYear || '') === '2027';
const fail = message => { throw new Error(message); };
function number(value, name, { nullable = false, max = 100000, integer = false, min = 0 } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) fail(`模拟参数无效 / Invalid ${name}`);
  return value;
}

/** Missing dealer targets/transit stay visible and editable; never silently invent defaults. */
export function normalizeSimulationAssumptions(value = {}, dealers, rows, displayModels = DISPLAY_MODELS, notOnYardModels = NOT_ON_YARD, multiplier = 1.3) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('模拟参数无效 / Invalid assumptions');
  const entries = value.dealers ?? [];
  if (!Array.isArray(entries) || entries.length > 300) fail('Dealer模拟参数无效');
  const known = new Map(dealers.map(d => [d.slug, d])), edits = new Map();
  for (const e of entries) {
    if (!e || !known.has(e.slug) || edits.has(e.slug)) fail('Dealer已变化，请重新读取 / Unknown or duplicate dealer');
    edits.set(e.slug, e);
  }
  const defaults = dealers.map(d => {
    const ideal = Number.isFinite(d.target) && d.target > 0 ? d.target : null;
    // Exactly three completed calendar months, expressed as units per seven days.
    const history = d.handover?.months || [];
    const historyDays = history.reduce((n, m) => n + new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0)).getUTCDate(), 0);
    const weeklyStock = historyDays > 0 ? round(history.reduce((n, m) => n + m.stock, 0) / historyDays * 7) : round(Math.max(0, d.handover?.avgStock || 0) * 12 / 365.25 * 7);
    const models = (d.applicableModels ?? displayModels).filter(m => isTowable({ model: m }) && modelPolicy(m, '2027', displayModels, notOnYardModels) === 'display');
    return { slug: d.slug, currentStock: Math.max(0, d.yard?.stock || 0), weeklyStock, ideal, cap: ideal == null ? null : Math.floor(ideal * multiplier), leadDays: leadDays(d), receiving: !d.paused, models: validateDisplayModels(models) };
  });
  const normalized = defaults.map(d => {
    const e = { ...d, ...edits.get(d.slug) };
    if (typeof e.receiving !== 'boolean') fail('接收状态无效 / Invalid receiving status');
    return { slug: d.slug, currentStock: number(e.currentStock, 'current stock', { integer: true }), weeklyStock: number(e.weeklyStock, 'weekly Stock handovers'),
      ideal: number(e.ideal, 'Ideal', { nullable: true, min: 1, integer: true }), cap: number(e.cap, 'stock ceiling', { nullable: true, integer: true }),
      leadDays: number(e.leadDays, 'days to dealer', { nullable: true, max: 365, integer: true }), receiving: e.receiving,
      models: validateDisplayModels(e.models).filter(m => isTowable({ model: m }) && modelPolicy(m, '2027', displayModels, notOnYardModels) === 'display') };
  });
  const shiftDays = number(value.shiftDays ?? 0, 'AU finish shift', { min: -365, max: 365, integer: true });
  const finishDates = value.finishDates ?? {};
  if (!finishDates || typeof finishDates !== 'object' || Array.isArray(finishDates) || Object.keys(finishDates).length > 15000) fail('虚拟下线日期无效');
  const editable = new Set(rows.filter(r => !r.empty && isTowable(r) && isStockCustomer(r.customer) && (adjustable.has(r.group) || ['rolling', 'customers'].includes(r.group))).map(r => id(r.chassis)));
  const dates = {};
  for (const [chassis, day] of Object.entries(finishDates).sort(([a], [b]) => a.localeCompare(b))) {
    if (!editable.has(id(chassis)) || !valid(day)) fail(`虚拟下线日期无效 / Invalid AU finish: ${chassis}`);
    dates[id(chassis)] = day;
  }
  return { assumptions: { dealers: normalized.sort((a, b) => a.slug.localeCompare(b.slug)), shiftDays, finishDates: dates, auMonthlyProduction: value.auMonthlyProduction ?? {}, exchangeSlots: value.exchangeSlots ?? true }, defaults };
}

export function buildStockSimulation({ dealers, rows = [], today, multiplier = 1.3, months = 8, assumptions = {}, displayModels = DISPLAY_MODELS, notOnYardModels = NOT_ON_YARD, capacity = null, protectChassis = isCancellationProtected }) {
  if (!valid(today)) fail('Invalid simulation date');
  if (!Array.isArray(dealers)) fail('Dealer stock data is unavailable');
  multiplier = forecastMultiplier(multiplier);
  if (![8, 14].includes(Number(months))) fail('预测月份须为8或14 / Forecast months must be 8 or 14');
  months = Number(months);
  const normalized = normalizeSimulationAssumptions(assumptions, dealers, rows, displayModels, notOnYardModels, multiplier);
  assumptions = normalized.assumptions;
  if (typeof assumptions.exchangeSlots !== 'boolean') fail('Invalid slot exchange setting');
  const bySlug = new Map(dealers.map(d => [d.slug, d])), warnings = [], seen = new Set(), actions = [];
  // Yard and physical transit take precedence, including when their dealer differs from a stale production row.
  const vehicles = [], rowMetadata = new Map(rows.filter(r => !r.empty && id(r.chassis)).map(r => [id(r.chassis), r]));
  for (const d of dealers) for (const v of d.vehicles || []) {
    if (!id(v.chassis)) continue;
    if (seen.has(id(v.chassis))) { warnings.push({ code: 'duplicate', chassis: id(v.chassis) }); continue; }
    seen.add(id(v.chassis)); if (stockVehicle(v)) {
      const metadata = rowMetadata.get(id(v.chassis));
      vehicles.push({ ...v, model: v.model || metadata?.model || '', modelYear: v.modelYear || metadata?.modelYear || '', slug: d.slug });
    }
  }
  const source = [];
  for (const r of [...rows].sort((a, b) => (rank[a.group] ?? 99) - (rank[b.group] ?? 99) || id(a.chassis).localeCompare(id(b.chassis)))) {
    if (r.empty || !id(r.chassis) || !(r.group in rank) || !isTowable(r) || !isStockCustomer(r.customer)) continue;
    if (seen.has(id(r.chassis))) { warnings.push({ code: 'duplicate', chassis: id(r.chassis) }); continue; }
    seen.add(id(r.chassis));
    const slug = dealerSlug(dealers, r.dealer);
    if (!bySlug.has(slug)) { warnings.push({ code: 'dealer', chassis: id(r.chassis), dealer: r.dealer }); continue; }
    source.push({ ...r, slug, chassis: id(r.chassis) });
  }
  const auProduction = stockProductionPlan({ capacity, rows, today, monthly: assumptions.auMonthlyProduction, shiftDays: assumptions.shiftDays, finishDates: assumptions.finishDates, managedLocked: new Set(source.filter(r => r.group === 'locked').map(r => r.chassis)) });
  if (auProduction) assumptions.auMonthlyProduction = auProduction.overrides;
  const firstMonth = `${today.slice(0, 7)}-01`, maxEnd = addCalendarMonth(today, 36);
  const finish = r => assumptions.finishDates[id(r.chassis)] || (valid(r.auEnd) ? plus(r.auEnd, assumptions.shiftDays) : '');
  let end = plus(addCalendarMonth(firstMonth, 14), -1);
  for (const r of source) { const d = finish(r); if (d && d <= maxEnd) end = [end, plus(addCalendarMonth(d), 365)].sort().at(-1); }
  if (auProduction?.daily.length) end = [end, plus(addCalendarMonth(auProduction.daily.at(-1)[0]), 365)].sort().at(-1);
  if (end > maxEnd) end = maxEnd;
  const N = Math.round((stamp(end) - stamp(today)) / MS) + 1, at = d => Math.round((stamp(d) - stamp(today)) / MS);
  const dates = Array.from({ length: N }, (_, i) => plus(today, i));
  const monthEnd = t => Math.min(N - 1, at(plus(addCalendarMonth(`${dates[t].slice(0, 7)}-01`), -1)));
  const units = new Map(assumptions.dealers.map(s => [s.slug, { d: bySlug.get(s.slug), s, events: new Float64Array(N), beforeEvents: new Float64Array(N), models: new Map(), initialModels: new Map(), coverage: new Set(), coverageDetails: [], assigned: 0, unknownYard: 0, undated: 0 }]));
  function curve(u, events) {
    const balance = new Float64Array(N), sold = new Float64Array(N), missed = new Float64Array(N);
    let stock = u.s.currentStock;
    for (let t = 0; t < N; t++) { const available = Math.max(0, stock + events[t]), demand = u.s.weeklyStock / 7; sold[t] = Math.min(available, demand); missed[t] = demand - sold[t]; balance[t] = stock = available - sold[t]; }
    return { balance, sold, missed };
  }
  const refresh = u => Object.assign(u, curve(u, u.events));
  function event(u, day, model, quantity = 1) {
    if (!day) return;
    const t = Math.max(0, at(day)); if (t >= N) return;
    u.events[t] += quantity; u.modelCache?.clear();
    const m = key(model); if (!u.models.has(m)) u.models.set(m, new Float64Array(N)); u.models.get(m)[t] += quantity;
  }
  function cover(u, vehicle, via) {
    if (year2027(vehicle) && u.s.models.includes(key(vehicle.model))) {
      u.coverage.add(key(vehicle.model)); u.coverageDetails.push({ model: key(vehicle.model), chassis: vehicle.chassis, via });
    }
  }
  // Retain one of each known MY2027 model first when reducing a virtual yard total.
  // Additional virtual units have no invented model/year and cannot falsely satisfy coverage.
  for (const u of units.values()) {
    const physical = vehicles.filter(v => v.slug === u.s.slug && v.where === 'yard');
    const yardRank = v => year2027(v) && u.s.models.includes(key(v.model)) ? 0 : year2027(v) ? 1 : 2;
    const firsts = new Set(), kept = physical.sort((a, b) => yardRank(a) - yardRank(b) || key(a.model).localeCompare(key(b.model)) || id(a.chassis).localeCompare(id(b.chassis)));
    const unique = [], rest = [];
    for (const v of kept) { const k = `${v.modelYear}:${key(v.model)}`; if (!firsts.has(k)) { firsts.add(k); unique.push(v); } else rest.push(v); }
    u.keptYard = [...unique, ...rest].slice(0, u.s.currentStock);
    for (const v of u.keptYard) { u.initialModels.set(key(v.model), (u.initialModels.get(key(v.model)) || 0) + 1); cover(u, v, 'yard'); }
    u.unknownYard = Math.max(0, u.s.currentStock - Math.min(u.s.currentStock, physical.length)) + [...unique, ...rest].slice(0, u.s.currentStock).filter(v => !v.modelYear || !v.model).length;
  }
  function record(r, group = r.group) {
    const u = units.get(r.slug), originalAu = valid(r.auEnd) ? r.auEnd : '', simulatedAu = ['pgi', 'transport'].includes(group) ? originalAu : finish(r);
    const originalLead = leadDays(u.d);
    const originalArrival = group === 'pgi' ? valid(r.arrive) ? r.arrive : '' : group === 'transport' ? (originalLead == null ? '' : plus(today, originalLead)) : originalAu && originalLead != null ? plus(originalAu, originalLead) : '';
    const baselineArrival = group === 'pgi' ? valid(r.since) && u.s.leadDays != null ? plus(r.since, Math.max(0, u.s.leadDays - 3)) : originalArrival : group === 'transport' ? (u.s.leadDays == null ? '' : plus(today, u.s.leadDays)) : simulatedAu && u.s.leadDays != null ? plus(simulatedAu, u.s.leadDays) : '';
    const a = { kind: 'stock', chassis: id(r.chassis), model: r.model || '', modelYear: r.modelYear || '', range: r.range || (key(r.model).match(/^[A-Z]+/) || [''])[0], group, phase: stage[group] || group,
      from: r.slug, to: '', originalDealer: u.d.name, proposedDealer: '', originalAu, simulatedAu, plannedAu: simulatedAu, originalArrival, baselineArrival,
      plannedArrival: '', depart: '', action: 'keep', reason: '', policy: modelPolicy(r.model, r.modelYear, displayModels, notOnYardModels),
      receive: false, delayed: false, reallocated: false, delayDays: 0, arrivalDelayDays: null, virtualDate: simulatedAu !== originalAu, limitConflict: false, coverageAdded: false };
    a.cancellationProtected = protectChassis(a.chassis);
    actions.push(a); return a;
  }
  const scheduled = [], fixed = [];
  for (const v of vehicles.filter(v => v.where === 'transit')) fixed.push(record(v, v.via === 'transport' ? 'transport' : 'pgi'));
  for (const r of source) {
    const a = record(r);
    if (['customers', 'processing', 'later'].includes(r.group)) { a.action = 'pool'; a.reason = 'pool'; continue; }
    if (adjustable.has(r.group)) scheduled.push(a); else fixed.push(a);
  }
  function reserveBaseline(a) {
    if (!a.baselineArrival || a.baselineArrival > end) return;
    units.get(a.from).beforeEvents[Math.max(0, at(a.baselineArrival))]++;
  }
  if (auProduction) {
    const locked = scheduled.filter(a => a.group === 'locked').sort((a, b) => (a.simulatedAu || '9999').localeCompare(b.simulatedAu || '9999') || a.chassis.localeCompare(b.chassis));
    locked.forEach((a, i) => { const d = auProduction.slots[i], lead = units.get(a.from).s.leadDays; a.baselineArrival = d && lead != null ? plus(d, lead) : ''; });
  }
  for (const a of [...scheduled, ...fixed]) reserveBaseline(a);
  for (const a of fixed) {
    const u = units.get(a.from);
    if (!a.baselineArrival || a.baselineArrival > end) { a.action = 'pending'; a.reason = 'date'; u.undated++; continue; }
    Object.assign(a, { to: a.from, proposedDealer: a.originalDealer, plannedArrival: a.baselineArrival < today ? today : a.baselineArrival, receive: true, reason: 'fixed' });
    event(u, a.plannedArrival, a.model); cover(u, a, 'incoming');
  }
  for (const u of units.values()) { refresh(u); u.before = curve(u, u.beforeEvents); }
  function projectedModel(u, model, t) {
    const m = key(model), cacheKey = `${m}:${t}`;
    u.modelCache ||= new Map(); if (u.modelCache.has(cacheKey)) return u.modelCache.get(cacheKey);
    const ev = u.models.get(m);
    let stock = u.initialModels.get(m) || 0;
    const shares = u.d.handover?.stockByModel || {}, total = Object.values(shares).reduce((n, v) => n + Math.max(0, Number(v) || 0), 0);
    const share = total ? (shares[m] || 0) / total : 1 / Math.max(1, u.s.models.length);
    for (let i = 0; i <= t; i++) stock = Math.max(0, stock + (ev?.[i] || 0) - u.s.weeklyStock / 7 * share);
    u.modelCache.set(cacheKey, stock); return stock;
  }
  const readyOrder = (a, b) => (a.simulatedAu || '9999').localeCompare(b.simulatedAu || '9999') || (rank[a.group] - rank[b.group]) || a.chassis.localeCompare(b.chassis);
  function choicesFor(a, day, routeCache = new Map()) {
    const original = units.get(a.from), choices = [];
    for (const u of units.values()) {
      if (!u.s.receiving || u.s.ideal == null || u.s.leadDays == null || u.s.cap == null || u.undated) continue;
      if (!u.s.models.includes(key(a.model)) && u !== original) continue;
      if (a.policy === 'display' && !u.s.models.includes(key(a.model))) continue;
      const arrival = plus(day, u.s.leadDays), t = Math.max(0, at(arrival)); if (t >= N) continue;
      const cacheKey = `${u.s.slug}:${day}`;
      let route = routeCache.get(cacheKey);
      if (!route) {
        const last = monthEnd(t);
        let peak = 0, missed = 0, net = u.balance[t];
        for (let n = t; n < N; n++) { missed += u.missed[n]; peak = Math.max(peak, u.balance[n] + Math.max(0, 1 - missed)); }
        for (let n = t + 1; n <= last; n++) net += u.events[n] - u.s.weeklyStock / 7;
        route = { u, t, last, arrival: arrival < today ? today : arrival, over: Math.max(0, peak - u.s.cap), ratio: u.balance[last] / u.s.ideal, deficit: net / u.s.ideal, fair: u.assigned / u.s.ideal };
        routeCache.set(cacheKey, route);
      }
      choices.push({ ...route, a, missing: year2027(a) && u.s.models.includes(key(a.model)) && !u.coverage.has(key(a.model)), original: u === original });
    }
    return choices;
  }
  const compare = (a, b, preferOwn = false) => Number(a.over > 1e-8) - Number(b.over > 1e-8) || Number(b.missing) - Number(a.missing)
    || (a.over > 1e-8 ? a.over / a.u.s.ideal - b.over / b.u.s.ideal : 0) || a.ratio - b.ratio || a.deficit - b.deficit
    || (preferOwn ? Number(b.original) - Number(a.original) : 0)
    || Number(b.a.policy === 'display' && projectedModel(b.u, b.a.model, b.last) < 1) - Number(a.a.policy === 'display' && projectedModel(a.u, a.a.model, a.last) < 1)
    || a.fair - b.fair || Number(b.original) - Number(a.original) || a.u.s.slug.localeCompare(b.u.s.slug)
    || Number(a.a.group !== 'locked') - Number(b.a.group !== 'locked') || readyOrder(a.a, b.a);
  function allocate(a, best, day, slot = false) {
    const { u, arrival, missing, over } = best;
    const movedDate = day !== a.originalAu;
    Object.assign(a, { to: u.s.slug, proposedDealer: u.d.name, simulatedAu: day, plannedAu: day, plannedArrival: arrival, receive: true,
      reallocated: !best.original, action: !best.original ? 'reallocate' : slot && a.group === 'customers' ? 'schedule' : slot && movedDate ? 'reschedule' : 'keep',
      coverageAdded: missing, limitConflict: over > 1e-8, reason: over > 1e-8 ? 'ceiling' : missing ? 'coverage' : slot && best.original ? 'ownOrderSlot' : 'balance',
      virtualDate: movedDate, scheduleChanged: slot && (a.group === 'customers' || movedDate), slotScheduled: slot, plannedGroup: slot ? 'locked' : a.group,
      arrivalDelayDays: a.originalArrival ? Math.round((stamp(arrival) - stamp(a.originalArrival)) / MS) : null });
    event(u, arrival, a.model); cover(u, a, 'allocated'); u.assigned++; refresh(u);
  }
  const canCancel = a => a.group === 'locked' && !a.cancellationProtected && ['notOnYard', 'deleted'].includes(a.policy);
  for (const a of scheduled.filter(canCancel)) { a.action = 'cancel'; a.reason = a.policy; a.plannedAu = ''; }
  const flexible = auProduction ? scheduled.filter(a => a.group === 'locked' && a.action !== 'cancel') : [];
  // Physical stages cannot exchange a production slot. Their supply is reserved first.
  for (const a of scheduled.filter(a => a.action !== 'cancel' && (!auProduction || a.group !== 'locked')).sort(readyOrder)) {
    const original = units.get(a.from);
    if (!a.simulatedAu || a.simulatedAu > maxEnd) { a.action = 'pending'; a.reason = a.simulatedAu ? 'horizon' : 'date'; original.undated++; continue; }
    const best = choicesFor(a, a.simulatedAu).sort((a, b) => compare(a, b))[0];
    if (!best) {
      a.reason = 'settings'; a.action = 'pending'; original.undated++;
      if (a.baselineArrival && a.baselineArrival <= end) { Object.assign(a, { to: a.from, proposedDealer: a.originalDealer, plannedArrival: a.baselineArrival < today ? today : a.baselineArrival, receive: true }); event(original, a.plannedArrival, a.model); cover(original, a, 'incoming'); refresh(original); }
    } else allocate(a, best, a.simulatedAu);
  }
  if (auProduction) {
    const sourceById = new Map(source.map(r => [r.chassis, r]));
    const pool = actions.filter(a => a.group === 'customers' && sourceById.get(a.chassis)?.signedAt && (!['notOnYard', 'deleted'].includes(a.policy) || a.cancellationProtected));
    const candidates = new Set([...flexible, ...(assumptions.exchangeSlots ? pool : [])]);
    // Swap the existing locked Stock places; leave later AU capacity available
    // to the separate rolling planner and its named customer / Stock mix.
    const slots = auProduction.slots.slice(0, flexible.length);
    for (const day of slots) {
      if (!candidates.size) break;
      const cache = new Map(), buckets = new Map();
      for (const a of candidates) {
        // Exact vehicle dates are a not-before constraint for pool admission.
        const notBefore = assumptions.finishDates[a.chassis];
        if (notBefore && day < notBefore) continue;
        const k = `${a.modelYear}:${key(a.model)}:${a.from}`;
        const old = buckets.get(k);
        if (!old || readyOrder(a, old) < 0) buckets.set(k, a);
      }
      let best;
      for (const a of buckets.values()) for (const choice of choicesFor(a, day, cache)) if (!best || compare(choice, best, true) < 0) best = choice;
      if (!best) continue;
      candidates.delete(best.a); allocate(best.a, best, day, true);
    }
    for (const a of flexible.filter(a => !a.slotScheduled)) Object.assign(a, { action: 'pool', reason: 'slotReplacement', slotReleased: true, plannedGroup: 'customers', simulatedAu: '', plannedAu: '', plannedArrival: '', to: '', receive: false });
    for (const m of auProduction.months) {
      m.plannedStock = actions.filter(a => a.slotScheduled && a.plannedAu.startsWith(m.month)).length;
      m.unfilled = auProduction.slots.filter(d => d.startsWith(m.month)).length - m.plannedStock;
    }
  }
  const monthKeys = Array.from({ length: months }, (_, n) => addCalendarMonth(firstMonth, n).slice(0, 7));
  const summary = list => ({ canceled: list.filter(a => a.action === 'cancel').length, lockedCanceled: list.filter(a => a.action === 'cancel' && a.group === 'locked').length,
    rollingCanceled: 0, delayed: 0, cnDelayed: 0, cnCompletionDelayed: 0, poolNotBuilt: list.filter(a => a.action === 'pool').length,
    reallocated: list.filter(a => a.reallocated).length, reallocatedByMY: reallocationYears(list), scheduledFromPool: list.filter(a => a.slotScheduled && a.group === 'customers').length, returnedToPool: list.filter(a => a.slotReleased).length, rescheduled: list.filter(a => a.scheduleChanged).length, protected: list.filter(a => a.cancellationProtected).length, pending: list.filter(a => a.action === 'pending').length, changes: list.filter(a => ['cancel', 'reallocate', 'schedule', 'reschedule'].includes(a.action) || a.slotReleased).length,
    allocated: list.filter(a => a.receive).length, coverageAdded: list.filter(a => a.coverageAdded).length, limitConflicts: list.filter(a => a.limitConflict).length });
  function section(group) {
    const all = [...units.values()].filter(u => dealerGroup(u.d) === group), slugs = new Set(all.map(u => u.s.slug)), list = actions.filter(a => slugs.has(a.from));
    return { actions: list, summary: summary(list), dealers: all.map(u => {
      const s = u.s, monthly = monthKeys.map(month => {
        const ids = dates.flatMap((d, t) => d.startsWith(month) ? [t] : []), last = ids.at(-1), sum = series => round(ids.reduce((n, t) => n + series[t], 0));
        const arrivals = actions.filter(a => a.receive && a.to === s.slug && a.plannedArrival.startsWith(month)).map(a => ({ chassis: a.chassis, model: a.model, group: a.group, auEnd: a.plannedAu, arrival: a.plannedArrival, action: a.action }));
        return { month, arrivals, stockIn: sum(u.events), stockOut: sum(u.sold), plannedSales: round(ids.length * s.weeklyStock / 7), unmet: sum(u.missed), endStock: round(u.balance[last]),
          baselineEndStock: round(u.before.balance[last]), baselineIn: sum(u.beforeEvents), idealMultiple: s.ideal == null ? null : round(u.balance[last] / s.ideal), transferOut: 0 };
      });
      const { vehicles: ignored, ...rest } = u.d;
      const coverageModels = s.models.filter(m => u.coverage.has(m)), missingModels = s.models.filter(m => !u.coverage.has(m));
      return { ...rest, ...dealerStockMetrics(s.slug, actions), target: s.ideal, cap: s.cap, lead: s.leadDays, paused: false, stopReceiving: !s.receiving,
        yard: { ...u.d.yard, stock: s.currentStock }, transit: { ...u.d.transit, stock: fixed.filter(a => a.from === s.slug && ['pgi', 'transport'].includes(a.group)).length }, actualYardStock: u.d.yard.stock, weeklyStock: s.weeklyStock, assumptions: s,
        settingsNeeded: s.ideal == null || s.leadDays == null || s.cap == null, undatedIncoming: u.undated, unknownYardModels: u.unknownYard,
        my2027Yard: u.keptYard.filter(year2027).map(v => ({ chassis: id(v.chassis), model: v.model })),
        monthly, stats: summary(list.filter(a => a.from === s.slug)), need: s.ideal == null ? null : Math.max(0, Math.ceil(s.ideal - monthly.at(-1).endStock)),
        coverage: { target: s.models.length, covered: coverageModels.length, models: coverageModels, missing: missingModels, details: u.coverageDetails },
        overCapMonths: s.cap == null ? 0 : monthly.filter(m => m.endStock > s.cap).length, shortageMonths: monthly.filter(m => m.unmet > 0).length };
    }) };
  }
  const result = { auProduction, engine: SIMULATOR_VERSION, today, multiplier, months, planningEnd: end, maxDelayMonths: 0, assumptions, defaults: normalized.defaults,
    startLocked: actions.filter(a => a.group === 'locked').map(a => a.simulatedAu).filter(Boolean).sort()[0] || '',
    displayModels, notOnYardModels, own: section('own'), jv: section('jv'), independent: section('independent'), totals: summary(actions), warnings,
    finishRows: source.filter(r => adjustable.has(r.group) || ['rolling', 'customers'].includes(r.group)).map(r => ({ chassis: r.chassis, model: r.model, modelYear: r.modelYear, dealer: r.dealer, group: r.group, originalAu: valid(r.auEnd) ? r.auEnd : '', simulatedAu: actions.find(a => a.chassis === r.chassis)?.simulatedAu ?? finish(r) })).sort((a, b) => (a.simulatedAu || '9999').localeCompare(b.simulatedAu || '9999') || a.chassis.localeCompare(b.chassis)) };
  const allDealers = groups.flatMap(g => result[g].dealers);
  result.coverage = { target: allDealers.reduce((n, d) => n + d.coverage.target, 0), covered: allDealers.reduce((n, d) => n + d.coverage.covered, 0), missing: allDealers.reduce((n, d) => n + d.coverage.missing.length, 0) };
  return result;
}
