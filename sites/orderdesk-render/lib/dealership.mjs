// Our five dealerships (the Dealer Portal's "Self-owned" dealers): new stock in the yard, vans in transit and handovers,
// replicating the Dealer Portal admin page (src/pages/Admin.tsx: yard categories, transit rule) and the dealer comparison
// dashboard (src/pages/ModernDealerComparisonDashboard.tsx: YTD Handover, stock / customer by the Orderlist customer name).
// From these: how many stock vans each dealership still needs, and the rolling line (180) made of their customer orders
// first, then that stock. Read-only; nothing is written to the Portal.

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
export const ROLLING_SIZE = 180;
export const HANDOVER_MONTHS = 3; // average over the last 3 completed months
const TRANSIT_MAX_DAYS = 100; // Portal: a PGI older than 100 days no longer counts as in transit
const PIPELINE_GROUPS = ['transport', 'au', 'sea', 'cn', 'locked'];

/** Extra Portal nodes (2-hourly with the Portal copy): all yards (a van in any yard is not in transit), the delivery-to
 *  overrides, and the handovers of the five dealerships only. pgirecord and schedule are already in the copy. */
export const PORTAL_DEALER_SOURCES = [['yard', 'yardstock'], ['deliveryTo', 'deliveryToAssignments'], ...DEALERSHIPS.map(d => [`handover_${d.slug}`, `handover/${d.slug}`])];

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

/** The five dealerships as the Dealer Portal shows them today. */
export function dealerSnapshot(raw, today) {
  const yards = raw?.yard || {}, pgi = raw?.pgi || {}, assignments = raw?.deliveryTo || {};
  const customerType = new Map(); // Orderlist customer name: "... Stock" = stock, else customer (handover classification)
  for (const r of listOf(raw?.schedule)) { const c = norm(r?.Chassis), cu = String(r?.Customer ?? '').trim(); if (c && cu) customerType.set(c, isStockCustomer(cu) ? 'stock' : 'customer'); }
  const inAnyYard = new Set();
  for (const stock of Object.values(yards)) for (const c of Object.keys(stock || {})) if (c !== 'dealer-chassis') inAnyYard.add(c.trim().toUpperCase());
  const delivery = new Map(Object.entries(assignments).map(([c, a]) => [c.trim().toUpperCase(), a || {}]));
  const effectiveDealer = (chassis, rec) => {
    const a = delivery.get(chassis) || {}, src = slugify(a.sourceDealerSlug), own = slugify(rec.dealer);
    if (src && own && own !== src) return own;
    return slugify(a.deliveryTo) || (own === 'green-show' ? 'forest-glen' : own);
  };
  const months = monthsBefore(today, HANDOVER_MONTHS), thisMonth = today.slice(0, 7);
  return DEALERSHIPS.map(d => {
    const yardRows = Object.entries(yards[d.slug] || {}).filter(([c, r]) => c !== 'dealer-chassis' && r && !r.history)
      .map(([c, r]) => { const since = dayOf(r.receivedAt ?? r.createdAt ?? r.movementDate); return { chassis: String(r.chassis || r.Chassis || c).trim(), where: 'yard', category: yardCategory(r), model: String(r.model || ''), customer: String(r.customer || ''), since, days: daysBetween(since, today) }; });
    const handovers = Object.entries(raw?.[`handover_${d.slug}`] || {}).map(([c, r]) => ({ chassis: c, ...(r || {}) }));
    const handedOver = new Set(handovers.map(h => h.chassis.trim().toUpperCase()));
    const transit = Object.entries(pgi).filter(([, r]) => r && !r.history).flatMap(([c, r]) => {
      const chassis = c.trim().toUpperCase(), day = dayOf(r.pgidate), days = daysBetween(day, today) ?? 0;
      if (!chassis || effectiveDealer(chassis, r) !== d.slug || days > TRANSIT_MAX_DAYS || inAnyYard.has(chassis) || handedOver.has(chassis)) return [];
      return [{ chassis: c.trim(), where: 'transit', category: yardCategory(r, Boolean(String(r.wholesaleBillToName ?? r.WholesaleBillToName ?? '').trim())), model: String(r.model || r.materialCode || ''), customer: String(r.customer || ''), since: day, days, arrive: transitArrival(day, d, today) }];
    });
    const monthly = new Map();
    for (const h of handovers) {
      const m = dayOf(h.handoverAt ?? h.createdAt).slice(0, 7); if (!m) continue;
      const x = monthly.get(m) || { month: m, stock: 0, customer: 0, second: 0 };
      if (secondHandHandover(h)) x.second++; else x[customerType.get(norm(h.chassis)) || 'stock']++;
      monthly.set(m, x);
    }
    const last = months.map(m => monthly.get(m) || { month: m, stock: 0, customer: 0, second: 0 });
    const avg = k => Math.round((last.reduce((s, x) => s + x[k], 0) / HANDOVER_MONTHS) * 10) / 10;
    const count = (list, cat) => list.filter(r => r.category === cat).length;
    return { ...d, yard: { stock: count(yardRows, 'stock'), customer: count(yardRows, 'customer'), second: count(yardRows, 'second'), total: yardRows.length },
      transit: { stock: count(transit, 'stock'), customer: count(transit, 'customer'), second: count(transit, 'second'), total: transit.length },
      handover: { months: last, thisMonth: monthly.get(thisMonth) || { month: thisMonth, stock: 0, customer: 0, second: 0 }, avgStock: avg('stock'), avgCustomer: avg('customer'), avgSecond: avg('second') },
      vehicles: [...yardRows, ...transit] };
  });
}

