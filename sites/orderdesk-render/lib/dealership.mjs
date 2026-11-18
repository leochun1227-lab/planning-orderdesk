// Our five dealerships (the Dealer Portal's "Self-owned" dealers): new stock in the yard, vans in transit and handovers,
// replicating the Dealer Portal admin page (src/pages/Admin.tsx: yard categories, transit rule) and the dealer comparison
// dashboard (src/pages/ModernDealerComparisonDashboard.tsx: YTD Handover, stock / customer by the Orderlist customer name).
// From these: how many stock vans each dealership still needs. Rolling accepts signed Towable customers and
// stock validated against the saved inventory opinion. Read-only; no Portal writes.
import { signedPlansDate } from './order-signoff.mjs';

// Days from AU finish (下线) to the van being at the dealer: 3 days to dispatch + the road / sea trip. Only used to count
// when vans arrive at each dealer; the AU finish dates themselves are not changed. Transport vans count as finished today.
// Traralgon: not calculated for now (paused).
export const DISPATCH_DAYS = 3;
export const DEALERSHIPS = [
  { slug: 'frankston', name: 'Frankston', target: 50, travelDays: 1 },
  { slug: 'geelong', name: 'Geelong', target: 40, travelDays: 1 },
  { slug: 'launceston', name: 'Launceston', target: 25, travelDays: 20 },
  { slug: 'st-james', name: 'St James', target: 60, travelDays: 20 },
  { slug: 'traralgon', name: 'Traralgon', target: 25, travelDays: null, paused: true },
];
export const leadDays = d => (d.travelDays == null ? null : DISPATCH_DAYS + d.travelDays);
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** A van in transit (already PGI'd, so the 3 dispatch days are behind it) is at the dealer PGI + travel days; one that
 *  should already be there but is not in the yard yet counts as arriving today. */
export function transitArrival(pgiDay, d, today) {
  if (d.travelDays == null) return '';
  const day = pgiDay ? plusDays(pgiDay, d.travelDays) : today;
  return day < today ? today : day;
}
/** When a production-line van would be at its dealer: AU finish (Transport: today) + 3 + travel days. */
export function arrivalAtDealer(r, d, today) {
  const lead = leadDays(d);
  if (lead == null) return '';
  const done = r.group === 'transport' ? today : r.auEnd;
  return done ? plusDays(done, lead) : '';
}
export const IDEAL_STOCK_SOURCE = 'Andrew Crank, 2026-10-27: Ideal Stock Qty per dealer';
// Ideal stock per dealer from the same email (Vanari (S) / (N) and Sydney have no active dealer in the Portal).
export const IDEAL_STOCK = { abco: 15, bundaberg: 40, 'destiny-rv': 35, 'forest-glen': 70, frankston: 50, geelong: 40, heatherbrae: 40, launceston: 25, 'slacks-creek': 40, 'st-james': 60, toowoomba: 35, townsville: 30, traralgon: 25, wangaratta: 25, 'vanari-s': 25, 'vanari-n': 25, sydney: 25 };
// JV dealers: 7 road days plus the shared 3 dispatch days = 10 days from AU finish.
export const JV_DEALERS = [
  { slug: 'bundaberg', name: 'Bundaberg', travelDays: 7 },
  { slug: 'heatherbrae', name: 'Heatherbrae', travelDays: 7 },
  { slug: 'toowoomba', name: 'Toowoomba', travelDays: 7 },
  { slug: 'wangaratta', name: 'Wangaratta', travelDays: 7 },
].map(d => ({ ...d, target: IDEAL_STOCK[d.slug], own: false, jv: true }));
const SELF_OWNED = new Set(DEALERSHIPS.map(d => d.slug));
const JV_SLUGS = new Set(JV_DEALERS.map(d => d.slug));
export const ROLLING_SIZE = 180;
export const HANDOVER_MONTHS = 3; // average over the last 3 completed months
const TRANSIT_MAX_DAYS = 100; // Portal: a PGI older than 100 days no longer counts as in transit
// Transport vans count as in transit (withTransport below); "on the line" = AU production → locked.
const PIPELINE_GROUPS = ['au', 'sea', 'cn', 'locked'];

/** Extra Portal nodes (2-hourly with the Portal copy): all yards (a van in any yard is not in transit), the delivery-to
 *  overrides, and dealer handovers. pgirecord and schedule are already in the copy. */
export const PORTAL_DEALER_SOURCES = [['yard', 'yardstock'], ['deliveryTo', 'deliveryToAssignments'], ['handover', 'handover'], ['dealerConfigs', 'dealerConfigs']];

export const slugify = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const norm = v => String(v ?? '').replace(/[-\s]/g, '').toUpperCase();
const flag = v => v === true || ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());
const STOCK_BILL_TO = /snowy|regent|united/i;
export const isStockCustomer = customer => /stock$/i.test(String(customer ?? '').trim());
const pad = n => String(n).padStart(2, '0');

