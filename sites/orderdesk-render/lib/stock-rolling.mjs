// Saved inventory opinions and explicit stock admissions. Never edits CRM orders,
// cancellations, transport records or the Longtree locked plan.
import { createHash, randomUUID } from 'node:crypto';
import { isMotorhomeOrder, isStockCustomer, leadDays, slugify } from './dealership.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { DISPLAY_MODELS, NOT_ON_YARD, isTowable, modelPolicy } from './stock-forecast.mjs';

const MS = 86400000;
const key = v => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
const chassisKey = v => key(v).replace(/[-\s]/g, '');
const stamp = d => Date.parse(`${d}T00:00:00Z`);
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const round = v => Math.round(v * 10) / 10;
const rowFields = ['chassis', 'model', 'modelYear', 'line', 'range', 'customer', 'signedAt', 'dealer', 'group', 'auEnd', 'forecast', 'orderRow', 'regent', 'regentRank'];
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function stockInputFingerprint({ line, dealers, capacity, settings, orders = {} }) {
  return hash({ today: line.today, settings,
    rows: sorted(line.rows.filter(r => !r.empty).map(r => rowFields.map(k => r[k] ?? null))),
    dealers: sorted((dealers || []).map(d => [d.slug, d.target, d.own, d.jv, d.paused, d.travelDays, d.yard, d.handover?.avgStock,
      sorted(Object.entries(d.handover?.stockByModel || {})), sorted((d.vehicles || []).map(v => [v.chassis, v.model, v.where, v.category, v.arrive]))])),
    capacity: sorted([...(capacity || new Map()).entries()]),
    inactive: sorted(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => [chassisKey(o.chassis), o.status])),
  });
}

export const forecastPreviewToken = (fingerprint, multiplier, months) => hash([fingerprint, multiplier, months]);
export const sourceBlockers = sources => Object.entries(sources.status || {}).filter(([k, s]) => ['portal', 'dealers', 'plan', 'longtree', 'prod'].includes(k) && s.configured !== false && s.error).map(([k]) => k);

export function saveStockOpinion({ previous, report, fingerprint, actor, now = new Date().toISOString() }) {
  return { id: randomUUID(), savedAt: now, savedBy: String(actor || 'Planning').slice(0, 60), fingerprint,
    multiplier: report.multiplier, months: report.months, report: structuredClone(report), admitted: [],
    events: [{ at: now, by: String(actor || 'Planning').slice(0, 60), type: 'saved', replaces: previous?.id || null }] };
}

/** Replay the saved adjustments, then add pool stock only at actual spare AU slots.
 * Named customer and physical/locked queues retain all their capacity. New stock
 * also needs the configured CN + sea + AU lead time and a CN start within 60 days.
 * Every candidate is feasible together with the other returned candidates. */
