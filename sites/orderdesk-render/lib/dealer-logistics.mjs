import { DEALERSHIPS, isStockCustomer, slugify } from './dealership.mjs';
import { normalizeChassis } from './order-engine.mjs';

// The four dealers requested for the logistics view; the five-dealer analysis stays unchanged.
const DEALERS = DEALERSHIPS.filter(d => ['frankston', 'geelong', 'launceston', 'st-james'].includes(d.slug));
const STAGES = ['pool', 'rolling', 'locked', 'cn', 'sea', 'au', 'transport', 'transit', 'dealership'];
const PRIORITY = Object.fromEntries(STAGES.map((s, i) => [s, i]));
const dealerSlug = value => {
  const slug = slugify(value);
  return slug === 'stjames' ? 'st-james' : slug;
};

/** Current new vehicles, counted once per chassis across the complete logistics flow. Production groups come from
 *  the final Orderdesk line (after rolling selection); yard / PGI use the Dealer Portal's existing categories and
 *  transit eligibility. A yard/PGI record takes precedence over a stale upstream production record. Transport is
 *  kept separate from PGI transit, unlike the combined "in transit" KPI in the existing dealer analysis. */
export function buildDealerLogistics(rows = []) {
  const dealers = DEALERS.map(({ slug, name }) => ({ slug, name,
    stages: Object.fromEntries(STAGES.map(s => [s, { stock: 0, customer: 0, total: 0 }])) }));
  const bySlug = new Map(dealers.map(d => [d.slug, d]));
  const vehicles = new Map();
  for (const r of rows) {
    const chassis = normalizeChassis(r.chassis);
    if (r.empty || !chassis) continue;
    const site = r.group === 'dealership' ? r.dealerSite : null;
    const stage = site ? (site.where === 'yard' ? 'dealership' : site.where === 'transit' ? (site.via === 'transport' ? 'transport' : 'transit') : '')
      : ['customers', 'later'].includes(r.group) ? 'pool' : r.group;
    if (!(stage in PRIORITY)) continue;
    const slug = dealerSlug(site?.slug || r.dealer);
    // Keep out-of-scope and second-hand downstream records as exclusions too: an upstream copy must not reappear.
    const category = site?.category || (isStockCustomer(r.customer) ? 'stock' : 'customer');
    const previous = vehicles.get(chassis);
    if (!previous || PRIORITY[stage] > PRIORITY[previous.stage]) vehicles.set(chassis, { slug, stage, category });
  }
  for (const { slug, stage, category } of vehicles.values()) {
    const dealer = bySlug.get(slug);
    if (!dealer || (category !== 'stock' && category !== 'customer')) continue;
    dealer.stages[stage][category]++;
    dealer.stages[stage].total++;
  }
  return { dealers };
}
