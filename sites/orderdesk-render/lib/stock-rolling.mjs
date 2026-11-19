import { excludedPlanningDealer } from './dealership.mjs';
// Saved inventory opinions and explicit stock admissions. Never edits CRM orders,
// cancellations, transport records or the Longtree locked plan.
import { createHash, randomUUID } from 'node:crypto';
import { dealerGroup, dealerSlug, isMotorhomeOrder, isStockCustomer, leadDays } from './dealership.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { DISPLAY_MODELS, NOT_ON_YARD, isTowable, modelPolicy } from './stock-forecast.mjs';

const MS = 86400000;
const key = v => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
const chassisKey = v => key(v).replace(/[-\s]/g, '');
const stamp = d => Date.parse(`${d}T00:00:00Z`);
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const round = v => Math.round(v * 10) / 10;
const rowFields = ['chassis', 'model', 'modelYear', 'line', 'range', 'customer', 'signedAt', 'dealer', 'group', 'auEnd', 'forecast', 'requestDate', 'orderRow', 'regent', 'regentRank'];
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const sections = report => ['own', 'jv', 'independent'].flatMap(g => report[g] ? [report[g]] : []);
export const dealerSettingsToken = dealers => hash(sorted((dealers || []).filter(d => dealerGroup(d) === 'independent').map(d => [d.slug, d.target, d.travelDays])));

export function stockInputFingerprint({ line, dealers, capacity, settings, orders = {} }) {
  return hash({ policyVersion: 'dealer-balance-simulator-v8-committed-models', today: line.today, settings,
    rows: sorted(line.rows.filter(r => !r.empty).map(r => rowFields.map(k => r[k] ?? null))),
    dealers: sorted((dealers || []).map(d => [d.slug, d.target, d.own, d.jv, d.paused, d.travelDays, d.yard, d.handover?.avgStock, d.handover?.avgCustomer,
      d.handover?.months, d.applicableModels, sorted(Object.entries(d.handover?.stockByModel || {})), sorted((d.vehicles || []).map(v => [v.chassis, v.model, v.modelYear, v.where, v.category, v.arrive, v.since]))])),
    capacity: sorted([...(capacity || new Map()).entries()]),
    inactive: sorted(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => [chassisKey(o.chassis), o.status])),
  });
}

export const forecastPreviewToken = (fingerprint, multiplier, months, assumptions) => hash(assumptions === undefined ? [fingerprint, multiplier, months] : [fingerprint, multiplier, months, assumptions]);
export const sourceBlockers = sources => Object.entries(sources.status || {}).filter(([k, s]) => ['portal', 'dealers', 'plan', 'longtree', 'prod'].includes(k) && s.configured !== false && s.error).map(([k]) => k);

export function saveStockOpinion({ previous, report, fingerprint, actor, now = new Date().toISOString() }) {
  return { id: randomUUID(), savedAt: now, savedBy: String(actor || 'Planning').slice(0, 60), fingerprint,
    multiplier: report.multiplier, months: report.months, report: structuredClone(report), admitted: [],
    events: [{ at: now, by: String(actor || 'Planning').slice(0, 60), type: 'saved', replaces: previous?.id || null }] };
}

/** Replay the saved adjustments, then add pool stock only at actual spare AU slots.
 * Named customer and physical/locked queues retain all their capacity. New stock
 * also needs the configured CN + sea + AU lead time and a CN start within 60 days.
 * Manual recommendations retain their reference ceiling. Mandatory-quantity
 * proposals optimise inventory instead of using that ceiling as a stop rule. */
