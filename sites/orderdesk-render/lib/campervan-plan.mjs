// SRV / SRM (campervan) schedule, read-only from the Dealer Portal (Firebase scheduling-dd672).
// Orderdesk tracks campervan orders like caravans (new / plans / signed / PO / cancel) but they
// do not take Orderlist slots; their planned production date comes from the Portal:
//   1. motorhomeSchedule.plans.savedSchedule[SRV|SRM] (the Portal's saved schedule, by order id)
//   2. campervanSchedule[].forecastProductionDate (older campervan schedule) as a fallback.
import { normalizeChassis } from './order-engine.mjs';

export const CAMPERVAN = /^SR[VM]/;
export const isCampervan = id => CAMPERVAN.test(normalizeChassis(id));
export const PORTAL_DATABASE_URL = 'https://scheduling-dd672-default-rtdb.asia-southeast1.firebasedatabase.app';

const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(x => x && typeof x === 'object');
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Pure: chassis id -> plan, from the two Portal nodes. */
export function buildCampervanPlan(motorhomeSchedule, campervanSchedule) {
  const plan = {};
  const saved = new Map();
  for (const line of ['SRV', 'SRM']) for (const s of list(motorhomeSchedule?.plans?.savedSchedule?.[line])) if (s.orderId) saved.set(s.orderId, s);
  for (const r of list(campervanSchedule)) {
    const id = normalizeChassis(r.chassisNumber); if (!id) continue;
    plan[id] = { forecastDate: day(r.forecastProductionDate), source: 'campervanSchedule', model: r.model || '', dealer: r.dealer || '', customer: r.customer || '', productionStatus: r.regentProduction || '', signedAt: day(r.signedOrderReceived), receivedAt: day(r.requestedVehicleOrderDate), requestDate: day(r.requestedVehicleDeliveryDate), poDate: day(r['PO Date']), vinNumber: r.vinNumber || '' };
  }
  for (const o of list(motorhomeSchedule?.orders)) {
    const id = normalizeChassis(o.chassis); if (!id) continue;
    const s = saved.get(o.id);
    plan[id] = { ...(plan[id] || {}), forecastDate: s ? day(s.date) : plan[id]?.forecastDate ?? null, source: s ? 'savedSchedule' : plan[id] ? 'campervanSchedule' : 'queue', week: s?.week ?? null, scheduleModel: s?.model || '', model: o.model || plan[id]?.model || '', dealer: o.dealer || plan[id]?.dealer || '', customer: o.customerName || plan[id]?.customer || '', signedOffDate: day(o.signedOffDate), scheduleConfirmed: o.scheduleConfirmed === 'Yes', productLine: o.productLine || id.slice(0, 3), inQueue: true };
  }
  return plan;
}

/** Cached fetch of the Portal plan (public read). */
export function createCampervanPlanSource({ url = PORTAL_DATABASE_URL, ttlMs = 15 * 60 * 1000, fetcher = fetch } = {}) {
  let cache = null, inflight = null;
  async function get(path) {
    const r = await fetcher(`${url.replace(/\/+$/, '')}/${path}.json`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Portal ${path} ${r.status}`);
    return r.json();
  }
  async function load() {
    const [mh, camper] = await Promise.all([get('motorhomeSchedule'), get('campervanSchedule')]);
    cache = { at: new Date().toISOString(), portalUpdatedAt: mh?.updatedAt || null, plan: buildCampervanPlan(mh, camper) };
    return cache;
  }
  return {
    async current() {
      if (cache && Date.now() - Date.parse(cache.at) < ttlMs) return cache;
      inflight ??= load().finally(() => { inflight = null; });
      try { return await inflight; } catch (e) { if (cache) return { ...cache, stale: true, error: e.message }; throw e; }
    },
  };
}
