import { DEALERSHIPS, arrivalAtDealer, transitArrival, isStockCustomer, slugify, dayOf } from './dealership.mjs';
import { normalizeChassis } from './order-engine.mjs';

// These are quick filters, not the scope of Total: every dealer (including unassigned orders) is counted.
const FEATURED = ['frankston', 'geelong', 'launceston', 'st-james'];
const STAGES = ['pool', 'rolling', 'locked', 'cn', 'sea', 'au', 'transport', 'transit', 'dealership'];
const PRIORITY = Object.fromEntries(STAGES.map((s, i) => [s, i]));
const emptyStages = () => Object.fromEntries(STAGES.map(s => [s, { stock: 0, customer: 0, total: 0, stockMonths: {}, stockUndated: 0 }]));
const dealerSlug = value => {
  const slug = slugify(value);
  return slug === 'stjames' ? 'st-james' : slug;
};

/** Current new vehicles, counted once per chassis across the complete logistics flow. Production groups come from
 *  the final Orderdesk line (after rolling selection); yard / PGI use the Dealer Portal's existing categories and
 *  transit eligibility. A yard/PGI record takes precedence over a stale upstream production record. Transport is
 *  kept separate from PGI transit, unlike the combined "in transit" KPI in the existing dealer analysis. */
export function buildDealerLogistics(rows = [], { dealers: snapshot = [], today = '' } = {}) {
  const bySlug = new Map();
  const timing = new Map(DEALERSHIPS.map(d => [d.slug, d]));
  const getDealer = (slug, name) => {
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: name || slug, featured: FEATURED.includes(slug),
      stages: emptyStages(), byVehicle: { motorised: emptyStages(), towable: emptyStages() } });
    return bySlug.get(slug);
  };
  for (const d of [...snapshot, ...DEALERSHIPS]) {
    const slug = dealerSlug(d.slug);
    getDealer(slug, d.name);
    if (d.travelDays != null) timing.set(slug, d);
  }
  const vehicles = new Map();
  const consider = r => {
    const chassis = normalizeChassis(r.chassis);
    if (r.empty || !chassis) return;
    const site = r.group === 'dealership' ? r.dealerSite : null;
    const stage = site ? (site.where === 'yard' ? 'dealership' : site.where === 'transit' ? (site.via === 'transport' ? 'transport' : 'transit') : '')
      : ['customers', 'later'].includes(r.group) ? 'pool' : r.group;
    if (!STAGES.includes(stage)) return;
    const slug = dealerSlug(site?.slug || r.dealer) || 'unassigned';
    getDealer(slug, r.dealer || (slug === 'unassigned' ? 'Unassigned' : slug));
    // Second-hand downstream evidence also removes a stale upstream copy.
    const category = site?.category || (isStockCustomer(r.customer) ? 'stock' : 'customer');
    const vehicle = /^SR[MV]/.test(normalizeChassis(r.model)) || /^SR[MV]/.test(chassis) ? 'motorised' : 'towable';
    const d = timing.get(slug) || { travelDays: null };
    let arrival = '';
    if (stage === 'dealership') arrival = site?.since || ''; // actual yard receipt month
    else if (stage === 'transit') arrival = site?.arrive || (today ? transitArrival(site?.since, d, today) : '');
    else if (stage !== 'pool' && today && r.auForecast?.note !== 'overflow') arrival = arrivalAtDealer({ ...r, group: stage }, d, today);
    const day = dayOf(arrival), month = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(day) ? day.slice(0, 7) : '';
    const previous = vehicles.get(chassis);
    if (!previous || PRIORITY[stage] > PRIORITY[previous.stage]) vehicles.set(chassis, { slug, stage, category, month, vehicle });
  };
  // The production board only adds yard/PGI rows for the five self-owned dealers. Use the complete Portal snapshot
  // here so Total includes every dealer's yard and transit, with the same PGI eligibility and delivery-to overrides.
  for (const d of snapshot) for (const v of d.vehicles || []) consider({ chassis: v.chassis, model: v.model, group: 'dealership', dealer: d.name,
    dealerSite: { slug: d.slug, where: v.where, via: v.via || 'pgi', category: v.category, since: v.since, arrive: v.arrive } });
  for (const r of rows) consider(r);
  for (const { slug, stage, category, month, vehicle } of vehicles.values()) {
    if (category !== 'stock' && category !== 'customer') continue;
    const d = bySlug.get(slug);
    for (const counts of [d.stages[stage], d.byVehicle[vehicle][stage]]) {
      counts[category]++;
      counts.total++;
      if (category === 'stock') {
        if (month) counts.stockMonths[month] = (counts.stockMonths[month] || 0) + 1;
        else counts.stockUndated++;
      }
    }
  }
  const dealers = [...bySlug.values()].sort((a, b) => {
    const rank = slug => FEATURED.includes(slug) ? FEATURED.indexOf(slug) : FEATURED.length;
    return rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug);
  });
  return { dealers };
}
