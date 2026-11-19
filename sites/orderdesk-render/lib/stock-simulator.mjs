import { customerCandidates } from './weekly-customer-plan.mjs';
import { inventoryRoutePeaks } from './inventory-route-peaks.mjs';
// A deterministic, read-only simulation. Existing snapshots/legacy calculations remain readable.
import { isCancellationProtected } from './protected-stock.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { stockProductionPlan } from './stock-production-plan.mjs';
import { dealerStockMetrics, reallocationYears, isSRH2026 } from './stock-simulation-metrics.mjs';
import { excludedPlanningDealer, dealerGroup, dealerSlug, leadDays, isStockCustomer } from './dealership.mjs';
import { DISPLAY_MODELS, NOT_ON_YARD, isTowable, modelPolicy, addCalendarMonth, forecastMultiplier, validateDisplayModels } from './stock-forecast.mjs';

export const SIMULATOR_VERSION = 'dealer-balance-v3.2-required-transfers';
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
  return { assumptions: { dealers: normalized.sort((a, b) => a.slug.localeCompare(b.slug)), shiftDays, finishDates: dates, auMonthlyProduction: value.auMonthlyProduction ?? {}, exchangeSlots: value.exchangeSlots ?? true, customerPercent: number(value.customerPercent ?? 35, 'customer percentage', { max: 100 }) }, defaults };
}