/** 'dd/mm/yyyy', ISO date or ISO time (Sydney day) → 'yyyy-mm-dd'. */
export function dayOf(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(ms)) : '';
}
const daysBetween = (from, to) => (from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) : null);

/** Admin.tsx yardRowCategory for a self-owned dealer: second hand, else stock when billed to Snowy / Regent / United. */
export function yardCategory(record, useBillTo = true) {
  const vt = String(record?.vehicleType ?? record?.VehicleType ?? '').trim().toLowerCase();
  const type = !vt ? null : vt.includes('second') ? 'second' : vt.includes('new') ? 'new' : null;
  const model = String(record?.model ?? record?.materialCode ?? '').trim();
  const wholesale = [record?.wholesalepo, record?.wholesalePo, record?.wholesalePO].find(v => v && typeof v === 'object') || {};
  if (type === 'second' || (!type && (flag(record?.secondVans) || flag(wholesale.secondVans) || /^z19/i.test(model)))) return 'second';
  if (useBillTo) return STOCK_BILL_TO.test(String(record?.wholesaleBillToName ?? record?.WholesaleBillToName ?? '').trim()) ? 'stock' : 'customer';
  const raw = String(record?.type ?? record?.Type ?? '').trim().toLowerCase();
  if (!raw) return isStockCustomer(record?.customer) ? 'stock' : 'customer';
  return raw.includes('stock') ? 'stock' : 'customer';
}
/** ModernDealerComparisonDashboard isSecondHandRecord (handovers). */
const secondHandHandover = r => {
  const vt = String(r?.vehicleType ?? r?.VehicleType ?? r?.type ?? '').toLowerCase(), sv = String(r?.secondVans ?? '').toLowerCase();
  return vt.includes('second') || sv === 'true' || sv === '1' || String(r?.materialCode ?? r?.material ?? r?.model ?? '').trim().toUpperCase().startsWith('Z19');
};
const listOf = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const monthsBefore = (today, n) => { const [y, m] = today.split('-').map(Number); return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - n + i, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }); };

/** Self-owned first, then the four JV dealers, then the other active Portal dealers (not groups). */
export function dealerList(raw) {
  const own = DEALERSHIPS.map(d => ({ ...d, own: true }));
  const candidates = new Map(), excluded = new Set(), aliases = new Map();
  for (const [slug, c] of Object.entries(raw?.dealerConfigs || {})) {
    if (!c) continue;
    if (c.isGroup === true || c.isActive === false) { excluded.add(slugify(slug)); excluded.add(slugify(c.name)); continue; }
    candidates.set(slugify(slug), String(c.name || slug));
    if (c.name) aliases.set(slugify(c.name), slugify(slug));
  }
  for (const name of [...Object.keys(raw?.yard || {}), ...listOf(raw?.schedule).map(r => r?.Dealer || r?.dealer || r?.Dealership), ...listOf(raw?.pgi).map(r => r?.dealer)]) {
    const slug = aliases.get(slugify(name)) || slugify(name); if (slug && !candidates.has(slug)) candidates.set(slug, String(name));
  }
  const others = [...candidates].filter(([slug]) => slug && !excluded.has(slug) && !SELF_OWNED.has(slug) && !JV_SLUGS.has(slug))
    .map(([slug, name]) => ({ slug, name, target: IDEAL_STOCK[slug] ?? null, travelDays: null, own: false, independent: true }))
    .sort((a, z) => a.name.localeCompare(z.name));
  return [...own, ...JV_DEALERS.map(d => ({ ...d })), ...others];
}

