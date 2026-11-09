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

// The same nine nodes the Portal's production-planning board subscribes to (useProductionBoardData.ts).
export const PORTAL_BOARD_SOURCES = [
  ['motorhome', 'motorhomeSchedule'], ['schedule', 'schedule'], ['campers', 'campervanSchedule'], ['dateTrack', 'dateTrack'], ['datetrack', 'datetrack'],
  ['uploaded', 'planningTargets/uploadedScheduleBilingual'], ['preferences', 'motorhomeSchedulePreferences'], ['production', 'production status'], ['pgi', 'pgirecord'],
];

/** Run the Portal's own board code (vendor/portal) and overlay its SRV/SRM dates on the plan. */
export function applyPortalBoard(plan, board) {
  const out = { ...plan };
  for (const row of board.rows || []) {
    const id = normalizeChassis(row.chassis); if (!CAMPERVAN.test(id)) continue;
    out[id] = { ...(out[id] || {}), forecastDate: day(row.auPlanStart) || null, expectedStart: day(row.auStart) || null, actualStart: day(row.auActual) || null,
      boardGroup: row.group, boardStatus: row.production?.status || row.status || '', source: 'portal-board' };
  }
  return out;
}

/** Cached fetch of the Portal data (public read) + the Portal's own scheduling code. */
export function createCampervanPlanSource({ url = PORTAL_DATABASE_URL, ttlMs = 15 * 60 * 1000, fetcher = fetch, board = loadPortalBoard(), portal = null } = {}) {
  let cache = null, inflight = null;
  const base = url.replace(/\/+$/, '');
  async function get(path) {
    const r = await fetcher(`${base}/${path.split('/').map(encodeURIComponent).join('/')}.json`, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`Portal ${path} ${r.status}`);
    return r.json();
  }
  async function load() {
    // With a shared Portal copy (portal-source.mjs) the nodes are read once for every page.
    const raw = portal ? (await portal.current()).raw : Object.fromEntries(await Promise.all(PORTAL_BOARD_SOURCES.map(async ([name, path]) => [name, await get(path)])));
    let plan = buildCampervanPlan(raw.motorhome, raw.campers), boardError = null;
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
      const mod = await board;
      plan = applyPortalBoard(plan, mod.buildProductionBoard(mod.boardVehiclesFromSources(raw, today), mod.DEFAULT_BOARD_SETTINGS, today));
    } catch (e) { boardError = e instanceof Error ? e.message : String(e); }
    cache = { at: new Date().toISOString(), portalUpdatedAt: raw.motorhome?.updatedAt || null, plan, ...(boardError ? { boardError } : {}) };
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

export async function loadPortalBoard() {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../vendor/portal/portal-board.cjs');
}
