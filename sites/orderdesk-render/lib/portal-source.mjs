// One shared, read-only copy of the Dealer Portal nodes the production board needs (~11–12 MB per
// read, billed to the Portal's Firebase). Used by the SRV/SRM plan and the production-line page.
// Read only when someone opens a page and the copy is older than the interval; a stale copy is
// served at once while a new one loads; a failed read keeps the last good copy.
import { PORTAL_BOARD_SOURCES, PORTAL_DATABASE_URL } from './campervan-plan.mjs';

export const PORTAL_TTL_MS = 2 * 60 * 60 * 1000;
// GR / GI come from SAP directly (sap-grgi.mjs). tmssystem = the Portal's Vessel movements & ETA
// (container / vessel / ETA per chassis, ~2.4 MB), shown on the production line.
export const PORTAL_EXTRA_SOURCES = [['tms', 'tmssystem'], ['dispatchPlan', 'productionDispatchPlanning'], ['mhPlan2026', 'motorhomeSchedule/plans/2026'], ['mhPlan2027', 'motorhomeSchedule/plans/2027']];

export function createPortalSource({ url = PORTAL_DATABASE_URL, ttlMs = PORTAL_TTL_MS, fetcher = fetch } = {}) {
  const base = url.replace(/\/+$/, '');
  let copy = null, inflight = null, error = '';
  async function get(path) {
    const r = await fetcher(`${base}/${path.split('/').map(encodeURIComponent).join('/')}.json`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Portal ${path} ${r.status}`);
    return r.json();
  }
  async function load() {
    try {
      const raw = Object.fromEntries(await Promise.all([...PORTAL_BOARD_SOURCES, ...PORTAL_EXTRA_SOURCES].map(async ([name, path]) => [name, await get(path)])));
      copy = { at: new Date().toISOString(), raw }; error = '';
    } catch (e) { error = e instanceof Error ? e.message : String(e); if (!copy) throw e; }
    return copy;
  }
  return {
    async current({ force = false } = {}) {
      const stale = !copy || Date.now() - Date.parse(copy.at) > ttlMs;
      if (force || stale) inflight ??= load().finally(() => { inflight = null; });
      if (force || !copy) await inflight;
      return { ...copy, error, refreshing: Boolean(inflight) };
    },
  };
}