export const dealerGroup = d => d.own !== false ? 'own' : d.jv ? 'jv' : 'independent';
export const dealerSlug = (dealers, value) => { const slug = slugify(value); return dealers.find(d => d.slug === slug)?.slug || dealers.find(d => slugify(d.name) === slug)?.slug || slug; };

export function configureDealers(dealers, overrides = {}, today) {
  return dealers?.map(d => {
    const setting = overrides[d.slug] || {}, configured = { ...d, ...setting };
    return { ...configured, vehicles: (d.vehicles || []).map(v => v.where === 'transit' && v.via !== 'transport'
      ? { ...v, arrive: transitArrival(v.since, configured, today) } : v) };
  }) ?? null;
}

export function validateDealerSettings(entries, known) {
  if (!Array.isArray(entries) || entries.length > 300) throw new Error('Dealer设置无效');
  const slugs = new Set(known.filter(d => dealerGroup(d) === 'independent').map(d => d.slug)), seen = new Set();
  return Object.fromEntries(entries.map(e => {
    if (!e || !slugs.has(e.slug) || seen.has(e.slug)) throw new Error('Dealer设置已变化，请刷新');
    seen.add(e.slug);
    if (e.target !== null && (!Number.isInteger(e.target) || e.target < 1 || e.target > 10000)) throw new Error('Ideal须为1–10000的整数，或留空待核对');
    if (e.travelDays !== null && (!Number.isInteger(e.travelDays) || e.travelDays < 0 || e.travelDays > 365)) throw new Error('运输天数须为0–365的整数，或留空待核对');
    return [e.slug, { target: e.target, travelDays: e.travelDays }];
  }));
}