/** Stock each dealership still needs when the rolling line's vans reach it. `rollingEnd` = AU finish of the last
 *  rolling-line place; the dealer gets it `leadDays` later (= deliveredBy). By then:
 *  stock = yard stock + transit stock arriving by then (PGI + travel days) + stock vans from Transport → locked that arrive by then (AU finish + lead)
 *          − average stock handovers per month × months until then;  need = target − stock. */
export function dealerNeeds(snapshot, rows, today, rollingEnd) {
  return snapshot.map(d => {
    const mine = rows.filter(r => slugify(r.dealer) === d.slug && PIPELINE_GROUPS.includes(r.group));
    const pipeline = Object.fromEntries(PIPELINE_GROUPS.map(g => [g, mine.filter(r => r.group === g && isStockCustomer(r.customer)).length]));
    const pipelineStock = Object.values(pipeline).reduce((a, b) => a + b, 0);
    const pipelineCustomer = mine.filter(r => !isStockCustomer(r.customer) && r.customer).length;
    const base = { slug: d.slug, lead: leadDays(d), pipeline, pipelineStock, pipelineCustomer };
    if (d.paused) return { ...base, paused: true, deliveredBy: '', months: 0, arriving: 0, transitArriving: 0, sold: 0, projected: null, need: 0 };
    const deliveredBy = plusDays(rollingEnd, leadDays(d));
    const months = Math.max(0, (Date.parse(deliveredBy) - Date.parse(today)) / 86400000 / (365.25 / 12));
    const arriving = mine.filter(r => isStockCustomer(r.customer) && (a => a && a <= deliveredBy)(arrivalAtDealer(r, d, today))).length;
    const transitArriving = (d.vehicles || []).filter(v => v.where === 'transit' && v.category === 'stock' && v.arrive && v.arrive <= deliveredBy).length;
    const sold = Math.round(d.handover.avgStock * months);
    const projected = d.yard.stock + transitArriving + arriving - sold;
    return { ...base, deliveredBy, months: Math.round(months * 10) / 10, arriving, transitArriving, sold, projected, need: Math.max(0, d.target - projected) };
  });
}

/** Rolling line: the five dealerships' customer orders first (Orderlist order), then each one's stock need from its
 *  own stock orders; at most `size`. Returns the picked rows in order and, per dealer, how much stock was picked. */
export function pickRolling(rows, needs, size = ROLLING_SIZE) {
  const slugs = new Set(DEALERSHIPS.map(d => d.slug));
  const open = rows.filter(r => (r.group === 'later' || r.group === 'customers') && !r.empty && slugs.has(slugify(r.dealer)));
  const byOrder = (a, z) => (a.orderRow ?? 1e9) - (z.orderRow ?? 1e9) || (a.forecast || '9999').localeCompare(z.forecast || '9999') || a.chassis.localeCompare(z.chassis);
  const customers = open.filter(r => r.customer && !isStockCustomer(r.customer)).sort(byOrder).map(r => ({ r, kind: 'customer' }));
  const stock = needs.filter(n => !n.paused).flatMap(n => open.filter(r => slugify(r.dealer) === n.slug && isStockCustomer(r.customer)).sort(byOrder).slice(0, n.need).map(r => ({ r, kind: 'stock' })))
    .sort((a, z) => byOrder(a.r, z.r));
  const picked = [...customers, ...stock].slice(0, size);
  const stockPicked = Object.fromEntries(DEALERSHIPS.map(d => [d.slug, picked.filter(p => p.kind === 'stock' && slugify(p.r.dealer) === d.slug).length]));
  const stockAvailable = Object.fromEntries(DEALERSHIPS.map(d => [d.slug, open.filter(r => slugify(r.dealer) === d.slug && isStockCustomer(r.customer)).length]));
  return { picked, stockPicked, stockAvailable, customers: customers.length };
}

/** Month by month for one dealership (this month + the next `count` − 1): vans expected to arrive (stock / customer),
 *  stock handovers at the 3-month average, and stock at the end of the month.
 *  Arrival = expected AU finish (Transport: today) + 3 + travel days; transit: PGI + travel days. Paused dealers: none. */
export function dealerMonthly(d, rows, today, count = 8) {
  const [y, m] = today.split('-').map(Number);
  const keys = Array.from({ length: count }, (_, i) => { const x = new Date(Date.UTC(y, m - 1 + i, 1)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`; });
  const months = keys.map(month => ({ month, stockIn: 0, customerIn: 0, stockOut: 0, endStock: 0 }));
  const at = key => months.find(x => x.month === key);
  if (d.paused || leadDays(d) == null) return [];
  for (const v of d.vehicles || []) { const x = v.where === 'transit' && v.category !== 'second' && v.arrive && at(v.arrive.slice(0, 7)); if (x) x[v.category === 'stock' ? 'stockIn' : 'customerIn']++; }
  for (const r of rows) {
    if (slugify(r.dealer) !== d.slug || r.group === 'dealership' || r.empty) continue;
    const day = arrivalAtDealer(r, d, today);
    const x = day && at(day.slice(0, 7)); if (!x) continue;
    if (isStockCustomer(r.customer)) x.stockIn++; else if (r.customer) x.customerIn++;
  }
  const dim = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const left = (dim(y, m) - Number(today.slice(8, 10)) + 1) / dim(y, m);
  let stock = d.yard.stock;
  months.forEach((x, i) => { x.stockOut = Math.round(d.handover.avgStock * (i ? 1 : left) * 10) / 10; stock += x.stockIn - x.stockOut; x.endStock = Math.round(stock); });
  return months;
}