export function recommendPoolStock({ plan, fingerprint, line, dealers = [], capacity = null, settings = {}, orders = {}, blockers = [], candidateSlots = null, includeRequests = false, preallocatedStock = [], fillToCap = false, snapshotDate = null, horizonEnd = null, fullTarget = false, allowDrafts = true, maxStockMonths = 3 }) {
  const empty = { status: !plan ? 'unsaved' : plan.fingerprint !== fingerprint ? 'stale' : blockers.length ? 'sources' : 'ready',
    planId: plan?.id || null, savedAt: plan?.savedAt || '', savedBy: plan?.savedBy || '', multiplier: plan?.multiplier ?? null, months: plan?.months ?? null,
    items: [], requests: [], admitted: [], requested: plan?.admitted || [], held: {}, monthly: [], token: '', blockers, ai: plan?.ai || null };
  if (empty.status !== 'ready') return empty;
  if (!capacity?.size) return { ...empty, status: 'capacity' };
  dealers = dealers.filter(d => !excludedPlanningDealer(d));
  const today = line.today, end = plan.report.planningEnd, N = Math.round((stamp(end) - stamp(today)) / MS) + 1;
  const at = d => Math.round((stamp(d) - stamp(today)) / MS);
  const dates = Array.from({ length: N }, (_, i) => plus(today, i));
  const fractions = dates.map(d => 1 / new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate());
  const actions = sections(plan.report).flatMap(s => s.actions);
  const covered = new Set(sections(plan.report).flatMap(s => s.dealers).map(d => d.slug));
  const units = new Map(dealers.filter(d => covered.has(d.slug)).map(d => [d.slug, { d, lead: leadDays(d), cap: Number.isFinite(d.target) && d.target > 0 ? Math.floor(d.target * plan.multiplier) : null, events: new Float64Array(N), models: new Map(), initialModels: {}, cache: new Map() }]));
  const physical = new Set(dealers.flatMap(d => (d.vehicles || []).map(v => chassisKey(v.chassis))));
  for (const u of units.values()) for (const v of u.d.vehicles || []) if (v.where === 'yard' && v.category === 'stock' && isTowable(v)) u.initialModels[key(v.model)] = (u.initialModels[key(v.model)] || 0) + 1;
  function curve(initial, events, avg) {
    let stock = initial; const balance = new Float64Array(N), max = new Float64Array(N), sold = new Float64Array(N), missed = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const available = Math.max(0, stock + events[i]), expected = Math.max(0, avg || 0) * fractions[i];
      sold[i] = Math.min(available, expected); missed[i] = expected - sold[i]; stock = balance[i] = available - sold[i];
    }
    let high = 0; for (let i = N - 1; i >= 0; i--) max[i] = high = Math.max(high, balance[i]);
    return { balance, max, sold, missed };
  }
  function refresh(u) { Object.assign(u, curve(u.d.yard.stock, u.events, u.d.handover?.avgStock)); }
  function modelCurve(u, m) {
    m = key(m);
    if (!u.cache.has(m)) u.cache.set(m, curve(u.initialModels[m] || 0, u.models.get(m) || new Float64Array(N), u.d.handover?.stockByModel?.[m]));
    return u.cache.get(m);
  }
  function event(u, day, model, qty) {
    if (!u || !day) return; const i = Math.max(0, at(day)); if (i >= N) return;
    u.events[i] += qty; const m = key(model);
    if (!u.models.has(m)) u.models.set(m, new Float64Array(N));
    u.models.get(m)[i] += qty; u.cache.delete(m);
  }
  const uncertainIncoming = new Map();
  // A pending existing inbound van is a stock reserve, not a veto on every new
  // order for that dealer. Unknown dates conservatively count from today.
  if (fullTarget) for (const a of actions) {
    if (!['pending', 'blocked'].includes(a.action) || !['pgi', 'transport', 'au', 'sea', 'cn', 'locked'].includes(a.group) || a.receive) continue;
    const u = units.get(a.to || a.from); if (!u) continue;
    event(u, a.plannedArrival || a.originalArrival || today, a.model, 1);
    uncertainIncoming.set(u.d.slug, (uncertainIncoming.get(u.d.slug) || 0) + 1);
  }
  for (const a of actions) {
    if (a.receive) event(units.get(a.to), a.plannedArrival, a.model, 1);
    if (a.group === 'yard' && a.reallocated) event(units.get(a.from), a.depart, a.model, -1);
  }
  for (const u of units.values()) refresh(u);
  const priorMonthly = new Map([...units].map(([slug, u]) => [slug, { balance: new Float64Array(u.balance), events: new Float64Array(u.events), sold: new Float64Array(u.sold), missed: new Float64Array(u.missed) }]));
  const unresolved = new Set(actions.filter(a => ['pending', 'blocked'].includes(a.action) && !['customers', 'processing', 'later'].includes(a.group)).map(a => a.from));
  const cancelled = new Set(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => chassisKey(o.chassis)));
  const counts = new Map(); for (const r of line.rows) if (!r.empty) counts.set(chassisKey(r.chassis), (counts.get(chassisKey(r.chassis)) || 0) + 1);
  const held = {}, hold = reason => { held[reason] = (held[reason] || 0) + 1; };
  const pool = [];
  const receiving = u => u && u.d.slug !== 'traralgon' && !u.d.paused && u.lead != null && u.cap != null;
  for (const r of line.rows.filter(r => r.group === 'customers' && !excludedPlanningDealer(r.dealer) && isStockCustomer(r.customer))) {
    const id = chassisKey(r.chassis), source = units.get(dealerSlug(dealers, r.dealer));
    const policy = modelPolicy(r.model, r.modelYear, plan.report.displayModels ?? DISPLAY_MODELS, plan.report.notOnYardModels ?? NOT_ON_YARD);
    const destinations = [source].filter(receiving); // Dealer is authoritative after the explicitly applied Reallocation plan.
    const reason = !id || counts.get(id) !== 1 || physical.has(id) ? 'duplicate' : cancelled.has(id) ? 'cancelled' : r.regentRank < 6 ? 'progress' : isMotorhomeOrder(r) ? 'motorhome'
      : !signedPlansDate([r.signedAt], today) ? 'unsigned' : !source ? 'dealer' : !destinations.length ? 'receiving'
      : !String(r.model || '').trim() || !fullTarget && policy !== 'display' ? 'model' : !fullTarget && unresolved.has(source.d.slug) ? 'unresolved' : '';
    if (reason) { hold(reason); continue; }
    for (const u of destinations) pool.push({ r, u, id, source, policy });
  }
  const duration = (k, fallback) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : fallback);
  const lead = duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40);
  const earliest = plus(today, lead), latest = horizonEnd || plus(earliest, 60);
  const slots = [];
  for (const [day, value] of [...capacity].sort(([a], [b]) => a.localeCompare(b))) if (day >= today) for (let n = 0; n < value.towable; n++) slots.push(day);
  const used = line.rows.reduce((n, r) => r.auForecast?.kind === 'towable' ? Math.max(n, r.auForecast.seq || 0) : n, 0);
  const preferred = new Set(plan.admitted || []), items = [], requests = [], reserved = new Map(), selectedIds = new Set();
  for (const a of preallocatedStock) {
    const p = pool.find(p => p.id === a.chassis && (!a.slug || p.u.d.slug === a.slug) && !selectedIds.has(p.id));
    if (!p) continue;
    selectedIds.add(p.id); items.push({ ...a }); event(p.u, a.arrival, a.model, 1); refresh(p.u);
    reserved.set(a.auEnd, (reserved.get(a.auEnd) || 0) + 1);
  }
  const virtual = includeRequests && allowDrafts ? [...units.values()].filter(u => u.cap != null && u.lead != null && !u.d.paused && u.d.slug !== 'traralgon' && !unresolved.has(u.d.slug))
    .flatMap(u => (plan.report.displayModels ?? DISPLAY_MODELS).filter(model => !isMotorhomeOrder({ model }) && modelPolicy(model, latest.slice(0, 4), plan.report.displayModels ?? DISPLAY_MODELS, plan.report.notOnYardModels ?? NOT_ON_YARD) === 'display')
      .map(model => ({ u, id: '', virtual: true, r: { model, modelYear: latest.slice(0, 4), customer: 'Stock' } }))) : [];
  const requestedSlots = candidateSlots ?? slots.slice(used);
  for (const auEnd of requestedSlots.filter(d => d >= earliest && d <= latest)) {
    if (reserved.get(auEnd)) { reserved.set(auEnd, reserved.get(auEnd) - 1); continue; }
    let choices = [];
    for (const p of [...pool, ...virtual]) {
      if (p.id && selectedIds.has(p.id)) continue;
      if (!fullTarget && p.r.forecast && /^\d{4}-\d{2}-\d{2}$/.test(p.r.forecast) && auEnd < plus(p.r.forecast, duration('auDays', 40))) continue;
      const arrival = plus(auEnd, p.u.lead), t = at(arrival); if (t < 0 || t >= N) continue;
      const m = modelCurve(p.u, p.r.model), buffer = Math.max(2, Math.ceil(p.u.d.target / Math.max(1, (plan.report.displayModels ?? DISPLAY_MODELS).length)));
      if (!fullTarget && (p.u.balance[t] >= (fillToCap ? p.u.cap : p.u.d.target) - 1e-8 || p.u.max[t] > p.u.cap - 1 + 1e-8 || m.max[t] > buffer - 1 + 1e-8)) continue;
      const assessment = fullTarget && snapshotDate ? Math.max(t, Math.min(N - 1, at(snapshotDate))) : t;
      const projected = p.u.balance[assessment] + 1;
      choices.push({ p, arrival, t, modelStock: m.balance[t], priority: { own: 0, jv: 1, independent: 2 }[dealerGroup(p.u.d)], policyPenalty: p.policy && p.policy !== 'display' ? 1 : 0, deficit: p.u.balance[assessment] < p.u.d.target - 1e-8, transfer: p.source && p.source !== p.u ? 1 : 0, score: fullTarget ? projected / p.u.d.target : p.u.balance[t] / p.u.d.target, cover: p.u.d.handover?.avgStock > 0 ? (fullTarget ? projected : p.u.balance[t]) / p.u.d.handover.avgStock : Infinity });
    }
    const actual = choices.filter(c => !c.p.virtual); if (actual.length) choices = actual;
    choices.sort((a, b) => {
      const order = fullTarget ? Number(b.cover <= maxStockMonths) - Number(a.cover <= maxStockMonths) || a.policyPenalty - b.policyPenalty || Number(b.deficit) - Number(a.deficit)
        || (a.deficit && b.deficit ? a.priority - b.priority || a.score - b.score : a.score - b.score || a.priority - b.priority)
        : a.priority - b.priority || a.score - b.score;
      return order || a.cover - b.cover || a.modelStock - b.modelStock || a.transfer - b.transfer
        || a.p.u.d.slug.localeCompare(b.p.u.d.slug) || a.p.r.model.localeCompare(b.p.r.model) || a.p.id.localeCompare(b.p.id);
    });
    const c = choices[0];
    if (!c) {
      if (includeRequests) {
        const later = virtual.map(p => { const t = Math.min(N - 1, Math.max(0, at(plus(auEnd, p.u.lead)))); return { p, stock: p.u.balance[t], score: p.u.balance[t] / p.u.d.target + modelCurve(p.u, p.r.model).balance[t] }; }).sort((a, b) => a.score - b.score || a.p.u.d.slug.localeCompare(b.p.u.d.slug) || a.p.r.model.localeCompare(b.p.r.model))[0];
        requests.push({ id: `need-${requests.length + 1}`, dealer: later?.p.u.d.name || '', slug: later?.p.u.d.slug || '', model: later?.p.r.model || '',
          group: later ? dealerGroup(later.p.u.d) : '', requestedAu: auEnd, auEnd: '', arrival: '', cnStart: '', quantity: 1, status: 'blocked', reason: fullTarget ? 'eligibleOrders' : later ? 'inventory' : 'settings', stockBefore: later?.stock ?? null });
      }
      continue;
    }
    const { p, t } = c;
    const a = { chassis: p.id, model: p.r.model, modelYear: p.r.modelYear || '', dealer: p.u.d.name, slug: p.u.d.slug, jv: Boolean(p.u.d.jv), group: dealerGroup(p.u.d),
      originalDealer: p.source?.d.name || p.u.d.name, reallocated: Boolean(p.source && p.source !== p.u), fullTarget, modelPolicy: p.policy || 'display',
      customer: p.r.customer, signedAt: p.r.signedAt, cnStart: plus(auEnd, -lead), auEnd, arrival: c.arrival,
      stockBefore: round(p.u.balance[t]), stockAfter: round(p.u.balance[t] + 1), modelStock: round(c.modelStock), target: p.u.d.target, cap: p.u.cap,
      reason: c.modelStock < 1 ? 'displayGap' : 'replenish', admitted: !p.virtual && preferred.has(p.id), planId: plan.id };
    if (p.virtual) requests.push({ ...a, id: `need-${requests.length + 1}`, requestedAu: auEnd, quantity: 1, status: 'newOrder' });
    else { items.push(a); selectedIds.add(p.id); }
    event(p.u, c.arrival, p.r.model, 1); refresh(p.u); a.stockAfter = round(p.u.balance[t]);
    if (p.virtual) requests.at(-1).stockAfter = a.stockAfter;
  }
  for (const id of new Set(pool.map(p => p.id))) if (!selectedIds.has(id)) hold('window');
  const monthly = [...units.values()].map(u => {
    const basisArrivals = actions.filter(a => a.receive && a.to === u.d.slug).map(a => ({ chassis: a.chassis, group: a.group, auEnd: a.plannedAu || a.originalAu || '', arrival: a.plannedArrival, action: a.action }));
    if (fullTarget) for (const a of actions) if (!a.receive && ['pending', 'blocked'].includes(a.action) && ['pgi', 'transport', 'au', 'sea', 'cn', 'locked'].includes(a.group) && (a.to || a.from) === u.d.slug) basisArrivals.push({ chassis: a.chassis, group: a.group, auEnd: a.originalAu || '', arrival: a.plannedArrival || a.originalArrival || today, action: 'reserve' });
    const confirmedEvents = new Float64Array(priorMonthly.get(u.d.slug).events);
    for (const a of items.filter(a => a.slug === u.d.slug && a.admitted)) confirmedEvents[Math.max(0, at(a.arrival))]++;
    const confirmed = curve(u.d.yard.stock, confirmedEvents, u.d.handover?.avgStock);
    const incomplete = u.cap == null || u.lead == null && !u.d.paused && u.d.slug !== 'traralgon';
    return { slug: u.d.slug, name: u.d.name, jv: Boolean(u.d.jv), group: dealerGroup(u.d), target: u.d.target, cap: u.cap,
    months: (plan.report[dealerGroup(u.d)]?.dealers.find(d => d.slug === u.d.slug)?.monthly || []).map(m => {
      const indices = dates.flatMap((d, i) => d.startsWith(m.month) ? [i] : []), i = indices.at(-1);
      const sum = values => round(indices.reduce((n, t) => n + values[t], 0));
      return { month: m.month, before: !incomplete && i != null ? round(priorMonthly.get(u.d.slug).balance[i]) : null, after: !incomplete && i != null ? round(u.balance[i]) : null,
        confirmed: !incomplete && i != null ? round(confirmed.balance[i]) : null, sold: sum(u.sold), unmet: sum(u.missed), confirmedSold: sum(confirmed.sold), confirmedUnmet: sum(confirmed.missed), beforeSold: sum(priorMonthly.get(u.d.slug).sold), beforeUnmet: sum(priorMonthly.get(u.d.slug).missed),
        basisArrivals: basisArrivals.filter(a => a.arrival.startsWith(m.month)), basisIn: basisArrivals.filter(a => a.arrival.startsWith(m.month)).length,
        stockIn: [...items, ...requests.filter(a => a.status === 'newOrder')].filter(a => a.slug === u.d.slug && a.arrival.startsWith(m.month)).length, confirmedIn: items.filter(a => a.slug === u.d.slug && a.admitted && a.arrival.startsWith(m.month)).length };
    }) };
  });
  // All dealers use the same point in time; actual excludes uncreated Stock orders.
  const inventoryDate = [today, snapshotDate || '', ...items.map(a => a.arrival), ...requests.filter(a => a.status === 'newOrder').map(a => a.arrival)].sort().at(-1);
  const inventoryIndex = at(inventoryDate);
  const inventory = [...units.values()].map(u => {
    const actualEvents = new Float64Array(priorMonthly.get(u.d.slug).events);
    for (const a of items.filter(a => a.slug === u.d.slug)) { const t = Math.max(0, at(a.arrival)); if (t < N) actualEvents[t]++; }
    const actual = curve(u.d.yard.stock, actualEvents, u.d.handover?.avgStock);
    const complete = u.cap != null && (u.lead != null || u.d.paused || u.d.slug === 'traralgon') && inventoryIndex >= 0 && inventoryIndex < N;
    const firstIncoming = items.filter(a => a.slug === u.d.slug).map(a => at(a.arrival));
    return { slug: u.d.slug, name: u.d.name, group: dealerGroup(u.d), ideal: u.d.target, cap: u.cap,
      poolAvailable: pool.filter(p => p.u === u).length, poolReturned: pool.filter(p => p.u === u && p.r.returnedToPool).length,
      avgStock: u.d.handover?.avgStock ?? null, avgCustomer: u.d.handover?.avgCustomer ?? null,
      before: complete ? priorMonthly.get(u.d.slug).balance[inventoryIndex] : null,
      actual: complete ? actual.balance[inventoryIndex] : null, planned: complete ? u.balance[inventoryIndex] : null,
      uncertainIncoming: uncertainIncoming.get(u.d.slug) || 0,
      peakAfterReplenishment: complete && firstIncoming.length ? Math.max(...actual.balance.slice(Math.max(0, Math.min(...firstIncoming)))) : null,
      peakActual: complete ? Math.max(...actual.balance) : null, peakPlanned: complete ? Math.max(...u.balance) : null,
      paused: Boolean(u.d.paused || u.d.slug === 'traralgon') };
  });
  return { ...empty, fullTarget, items, requests, held, monthly, inventoryDate, inventory, admitted: items.filter(a => a.admitted).map(a => a.chassis), token: hash([plan.id, fingerprint, items, requests]) };
}

export function productionLineDisplay(line) {
  const rows = line.rows.filter(r => !r.planningExcluded && (r.group !== 'processing' || String(r.customer || '').trim()));
  return { ...line, rows, counts: { ...line.counts, processing: rows.filter(r => r.group === 'processing').length } };
}