/** Our dealers (or every dealer with all = true) as the Dealer Portal shows them today. */
export function dealerSnapshot(raw, today, { all = false, towableOnly = false } = {}) {
  const known = dealerList(raw), resolveDealer = value => dealerSlug(known, value);
  const yards = raw?.yard || {}, pgi = raw?.pgi || {}, assignments = raw?.deliveryTo || {};
  const customerType = new Map(); // Orderlist customer name: "... Stock" = stock, else customer (handover classification)
  const modelByChassis = new Map(), yearByChassis = new Map();
  const modelYearOf = r => String(r?.modelYear ?? r?.ModelYear ?? r?.['Model Year'] ?? r?.['Model year'] ?? r?.['Model year (MY)'] ?? '').trim();
  for (const r of listOf(raw?.schedule)) { const c = norm(r?.Chassis), cu = String(r?.Customer ?? '').trim(); if (c && cu) customerType.set(c, isStockCustomer(cu) ? 'stock' : 'customer'); if (c) { modelByChassis.set(c, String(r.Model || r.model || r['Model / Range'] || '')); yearByChassis.set(c, modelYearOf(r)); } }
  const modelOf = (c, r) => String(r.model || r.materialCode || r.material || modelByChassis.get(norm(c)) || '');
  const included = (c, r) => !towableOnly || !/^SR[MV]/i.test(norm(c)) && !/^SR[MV]/i.test(modelOf(c, r));
  const inAnyYard = new Set();
  for (const stock of Object.values(yards)) for (const c of Object.keys(stock || {})) if (c !== 'dealer-chassis') inAnyYard.add(c.trim().toUpperCase());
  const delivery = new Map(Object.entries(assignments).map(([c, a]) => [c.trim().toUpperCase(), a || {}]));
  const effectiveDealer = (chassis, rec) => {
    const a = delivery.get(chassis) || {}, src = resolveDealer(a.sourceDealerSlug), own = resolveDealer(rec.dealer);
    if (src && own && own !== src) return own;
    return resolveDealer(a.deliveryTo) || (own === 'green-show' ? 'forest-glen' : own);
  };
  const months = monthsBefore(today, HANDOVER_MONTHS), thisMonth = today.slice(0, 7);
  const transitBy = new Map(); // effective dealer → active PGI records
  for (const [c, r] of Object.entries(pgi)) { if (!r || r.history) continue; const chassis = c.trim().toUpperCase(); if (!chassis) continue; const slug = effectiveDealer(chassis, r); transitBy.set(slug, [...(transitBy.get(slug) || []), [c, r]]); }
  return (all ? known : DEALERSHIPS.map(d => ({ ...d, own: true }))).map(d => {
    const useBillTo = SELF_OWNED.has(d.slug); // Admin.tsx: self-owned / price-enabled dealers go by the bill-to name
    const yardRows = Object.entries(yards[d.slug] || {}).filter(([c, r]) => c !== 'dealer-chassis' && r && !r.history && included(c, r))
      .map(([c, r]) => { const since = dayOf(r.receivedAt ?? r.createdAt ?? r.movementDate); return { chassis: String(r.chassis || r.Chassis || c).trim(), where: 'yard', category: yardCategory(r, useBillTo), model: modelOf(c, r), modelYear: modelYearOf(r) || yearByChassis.get(norm(c)) || '', customer: String(r.customer || ''), since, days: daysBetween(since, today) }; });
    const handovers = Object.entries(raw?.handover?.[d.slug] || raw?.[`handover_${d.slug}`] || {}).map(([c, r]) => ({ chassis: c, ...(r || {}) }));
    const handedOver = new Set(handovers.map(h => h.chassis.trim().toUpperCase()));
    const transit = (transitBy.get(d.slug) || []).flatMap(([c, r]) => {
      const chassis = c.trim().toUpperCase(), day = dayOf(r.pgidate), days = daysBetween(day, today) ?? 0;
      if (days > TRANSIT_MAX_DAYS || inAnyYard.has(chassis) || handedOver.has(chassis) || !included(c, r)) return [];
      return [{ chassis: c.trim(), where: 'transit', category: yardCategory(r, Boolean(String(r.wholesaleBillToName ?? r.WholesaleBillToName ?? '').trim())), model: modelOf(c, r), modelYear: modelYearOf(r) || yearByChassis.get(norm(c)) || '', customer: String(r.customer || ''), since: day, days, arrive: transitArrival(day, d, today) }];
    });
    const monthly = new Map(), stockByModel = {};
    for (const h of handovers) {
      if (!included(h.chassis, h)) continue;
      const m = dayOf(h.handoverAt ?? h.createdAt).slice(0, 7); if (!m) continue;
      const x = monthly.get(m) || { month: m, stock: 0, customer: 0, second: 0 };
      if (secondHandHandover(h)) x.second++; else {
        const category = customerType.get(norm(h.chassis)) || 'stock'; x[category]++;
        const model = modelOf(h.chassis, h).trim().toUpperCase().replace(/\s+/g, ' ');
        if (towableOnly && category === 'stock' && model && months.includes(m)) stockByModel[model] = (stockByModel[model] || 0) + 1 / HANDOVER_MONTHS;
      }
      monthly.set(m, x);
    }
    const last = months.map(m => monthly.get(m) || { month: m, stock: 0, customer: 0, second: 0 });
    const avg = k => Math.round((last.reduce((s, x) => s + x[k], 0) / HANDOVER_MONTHS) * 10) / 10;
    const count = (list, cat) => list.filter(r => r.category === cat).length;
    return { ...d, yard: { stock: count(yardRows, 'stock'), customer: count(yardRows, 'customer'), second: count(yardRows, 'second'), total: yardRows.length },
      transit: { stock: count(transit, 'stock'), customer: count(transit, 'customer'), second: count(transit, 'second'), total: transit.length },
      handover: { months: last, thisMonth: monthly.get(thisMonth) || { month: thisMonth, stock: 0, customer: 0, second: 0 }, avgStock: avg('stock'), avgCustomer: avg('customer'), avgSecond: avg('second'), ...(towableOnly ? { stockByModel } : {}) },
      vehicles: [...yardRows, ...transit] };
  });
}

/** Transit = PGI'd vans on the road + vans at Transport (finished, being sent to the dealer: AU finish = today). Returns
 *  new dealer objects (the snapshot is cached and shared). */