export function recommendPoolStock({ plan, fingerprint, line, dealers = [], capacity = null, settings = {}, orders = {}, blockers = [] }) {
  const empty = { status: !plan ? 'unsaved' : plan.fingerprint !== fingerprint ? 'stale' : blockers.length ? 'sources' : 'ready',
    planId: plan?.id || null, savedAt: plan?.savedAt || '', savedBy: plan?.savedBy || '', multiplier: plan?.multiplier ?? null, months: plan?.months ?? null,
    items: [], admitted: [], requested: plan?.admitted || [], held: {}, monthly: [], token: '', blockers, ai: plan?.ai || null };
  if (empty.status !== 'ready') return empty;
  if (!capacity?.size) return { ...empty, status: 'capacity' };
  const today = line.today, end = plan.report.planningEnd, N = Math.round((stamp(end) - stamp(today)) / MS) + 1;
  const at = d => Math.round((stamp(d) - stamp(today)) / MS);
  const dates = Array.from({ length: N }, (_, i) => plus(today, i));
  const fractions = dates.map(d => 1 / new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate());
  const actions = [...plan.report.own.actions, ...plan.report.jv.actions];
  const covered = new Set([...plan.report.own.dealers, ...plan.report.jv.dealers].map(d => d.slug));
  const units = new Map(dealers.filter(d => covered.has(d.slug)).map(d => [d.slug, { d, lead: leadDays(d), cap: Math.floor(d.target * plan.multiplier), events: new Float64Array(N), models: new Map(), initialModels: {}, cache: new Map() }]));
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
  for (const a of actions) {
    if (a.receive) event(units.get(a.to), a.plannedArrival, a.model, 1);
    if (a.group === 'yard' && a.reallocated) event(units.get(a.from), a.depart, a.model, -1);
  }
  for (const u of units.values()) refresh(u);
  const priorMonthly = new Map([...units].map(([slug, u]) => [slug, { balance: new Float64Array(u.balance), events: new Float64Array(u.events) }]));
  const unresolved = new Set(actions.filter(a => ['pending', 'blocked'].includes(a.action) && !['customers', 'processing', 'later'].includes(a.group)).map(a => a.from));
  const cancelled = new Set(Object.values(orders).filter(o => ['cancelled', 'completed'].includes(o.status)).map(o => chassisKey(o.chassis)));
  const counts = new Map(); for (const r of line.rows) if (!r.empty) counts.set(chassisKey(r.chassis), (counts.get(chassisKey(r.chassis)) || 0) + 1);
  const held = {}, hold = reason => { held[reason] = (held[reason] || 0) + 1; };
  const pool = [];
  for (const r of line.rows.filter(r => r.group === 'customers' && isStockCustomer(r.customer))) {
    const id = chassisKey(r.chassis), u = units.get(slugify(r.dealer));
    const reason = !id || counts.get(id) !== 1 || physical.has(id) ? 'duplicate' : cancelled.has(id) ? 'cancelled' : r.regentRank < 6 ? 'progress' : isMotorhomeOrder(r) ? 'motorhome'
      : !signedPlansDate([r.signedAt], today) ? 'unsigned' : !u ? 'dealer' : u.d.slug === 'traralgon' || u.d.paused || u.lead == null ? 'receiving'
      : modelPolicy(r.model, r.modelYear, plan.report.displayModels ?? DISPLAY_MODELS, plan.report.notOnYardModels ?? NOT_ON_YARD) !== 'display' ? 'model' : unresolved.has(u.d.slug) ? 'unresolved' : '';
    if (reason) { hold(reason); continue; }
    pool.push({ r, u, id });
  }
  const duration = (k, fallback) => Math.max(0, Number.isFinite(Number(settings[k])) ? Number(settings[k]) : fallback);
  const lead = duration('cnDays', 20) + duration('seaDays', 50) + duration('auDays', 40);
  const earliest = plus(today, lead), latest = plus(earliest, 60);
  const slots = [];
  for (const [day, value] of [...capacity].sort(([a], [b]) => a.localeCompare(b))) if (day >= today) for (let n = 0; n < value.towable; n++) slots.push(day);
  const used = line.rows.reduce((n, r) => r.auForecast?.kind === 'towable' ? Math.max(n, r.auForecast.seq || 0) : n, 0);
  const preferred = new Set(plan.admitted || []), items = [];
  for (const auEnd of slots.slice(used).filter(d => d >= earliest && d <= latest)) {
    const choices = [];
    for (const p of pool) {
      if (p.selected) continue;
      if (p.r.forecast && /^\d{4}-\d{2}-\d{2}$/.test(p.r.forecast) && auEnd < plus(p.r.forecast, duration('auDays', 40))) continue;
      const arrival = plus(auEnd, p.u.lead), t = at(arrival); if (t < 0 || t >= N) continue;
      const m = modelCurve(p.u, p.r.model), buffer = Math.max(2, Math.ceil(p.u.d.target / Math.max(1, (plan.report.displayModels ?? DISPLAY_MODELS).length)));
      if (p.u.balance[t] >= p.u.d.target - 1e-8 || p.u.max[t] > p.u.cap - 1 + 1e-8 || m.max[t] > buffer - 1 + 1e-8) continue;
      choices.push({ p, arrival, t, modelStock: m.balance[t], score: p.u.balance[t] / p.u.d.target + (m.balance[t] < 1 ? -2 : 0) });
    }
    choices.sort((a, b) => a.score - b.score || a.p.id.localeCompare(b.p.id));
    const c = choices[0]; if (!c) continue;
    const { p, t } = c;
    items.push({ chassis: p.id, model: p.r.model, modelYear: p.r.modelYear || '', dealer: p.u.d.name, slug: p.u.d.slug, jv: Boolean(p.u.d.jv),
      customer: p.r.customer, signedAt: p.r.signedAt, cnStart: plus(auEnd, -lead), auEnd, arrival: c.arrival,
      stockBefore: round(p.u.balance[t]), stockAfter: round(p.u.balance[t] + 1), modelStock: round(c.modelStock), target: p.u.d.target, cap: p.u.cap,
      reason: c.modelStock < 1 ? 'displayGap' : 'replenish', admitted: preferred.has(p.id), planId: plan.id });
    p.selected = true; event(p.u, c.arrival, p.r.model, 1); refresh(p.u);
    items.at(-1).stockAfter = round(p.u.balance[t]);
  }
  for (const p of pool) if (!p.selected) hold('window');
  const monthly = [...units.values()].map(u => {
    const confirmedEvents = new Float64Array(priorMonthly.get(u.d.slug).events);
    for (const a of items.filter(a => a.slug === u.d.slug && a.admitted)) confirmedEvents[Math.max(0, at(a.arrival))]++;
    const confirmed = curve(u.d.yard.stock, confirmedEvents, u.d.handover?.avgStock);
    return { slug: u.d.slug, name: u.d.name, jv: Boolean(u.d.jv), target: u.d.target, cap: u.cap,
    months: (plan.report[u.d.jv ? 'jv' : 'own'].dealers.find(d => d.slug === u.d.slug)?.monthly || []).map(m => {
      const indices = dates.flatMap((d, i) => d.startsWith(m.month) ? [i] : []), i = indices.at(-1);
      const sum = values => round(indices.reduce((n, t) => n + values[t], 0));
      return { month: m.month, before: i != null ? round(priorMonthly.get(u.d.slug).balance[i]) : null, after: i != null ? round(u.balance[i]) : null,
        confirmed: i != null ? round(confirmed.balance[i]) : null, sold: sum(u.sold), unmet: sum(u.missed), confirmedSold: sum(confirmed.sold), confirmedUnmet: sum(confirmed.missed),
        stockIn: items.filter(a => a.slug === u.d.slug && a.arrival.startsWith(m.month)).length, confirmedIn: items.filter(a => a.slug === u.d.slug && a.admitted && a.arrival.startsWith(m.month)).length };
    }) };
  });
  return { ...empty, items, held, monthly, admitted: items.filter(a => a.admitted).map(a => a.chassis), token: hash([plan.id, fingerprint, items]) };
}

export function productionLineDisplay(line) {
  const rows = line.rows.filter(r => r.group !== 'processing' || String(r.customer || '').trim());
  return { ...line, rows, counts: { ...line.counts, processing: rows.filter(r => r.group === 'processing').length } };
}