export function buildStockSimulation({ dealers, rows = [], today, multiplier = 1.3, months = 8, assumptions = {}, displayModels = DISPLAY_MODELS, notOnYardModels = NOT_ON_YARD, capacity = null, settings = {}, protectChassis = isCancellationProtected }) {
  dealers = dealers?.filter(d => !excludedPlanningDealer(d));
  if (assumptions && typeof assumptions === 'object' && !Array.isArray(assumptions)) {
    const omitted = new Set(rows.filter(r => excludedPlanningDealer(r.dealer)).map(r => id(r.chassis)));
    assumptions = { ...assumptions, ...(Array.isArray(assumptions.dealers) ? { dealers: assumptions.dealers.filter(d => !excludedPlanningDealer(d.slug)) } : {}), ...(assumptions.finishDates ? { finishDates: Object.fromEntries(Object.entries(assumptions.finishDates).filter(([c]) => !omitted.has(id(c)))) } : {}) };
  }
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
    if (excludedPlanningDealer(r.dealer) || r.empty || !id(r.chassis) || !(r.group in rank) || !isTowable(r) || !isStockCustomer(r.customer)) continue;
    if (seen.has(id(r.chassis))) { warnings.push({ code: 'duplicate', chassis: id(r.chassis) }); continue; }
    seen.add(id(r.chassis));
    const slug = dealerSlug(dealers, r.dealer);
    if (!bySlug.has(slug)) { warnings.push({ code: 'dealer', chassis: id(r.chassis), dealer: r.dealer }); continue; }
    source.push({ ...r, slug, chassis: id(r.chassis) });
  }
  const customerOrders = customerCandidates({ rows, dealers, today, settings });
  const auProduction = stockProductionPlan({ customers: customerOrders, customerPercent: assumptions.customerPercent, capacity, rows, today, monthly: assumptions.auMonthlyProduction, shiftDays: assumptions.shiftDays, finishDates: assumptions.finishDates, managedLocked: new Set(source.filter(r => r.group === 'locked').map(r => r.chassis)) });
  if (auProduction) assumptions.auMonthlyProduction = auProduction.overrides;
  const firstMonth = `${today.slice(0, 7)}-01`, maxEnd = addCalendarMonth(today, 36);
  const finish = r => assumptions.finishDates[id(r.chassis)] || (valid(r.auEnd) ? plus(r.auEnd, assumptions.shiftDays) : '');
  let end = plus(addCalendarMonth(firstMonth, 14), -1);
  for (const r of source) { const d = finish(r); if (d && d <= maxEnd) end = [end, plus(addCalendarMonth(d), 365)].sort().at(-1); }
  if (auProduction?.daily.length) end = [end, plus(addCalendarMonth(auProduction.daily.at(-1)[0]), 365)].sort().at(-1);
  if (end > maxEnd) end = maxEnd;
  const startStamp = stamp(today), N = Math.round((stamp(end) - startStamp) / MS) + 1, at = d => Math.round((stamp(d) - startStamp) / MS);
  const dates = Array.from({ length: N }, (_, i) => plus(today, i));
  const monthEnds = new Map();
  const monthEnd = t => { if (!monthEnds.has(t)) monthEnds.set(t, Math.min(N - 1, at(plus(addCalendarMonth(`${dates[t].slice(0, 7)}-01`), -1)))); return monthEnds.get(t); };
  const units = new Map(assumptions.dealers.map(s => [s.slug, { d: bySlug.get(s.slug), s, events: new Float64Array(N), beforeEvents: new Float64Array(N), models: new Map(), initialModels: new Map(), coverage: new Set(), coverageDetails: [], assigned: 0, unknownYard: 0, undated: 0 }]));
  function curve(u, events) {
    const balance = new Float64Array(N), sold = new Float64Array(N), missed = new Float64Array(N);
    let stock = u.s.currentStock;
    for (let t = 0; t < N; t++) { const available = Math.max(0, stock + events[t]), demand = u.s.weeklyStock / 7; sold[t] = Math.min(available, demand); missed[t] = demand - sold[t]; balance[t] = stock = available - sold[t]; }
    return { balance, sold, missed };
  }
  const refresh = u => { Object.assign(u, curve(u, u.events)); u.routes = inventoryRoutePeaks(u.balance, u.missed, u.s.cap ?? Infinity); };
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
    a.srh2026 = isSRH2026(a);
    a.cancellationProtected = protectChassis(a.chassis) || a.srh2026;
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
  const physicalReservations = new Map();
  for (const a of scheduled.filter(a => ['au', 'sea', 'cn'].includes(a.group) || !auProduction && a.group === 'locked')) {
    const u = units.get(a.from), arrival = a.simulatedAu && u.s.leadDays != null ? plus(a.simulatedAu, u.s.leadDays) : '';
    if (arrival && arrival <= end) {
      const day = arrival < today ? today : arrival;
      Object.assign(a, { to: a.from, proposedDealer: a.originalDealer, plannedArrival: day, receive: true });
      event(u, day, a.model); physicalReservations.set(a.chassis, day);
    }
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
  function choicesFor(a, day, routeCache = new Map(), onlyOriginal = false, committedOriginal = false) {
    const original = units.get(a.from), choices = [], model = key(a.model);
    for (const u of a.srh2026 || onlyOriginal ? [original] : units.values()) {
      const committed = committedOriginal && u === original;
      if (u.s.leadDays == null || u.s.cap == null || !committed && (!u.s.receiving || u.s.ideal == null || u.undated)) continue;
      if (!u.s.models.includes(model) && u !== original) continue;
      if (!committed && a.policy === 'display' && !u.s.models.includes(model)) continue;
      const cacheKey = `${u.s.slug}:${day}`;
      let route = routeCache.get(cacheKey);
      if (!route) {
        const arrival = plus(day, u.s.leadDays), t = Math.max(0, at(arrival)); if (t >= N) continue;
        const last = monthEnd(t);
        let net = u.balance[t];
        for (let n = t + 1; n <= last; n++) net += u.events[n] - u.s.weeklyStock / 7;
        route = { u, t, last, arrival: arrival < today ? today : arrival, over: committed ? u.routes.ownOver[t] : u.routes.over[t], ratio: u.balance[last] / u.s.ideal, deficit: net / u.s.ideal, fair: u.assigned / u.s.ideal };
        routeCache.set(cacheKey, route);
      }
      choices.push({ ...route, a, missing: year2027(a) && u.s.models.includes(model) && !modelCount(u.s.slug, model, a.chassis), original: u === original });
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
      virtualDate: movedDate, scheduleChanged: slot && (a.group === 'customers' || movedDate), slotScheduled: slot, slotReleased: false, plannedGroup: slot ? 'locked' : a.group,
      arrivalDelayDays: a.originalArrival ? Math.round((stamp(arrival) - stamp(a.originalArrival)) / MS) : null });
    invalidateModelCounts(); event(u, arrival, a.model); cover(u, a, 'allocated'); u.assigned++; refresh(u);
  }
  const canCancel = a => a.group === 'locked' && !a.cancellationProtected && ['notOnYard', 'deleted'].includes(a.policy);
  for (const a of scheduled.filter(canCancel)) {
    const reserved = physicalReservations.get(a.chassis); if (reserved) { const u = units.get(a.from); event(u, reserved, a.model, -1); refresh(u); }
    a.action = 'cancel'; a.reason = a.policy; a.plannedAu = ''; a.receive = false; a.to = ''; a.plannedArrival = '';
  }
  const flexible = auProduction ? scheduled.filter(a => a.group === 'locked' && a.action !== 'cancel') : [];
  const sourceByChassis = new Map(source.map(r => [r.chassis, r]));
  const modelCountCache = new Map(), actionByChassis = new Map(actions.map(a => [a.chassis, a]));
  let modelCountsReady = false;
  function invalidateModelCounts() { modelCountCache.clear(); modelCountsReady = false; }
  const modelCount = (slug, model, excluding = '') => {
    const normalizedModel = key(model), cacheKey = `${slug}:${normalizedModel}`;
    if (!modelCountsReady) {
      const add = (slug, model) => { const k = `${slug}:${key(model)}`; modelCountCache.set(k, (modelCountCache.get(k) || 0) + 1); };
      for (const u of units.values()) for (const v of u.keptYard) if (year2027(v)) add(u.s.slug, v.model);
      for (const a of actions) if (a.receive && a.to && a.action !== 'cancel' && year2027(a)) add(a.to, a.model);
      modelCountsReady = true;
    }
    const a = actionByChassis.get(excluding), own = a?.receive && a.to === slug && a.action !== 'cancel' && year2027(a) && key(a.model) === normalizedModel ? 1 : 0;
    // Physical yard chassis and action chassis were deduplicated before planning.
    return (modelCountCache.get(cacheKey) || 0) - own;
  };
  const eligibleOwnOrder = a => a.action !== 'cancel' && ['locked', 'customers'].includes(a.group) && (!['notOnYard', 'deleted'].includes(a.policy) || a.cancellationProtected)
    && (a.group === 'locked' && !a.slotReleased || signedPlansDate([sourceByChassis.get(a.chassis)?.signedAt], today));
  const ownModelSupply = (slug, model) => units.get(slug).keptYard.some(v => year2027(v) && key(v.model) === key(model))
    || actions.some(a => a.from === slug && year2027(a) && key(a.model) === key(model) && (a.receive && a.to === slug || eligibleOwnOrder(a)));
  const audit = (a, reason, checkedDates = 1) => ({ required: true, reason, checkedDates, dateEditable: a.group === 'locked' || a.group === 'customers', ownOrderChecked: true, balanceOnly: false });
  let avoidedTransfers = 0, ownOrderReplacements = 0;
  // Fixed production dates can require a transfer for genuine marginal ceiling
  // pressure. A stock/Ideal score alone never changes dealer ownership.
  for (const a of scheduled.filter(a => a.action !== 'cancel' && (!auProduction || a.group !== 'locked')).sort(readyOrder)) {
    invalidateModelCounts();
    const original = units.get(a.from), reserved = physicalReservations.get(a.chassis);
    if (reserved) { event(original, reserved, a.model, -1); refresh(original); }
    if (!a.simulatedAu || a.simulatedAu > maxEnd) { a.receive = false; a.to = ''; a.action = 'pending'; a.reason = a.simulatedAu ? 'horizon' : 'date'; original.undated++; continue; }
    const choices = choicesFor(a, a.simulatedAu, new Map(), false, true), own = choices.find(c => c.original);
    let best = own;
    const arrival = original.s.leadDays == null ? '' : plus(a.simulatedAu, original.s.leadDays), t = arrival ? Math.max(0, at(arrival)) : N;
    const pressure = t < N && original.s.cap != null && original.routes.ownOver[t] > 1e-8;
    const keepsModel = !year2027(a) || !original.s.models.includes(key(a.model)) || modelCount(a.from, a.model, a.chassis) > 0;
    if (['au', 'sea', 'cn'].includes(a.group) && pressure && keepsModel && !a.srh2026) {
      const target = choices.filter(c => !c.original && c.over < 1e-8).sort((a, b) => compare(a, b))[0];
      if (target) { best = target; a.reallocationCheck = audit(a, 'fixedCeiling'); }
    }
    if (!best) {
      a.reason = 'settings'; a.action = 'pending'; a.receive = false; original.undated++;
      if (a.baselineArrival && a.baselineArrival <= end) { Object.assign(a, { to: a.from, proposedDealer: a.originalDealer, plannedArrival: a.baselineArrival < today ? today : a.baselineArrival, receive: true }); event(original, a.plannedArrival, a.model); refresh(original); }
    } else allocate(a, best, a.simulatedAu);
  }
  if (auProduction) {
    const sourceById = new Map(source.map(r => [r.chassis, r]));
    const pool = actions.filter(a => a.group === 'customers' && signedPlansDate([sourceById.get(a.chassis)?.signedAt], today) && (!['notOnYard', 'deleted'].includes(a.policy) || a.cancellationProtected));
    const candidates = new Set([...flexible, ...(assumptions.exchangeSlots ? pool : [])]);
    // Swap the existing locked Stock places; leave later AU capacity available
    // to the separate rolling planner and its named customer / Stock mix.
    const slots = auProduction.slots;
    let booked = 0;
    for (const [slotIndex, day] of slots.entries()) {
      if (!candidates.size || booked >= flexible.length) break;
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
      for (const a of buckets.values()) for (const choice of choicesFor(a, day, cache, true).filter(c => c.over < 1e-8)) if (!best || compare(choice, best, true) < 0) best = choice;
      if (!best) continue;
      candidates.delete(best.a); allocate(best.a, best, day, true); best.a.slotOrder = auProduction.customerPlan.stockPlaces[slotIndex]?.slotOrder; booked++;
    }
    for (const a of flexible.filter(a => !a.slotScheduled)) Object.assign(a, { action: 'pool', reason: 'slotReplacement', slotReleased: true, plannedGroup: 'customers', simulatedAu: '', plannedAu: '', plannedArrival: '', to: '', receive: false });
    for (const m of auProduction.months) {
      m.plannedStock = actions.filter(a => a.slotScheduled && a.plannedAu.startsWith(m.month)).length;
      m.unfilled = auProduction.slots.filter(d => d.startsWith(m.month)).length - m.plannedStock;
    }
  }
  const rebuildCoverage = () => {
    for (const u of units.values()) { u.coverage.clear(); u.coverageDetails.length = 0; for (const v of u.keptYard) cover(u, v, 'yard'); }
    for (const a of [...actions].filter(a => a.receive && a.to && a.action !== 'cancel').sort((a, b) => (a.plannedArrival || '').localeCompare(b.plannedArrival || '') || a.chassis.localeCompare(b.chassis))) {
      const u = units.get(a.to); a.coverageAdded = year2027(a) && u.s.models.includes(key(a.model)) && !u.coverage.has(key(a.model)); cover(u, a, 'allocated');
    }
  };
  const openPlaces = donor => {
    if (!auProduction) return donor?.plannedAu ? [{ day: donor.plannedAu, slotOrder: donor.slotOrder }] : [];
    const used = new Set(actions.filter(a => a.receive && a.slotScheduled && a !== donor).map(a => a.slotOrder));
    return auProduction.customerPlan.stockPlaces.filter(p => !used.has(p.slotOrder));
  };
  const release = a => { Object.assign(a, { action: 'pool', reason: 'slotReplacement', reallocated: false, slotScheduled: false, slotReleased: true, plannedGroup: 'customers', simulatedAu: '', plannedAu: '', plannedArrival: '', to: '', proposedDealer: '', receive: false, limitConflict: false }); invalidateModelCounts(); delete a.reallocationCheck; return a; };
  // A later own-dealer order can replace an already selected surplus order.
  // Search all remaining Stock dates before considering a model transfer.
  function repairOwnModel(u, model) {
    if (!auProduction || !u.s.receiving || u.s.leadDays == null || u.s.cap == null || u.s.ideal == null || u.undated) return false;
    const candidates = actions.filter(a => !a.receive && a.from === u.s.slug && year2027(a) && key(a.model) === model && eligibleOwnOrder(a) && (assumptions.exchangeSlots || a.group === 'locked'));
    const donors = actions.filter(a => a.receive && a.slotScheduled && (!year2027(a) || !units.get(a.to).s.models.includes(key(a.model)) || modelCount(a.to, a.model, a.chassis) > 0));
    // Removing another dealer's surplus does not alter this receiver's curve.
    // Reuse its date routes across donors rather than replaying the full
    // inventory horizon once per donor and per vehicle.
    const unchangedOwnerRoutes = new Map();
    for (const candidate of candidates) for (const donor of donors) {
      const owner = units.get(donor.to), oldArrival = donor.plannedArrival;
      event(owner, oldArrival, donor.model, -1); refresh(owner);
      const routes = owner === u ? new Map() : unchangedOwnerRoutes;
      let found;
      for (const place of openPlaces(donor)) {
        if (assumptions.finishDates[candidate.chassis] && place.day < assumptions.finishDates[candidate.chassis]) continue;
        const route = choicesFor(candidate, place.day, routes, true).find(c => c.over < 1e-8);
        if (route) { found = { place, route }; break; }
      }
      if (!found) { event(owner, oldArrival, donor.model); refresh(owner); continue; }
      owner.assigned = Math.max(0, owner.assigned - 1); release(donor);
      allocate(candidate, found.route, found.place.day, true); candidate.slotOrder = found.place.slotOrder; candidate.reason = 'ownOrderSlot'; ownOrderReplacements++;
      return true;
    }
    return false;
  }
  rebuildCoverage();
  for (const u of units.values()) for (const model of u.s.models) if (!modelCount(u.s.slug, model)) repairOwnModel(u, model);
  // A remaining MY2027 coverage gap can require one cross-dealer unit only
  // when the recipient has no eligible own model order anywhere in the horizon
  // and the sender retains another confirmed unit of that model.
  for (const u of units.values()) for (const model of u.s.models) {
    if (modelCount(u.s.slug, model) || ownModelSupply(u.s.slug, model)) continue;
    const donors = actions.filter(a => a.receive && !a.reallocated && !a.srh2026 && a.to !== u.s.slug && year2027(a) && key(a.model) === model
      && (['au', 'sea', 'cn'].includes(a.group) || a.slotScheduled || !auProduction && a.group === 'locked') && modelCount(a.to, a.model, a.chassis) > 0);
    for (const a of donors) {
      const original = units.get(a.to), oldArrival = a.plannedArrival;
      event(original, oldArrival, a.model, -1); refresh(original);
      const editable = a.slotScheduled, places = editable ? [{ day: a.plannedAu, slotOrder: a.slotOrder }, ...openPlaces(a)] : [{ day: a.plannedAu, slotOrder: a.slotOrder }];
      let found, checkedDates = 0;
      for (const place of places) {
        if (!place.day || assumptions.finishDates[a.chassis] && place.day < assumptions.finishDates[a.chassis]) continue;
        checkedDates++;
        const route = choicesFor(a, place.day).find(c => c.u === u && c.over < 1e-8);
        if (route) { found = { place, route }; break; }
      }
      if (!found) { event(original, oldArrival, a.model); refresh(original); continue; }
      original.assigned = Math.max(0, original.assigned - 1); allocate(a, found.route, found.place.day, editable); a.slotOrder = found.place.slotOrder;
      a.reallocationCheck = audit(a, 'modelNoOwnOrder', checkedDates); a.reason = 'coverage'; break;
    }
  }
  // Re-test ownership after all replacements. Restore any transfer whose own
  // route now fits and whose receiving model can be retained or supplied locally.
  for (let reviewPass = 0; reviewPass <= actions.length; reviewPass++) {
    const previousChanges = avoidedTransfers + ownOrderReplacements;
    for (let pass = 0; pass < actions.length; pass++) {
      let restored = false;
      for (const a of actions.filter(a => a.reallocated)) {
        const target = units.get(a.to), canRestoreCoverage = !year2027(a) || !target.s.models.includes(key(a.model)) || modelCount(a.to, a.model, a.chassis) > 0 || ownModelSupply(a.to, a.model);
        if (!canRestoreCoverage) { a.reallocationCheck = audit(a, 'modelNoOwnOrder', a.reallocationCheck?.checkedDates || 1); continue; }
        const oldArrival = a.plannedArrival; event(target, oldArrival, a.model, -1); refresh(target);
        const own = choicesFor(a, a.plannedAu, new Map(), true, true).find(c => c.over < 1e-8);
        if (!own) {
          const original = units.get(a.from);
          const movable = actions.filter(b => b !== a && b.receive && b.slotScheduled && b.to === a.from);
          const snapshots = movable.map(b => ({ b, day: b.plannedAu, arrival: b.plannedArrival, slotOrder: b.slotOrder }));
          for (const item of snapshots) event(original, item.arrival, item.b.model, -1);
          refresh(original);
          const fixedOnly = choicesFor(a, a.plannedAu, new Map(), true, true).find(c => c.over < 1e-8);
          if (!fixedOnly) {
            for (const item of snapshots) event(original, item.arrival, item.b.model);
            refresh(original); event(target, oldArrival, a.model); refresh(target); continue;
          }
          // Fixed supply fits at home: move its editable Stock around it. Any
          // order that cannot fit this horizon stays in the pool, never becomes
          // justification for an otherwise avoidable physical transfer.
          event(original, fixedOnly.arrival, a.model); refresh(original);
          const occupied = new Set(actions.filter(b => b.receive && b.slotScheduled && !movable.includes(b)).map(b => b.slotOrder));
          for (const item of snapshots.sort((x, y) => (assumptions.finishDates[x.b.chassis] || today).localeCompare(assumptions.finishDates[y.b.chassis] || today))) {
            let fit;
            for (const place of auProduction?.customerPlan.stockPlaces || [{ day: item.day, slotOrder: item.slotOrder }]) {
              if (occupied.has(place.slotOrder) || assumptions.finishDates[item.b.chassis] && place.day < assumptions.finishDates[item.b.chassis]) continue;
              const route = choicesFor(item.b, place.day).find(c => c.u === original && c.over < 1e-8);
              if (route) { fit = { place, route }; break; }
            }
            original.assigned = Math.max(0, original.assigned - 1);
            if (!fit) { release(item.b); continue; }
            allocate(item.b, fit.route, fit.place.day, true); item.b.slotOrder = fit.place.slotOrder; occupied.add(fit.place.slotOrder);
          }
          event(original, fixedOnly.arrival, a.model, -1); refresh(original);
          target.assigned = Math.max(0, target.assigned - 1); allocate(a, fixedOnly, a.plannedAu, a.slotScheduled); delete a.reallocationCheck; a.reason = 'ownOrderSlot'; avoidedTransfers++; restored = true; continue;
        }
        target.assigned = Math.max(0, target.assigned - 1); allocate(a, own, a.plannedAu, a.slotScheduled); delete a.reallocationCheck; a.reason = 'ownOrderSlot'; avoidedTransfers++; restored = true;
      }
      if (!restored) break;
    }
    for (const u of units.values()) for (const model of u.s.models) if (!modelCount(u.s.slug, model)) repairOwnModel(u, model);
    if (previousChanges === avoidedTransfers + ownOrderReplacements) break;
  }
  // Independently certify the final state, including changes made by the last
  // repair. A self-assigned reason is insufficient evidence for a transfer.
  for (const a of actions.filter(a => a.reallocated)) {
    const target = units.get(a.to), original = units.get(a.from);
    const keepsModel = !year2027(a) || !original.s.models.includes(key(a.model)) || modelCount(a.from, a.model, a.chassis) > 0;
    const missingOwnModel = year2027(a) && target.s.models.includes(key(a.model)) && !modelCount(a.to, a.model, a.chassis) && !ownModelSupply(a.to, a.model);
    if (a.srh2026 || !keepsModel) fail('Reallocation failed the final ownership check');
    if (missingOwnModel) { a.reallocationCheck = audit(a, 'modelNoOwnOrder', a.reallocationCheck?.checkedDates || 1); continue; }
    const movable = actions.filter(b => b !== a && b.receive && b.slotScheduled && b.to === a.from);
    for (const b of movable) event(original, b.plannedArrival, b.model, -1);
    refresh(original);
    const fitsAtHome = choicesFor(a, a.plannedAu, new Map(), true, true).some(c => c.over < 1e-8);
    for (const b of movable) event(original, b.plannedArrival, b.model);
    refresh(original);
    if (!['au', 'sea', 'cn'].includes(a.group) || fitsAtHome) fail('Avoidable Reallocation rejected by the final date and own-order check');
    a.reallocationCheck = audit(a, 'fixedCeiling');
  }
  rebuildCoverage();
  if (auProduction) for (const m of auProduction.months) { m.plannedStock = actions.filter(a => a.slotScheduled && a.receive && a.plannedAu.startsWith(m.month)).length; m.unfilled = auProduction.slots.filter(d => d.startsWith(m.month)).length - m.plannedStock; }
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
        const arrivals = actions.filter(a => a.receive && a.to === s.slug && a.plannedArrival.startsWith(month)).map(a => ({ chassis: a.chassis, model: a.model, group: a.group, modelYear: a.modelYear, srh2026: a.srh2026, auEnd: a.plannedAu, arrival: a.plannedArrival, action: a.action }));
        return { month, arrivals, stockIn: sum(u.events), stockOut: sum(u.sold), plannedSales: round(ids.length * s.weeklyStock / 7), unmet: sum(u.missed), endStock: round(u.balance[last]),
          baselineEndStock: round(u.before.balance[last]), baselineIn: sum(u.beforeEvents), idealMultiple: s.ideal == null ? null : round(u.balance[last] / s.ideal), transferOut: 0 };
      });
      const { vehicles: ignored, ...rest } = u.d;
      const coverageModels = s.models.filter(m => u.coverage.has(m)), missingModels = s.models.filter(m => !u.coverage.has(m));
      return { ...rest, srh2026Count: u.keptYard.filter(isSRH2026).length + actions.filter(a => isSRH2026(a) && a.action !== 'cancel' && (a.to || a.from) === s.slug).length, ...dealerStockMetrics(s.slug, actions), target: s.ideal, cap: s.cap, lead: s.leadDays, paused: false, stopReceiving: !s.receiving,
        yard: { ...u.d.yard, stock: s.currentStock }, transit: { ...u.d.transit, stock: fixed.filter(a => a.from === s.slug && ['pgi', 'transport'].includes(a.group)).length }, actualYardStock: u.d.yard.stock, weeklyStock: s.weeklyStock, assumptions: s,
        settingsNeeded: s.ideal == null || s.leadDays == null || s.cap == null, undatedIncoming: u.undated, unknownYardModels: u.unknownYard,
        srh2026Yard: u.keptYard.filter(isSRH2026).map(v => ({ chassis: id(v.chassis), model: v.model, modelYear: '2026', from: s.slug, to: s.slug, originalDealer: u.d.name, proposedDealer: u.d.name, group: 'yard' })),
        my2027Yard: u.keptYard.filter(year2027).map(v => ({ chassis: id(v.chassis), model: v.model })),
        monthly, stats: summary(list.filter(a => a.from === s.slug)), need: s.ideal == null ? null : Math.max(0, Math.ceil(s.ideal - monthly.at(-1).endStock)),
        coverage: { target: s.models.length, covered: coverageModels.length, models: coverageModels, missing: missingModels, details: u.coverageDetails },
        overCapMonths: s.cap == null ? 0 : monthly.filter(m => m.endStock > s.cap).length, shortageMonths: monthly.filter(m => m.unmet > 0).length };
    }) };
  }
  const result = { reallocationReview: { checked: actions.filter(a => a.reallocated).length, removed: avoidedTransfers, ownOrderReplacements, unverified: actions.filter(a => a.reallocated && !a.reallocationCheck?.required).length }, auProduction, engine: SIMULATOR_VERSION, today, multiplier, months, planningEnd: end, maxDelayMonths: 0, assumptions, defaults: normalized.defaults,
    startLocked: actions.filter(a => a.group === 'locked').map(a => a.simulatedAu).filter(Boolean).sort()[0] || '',
    displayModels, notOnYardModels, own: section('own'), jv: section('jv'), independent: section('independent'), totals: summary(actions), warnings,
    finishRows: source.filter(r => adjustable.has(r.group) || ['rolling', 'customers'].includes(r.group)).map(r => ({ chassis: r.chassis, model: r.model, modelYear: r.modelYear, dealer: r.dealer, group: r.group, originalAu: valid(r.auEnd) ? r.auEnd : '', simulatedAu: actions.find(a => a.chassis === r.chassis)?.simulatedAu ?? finish(r) })).sort((a, b) => (a.simulatedAu || '9999').localeCompare(b.simulatedAu || '9999') || a.chassis.localeCompare(b.chassis)) };
  const allDealers = groups.flatMap(g => result[g].dealers);
  result.coverage = { target: allDealers.reduce((n, d) => n + d.coverage.target, 0), covered: allDealers.reduce((n, d) => n + d.coverage.covered, 0), missing: allDealers.reduce((n, d) => n + d.coverage.missing.length, 0) };
  // Read-only continuation: consume actual spare AU places after the adjusted
  // locked boundary. Keep the original dealer for pool replenishment. This
  // preview is separate from the confirmed locked adjustment basis.
  const byAction = new Map(actions.map(a => [a.chassis, a]));
  const lockedDates = rows.filter(r => r.group === 'locked' && !r.empty && isTowable(r)).flatMap(r => {
    const a = byAction.get(id(r.chassis));
    if (!isStockCustomer(r.customer) && customerOrders.some(c => c.chassis === id(r.chassis))) return auProduction?.customerPlan.rows.filter(c => c.kind === 'customer' && c.group === 'locked' && c.chassis === id(r.chassis)).map(c => c.plannedAu) || [];
    return a ? (a.slotScheduled || !auProduction && a.receive) && a.plannedAu ? [a.plannedAu] : [] : r.auEnd ? [r.auEnd] : [];
  });
  for (const a of actions) if (a.slotScheduled && a.group === 'customers') lockedDates.push(a.plannedAu);
  const boundary = lockedDates.sort().at(-1) || auProduction?.start || today;
  const lockedRows = actions.filter(a => a.action !== 'cancel' && a.receive && (a.slotScheduled || !auProduction && a.group === 'locked'));
  const following = [];
  if (auProduction) {
    const duration = (k, fallback) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : fallback);
    const earliest = [boundary, plus(today, duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40))].sort().at(-1);
    const sourceById = new Map(source.map(r => [r.chassis, r]));
    const candidates = new Set(actions.filter(a => a.action === 'pool' && ['customers', 'locked'].includes(a.group)
      && signedPlansDate([sourceById.get(a.chassis)?.signedAt], today) && (a.policy === 'display' || a.cancellationProtected)));
    const used = new Map(); for (const a of lockedRows) used.set(a.plannedAu, (used.get(a.plannedAu) || 0) + 1);
    const slots = auProduction.slots.filter(day => { if (used.get(day)) { used.set(day, used.get(day) - 1); return false; } return day >= earliest; });
    const usedOrders = new Set(lockedRows.map(a => a.slotOrder));
    for (const day of slots) {
      if (!candidates.size) break;
      let best; const cache = new Map();
      for (const a of candidates) {
        if (assumptions.finishDates[a.chassis] && day < assumptions.finishDates[a.chassis]) continue;
        for (const c of choicesFor(a, day, cache, true).filter(c => c.over < 1e-8)) if (!best || compare(c, best, true) < 0) best = c;
      }
      if (!best) continue;
      const a = best.a, u = best.u;
      const place = auProduction.customerPlan.stockPlaces.find(p => p.day === day && !usedOrders.has(p.slotOrder));
      if (place) usedOrders.add(place.slotOrder);
      following.push({ ...a, slotOrder: place?.slotOrder, to: a.from, proposedDealer: a.originalDealer, plannedAu: day, simulatedAu: day,
        plannedArrival: best.arrival, receive: true, action: 'schedule', reallocated: false, plannedGroup: 'rolling', continuation: true });
      candidates.delete(a); event(u, best.arrival, a.model); u.assigned++;
      if (year2027(a)) { const model = key(a.model), count = modelCount(a.from, model); u.coverage.add(model); modelCountCache.set(`${a.from}:${model}`, count + 1); }
      refresh(u);
    }
  }
  const mixedCustomers = (auProduction?.customerPlan.rows || []).map(a => ({ ...a, schedulePart: a.plannedAu <= boundary || a.group === 'locked' ? 'locked' : 'following' }));
  const finalRows = [...mixedCustomers, ...lockedRows.map(a => ({ ...a, schedulePart: 'locked' })), ...following.map(a => ({ ...a, schedulePart: 'following' }))]
    .sort((a, b) => a.plannedAu.localeCompare(b.plannedAu) || (a.slotOrder ?? Infinity) - (b.slotOrder ?? Infinity) || a.chassis.localeCompare(b.chassis));
  const srh = [...actions.filter(a => isSRH2026(a) && a.action !== 'cancel'), ...allDealers.flatMap(d => d.srh2026Yard)];
  const scheduledIds = new Set(finalRows.map(a => a.chassis));
  result.finalSchedule = { customerPercent: assumptions.customerPercent, customerRows: mixedCustomers, weeks: auProduction?.customerPlan.weeks || [], quotaMonths: auProduction?.customerPlan.months || [], customerUnplanned: auProduction?.customerPlan.unplanned || [], boundary, rows: finalRows, following, locked: lockedRows.length, later: following.length,
    srh2026: [...new Map(srh.map(a => [a.chassis, a])).values()],
    unplanned: actions.filter(a => ['locked', 'customers'].includes(a.group) && !scheduledIds.has(a.chassis) && !a.receive && a.action !== 'cancel'),
    monthly: (auProduction?.months || []).map(m => ({ month: m.month, quantity: finalRows.filter(a => (!a.kind || a.kind === 'stock') && a.plannedAu.startsWith(m.month)).length })) };
  return result;
}