export function withTransport(snapshot, rows, today) {
  return snapshot.map(d => {
    const extra = rows.filter(r => r.group === 'transport' && !r.empty && slugify(r.dealer) === d.slug).map(r => {
      const since = String(r.live?.stationSince || r.live?.enteredAt || '').slice(0, 10);
      return { chassis: r.chassis, where: 'transit', via: 'transport', category: isStockCustomer(r.customer) ? 'stock' : 'customer', model: r.model || '', customer: r.customer || '', since, days: since ? Math.round((Date.parse(today) - Date.parse(since)) / 86400000) : null, arrive: arrivalAtDealer(r, d, today) };
    });
    const n = cat => extra.filter(v => v.category === cat).length;
    return { ...d, vehicles: [...d.vehicles, ...extra], transit: { ...d.transit, stock: d.transit.stock + n('stock'), customer: d.transit.customer + n('customer'), total: d.transit.total + extra.length, pgiStock: d.transit.stock, transportStock: n('stock'), transportCustomer: n('customer') } };
  });
}

/** Stock each dealership still needs when the rolling line's vans reach it. `rollingEnd` = AU finish of the last
 *  rolling-line place; the dealer gets it `leadDays` later (= deliveredBy). By then:
 *  stock = yard stock + transit stock arriving by then (PGI + travel days; Transport: today + lead) + stock vans from AU production → locked that arrive by then (AU finish + lead)
 *          − average stock handovers per month × months until then;  need = target − stock. */
export function dealerNeeds(snapshot, rows, today, rollingEnd) {
  return snapshot.map(d => {
    const mine = rows.filter(r => slugify(r.dealer) === d.slug && PIPELINE_GROUPS.includes(r.group));
    const pipeline = Object.fromEntries(PIPELINE_GROUPS.map(g => [g, mine.filter(r => r.group === g && isStockCustomer(r.customer)).length]));
    const pipelineStock = Object.values(pipeline).reduce((a, b) => a + b, 0);
    const pipelineCustomer = mine.filter(r => !isStockCustomer(r.customer) && r.customer).length;
    const base = { slug: d.slug, lead: leadDays(d), pipeline, pipelineStock, pipelineCustomer };
    if (d.paused) return { ...base, paused: true, deliveredBy: '', months: 0, arriving: 0, transitArriving: 0, sold: 0, projected: null, need: 0 };
    if (base.lead == null || !rollingEnd) return { ...base, deliveredBy: '', months: 0, arriving: null, transitArriving: null, sold: null, projected: null, need: null };
    const deliveredBy = plusDays(rollingEnd, leadDays(d));
    const months = Math.max(0, (Date.parse(deliveredBy) - Date.parse(today)) / 86400000 / (365.25 / 12));
    const arriving = mine.filter(r => isStockCustomer(r.customer) && (a => a && a <= deliveredBy)(arrivalAtDealer(r, d, today))).length;
    const transitArriving = (d.vehicles || []).filter(v => v.where === 'transit' && v.category === 'stock' && v.arrive && v.arrive <= deliveredBy).length;
    const sold = Math.round(d.handover.avgStock * months);
    const projected = d.yard.stock + transitArriving + arriving - sold;
    return { ...base, deliveredBy, months: Math.round(months * 10) / 10, arriving, transitArriving, sold, projected, need: Math.max(0, d.target - projected) };
  });
}

export const isMotorhomeOrder = r => [r.chassis, r.model, r.line, r.range].some(v => /^SR[MV]/i.test(String(v || '').trim().replace(/[-\s]/g, '')));
export const isRollingCustomer = r => !isMotorhomeOrder(r) && Boolean(String(r.customer || '').trim()) && !isStockCustomer(r.customer);

/** Inventory pool metadata only. Selection into rolling requires a saved proposal.
 * Keep the old needs/size arguments for compatibility; neither books capacity. */
export function pickRolling(rows, needs, size = ROLLING_SIZE) {
  const open = rows.filter(r => (r.group === 'later' || r.group === 'customers') && !r.empty && !isMotorhomeOrder(r) && signedPlansDate([r.signedAt], r.today));
  const byOrder = (a, z) => (a.signedAt || '9999').localeCompare(z.signedAt || '9999') || (a.orderRow ?? 1e9) - (z.orderRow ?? 1e9) || (a.forecast || '9999').localeCompare(z.forecast || '9999') || a.chassis.localeCompare(z.chassis);
  const customers = open.filter(isRollingCustomer).sort(byOrder).map(r => ({ r, kind: 'customer' }));
  const picked = [];
  const stockPicked = Object.fromEntries(DEALERSHIPS.map(d => [d.slug, 0]));
  const stockAvailable = Object.fromEntries(DEALERSHIPS.map(d => [d.slug, open.filter(r => slugify(r.dealer) === d.slug && isStockCustomer(r.customer)).length]));
  return { picked, stockPicked, stockAvailable, customers: 0, customerCandidates: customers };
}

/** Month by month for one dealership (this month + the next `count` − 1): vans expected to arrive (stock / customer),
 *  stock handovers at the 3-month average, and stock at the end of the month.
 *  Arrival = expected AU finish (Transport: today) + 3 + travel days; transit: PGI + travel days. Paused dealers: none. */
export function dealerMonthly(d, rows, today, count = 8) {
  const [y, m] = today.split('-').map(Number);
  const keys = Array.from({ length: count }, (_, i) => { const x = new Date(Date.UTC(y, m - 1 + i, 1)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`; });
  const months = keys.map(month => ({ month, stockIn: 0, customerIn: 0, stockOut: 0, endStock: 0 }));
  const at = key => months.find(x => x.month === key);
  if (d.paused) return [];
  const dim = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const left = (dim(y, m) - Number(today.slice(8, 10)) + 1) / dim(y, m);
  months.forEach((x, i) => { x.stockOut = Math.round(d.handover.avgStock * (i ? 1 : left) * 10) / 10; });
  // Keep the full monthly view and sales estimate, without presenting missing transport dates as zero arrivals.
  if (leadDays(d) == null) return months.map(x => ({ ...x, stockIn: null, customerIn: null, endStock: null }));
  for (const v of d.vehicles || []) { const x = v.where === 'transit' && v.category !== 'second' && v.arrive && at(v.arrive.slice(0, 7)); if (x) x[v.category === 'stock' ? 'stockIn' : 'customerIn']++; }
  for (const r of rows) {
    if (slugify(r.dealer) !== d.slug || r.group === 'dealership' || r.group === 'transport' || r.empty) continue; // Transport: in d.vehicles as transit
    const day = arrivalAtDealer(r, d, today);
    const x = day && at(day.slice(0, 7)); if (!x) continue;
    if (isStockCustomer(r.customer)) x.stockIn++; else if (r.customer) x.customerIn++;
  }
  let stock = d.yard.stock;
  months.forEach(x => { stock += x.stockIn - x.stockOut; x.endStock = Math.round(stock); });
  return months;
}

/** Every dealer now: yard, transit (incl. Transport), stock orders on the line, handovers, and how many months the stock
 *  in sight (yard + transit + line) would last at the 3-month average. Small: no vehicle lists. */
export function dealerOverview(all, rows, today) {
  const withT = withTransport(all, rows, today);
  return withT.map(d => {
    const mine = rows.filter(r => slugify(r.dealer) === d.slug);
    const line = Object.fromEntries(PIPELINE_GROUPS.map(g => [g, mine.filter(r => r.group === g && isStockCustomer(r.customer)).length]));
    const lineStock = Object.values(line).reduce((a, b) => a + b, 0);
    const lineCustomer = mine.filter(r => PIPELINE_GROUPS.includes(r.group) && r.customer && !isStockCustomer(r.customer)).length;
    const later = mine.filter(r => ['rolling', 'customers', 'later'].includes(r.group));
    const inSight = d.yard.stock + d.transit.stock + lineStock;
    const { vehicles, ...rest } = d;
    return { ...rest, line, lineStock, lineCustomer, inSight, ordersOpen: { stock: later.filter(r => isStockCustomer(r.customer)).length, customer: later.filter(r => r.customer && !isStockCustomer(r.customer)).length },
      monthsCover: d.handover.avgStock > 0 ? Math.round((inSight / d.handover.avgStock) * 10) / 10 : null, yardVsTarget: d.target == null ? null : d.yard.stock - d.target };
  });
}
