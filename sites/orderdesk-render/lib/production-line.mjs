// Production line (产线): where each order physically is, from Longtree (China) through the sea
// leg to the Australian factory and GI. Read-only from every source:
//   Longtree      Feishu Bitable "车辆生产发运进度 / 生产海运总表" (China production + shipping dates)
//   prodReport    Regent production API (AU factory location, station, flags, station history)
//   Dealer Portal Firebase: datetrack "Received in Melbourne" (GR) and pgirecord (GI)
// Stage rule follows the Dealer Portal (planningIntegration/vehicleStatus.ts getCurrentStatus):
// the latest node that has a date decides; a vehicle the AU factory reports as received/in
// production counts as in the AU factory even before the GR date reaches datetrack.
import { normalizeChassis } from './order-engine.mjs';

export const STAGES = [
  { id: 'cnWaiting', group: 'cn', zh: 'Longtree 未开始', en: 'Not started (Longtree)' },
  { id: 'cnWelding', group: 'cn', zh: '钣焊', en: 'Chassis welding' },
  { id: 'cnAssembly', group: 'cn', zh: '总装', en: 'Assembly line' },
  { id: 'cnFinished', group: 'cn', zh: '国内完工', en: 'Finished at Longtree' },
  { id: 'cnShipped', group: 'sea', zh: '已发运', en: 'Left Longtree' },
  { id: 'seaPort', group: 'sea', zh: '等待离港', en: 'Waiting at port' },
  { id: 'seaOnWater', group: 'sea', zh: '海上', en: 'On the sea' },
  { id: 'seaArrived', group: 'sea', zh: '已到港', en: 'Arrived Melbourne port' },
  { id: 'auFactory', group: 'au', zh: '澳洲工厂', en: 'AU factory' },
  { id: 'gi', group: 'done', zh: '已 GI', en: 'GI (dispatched)' },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
const AU_LOCATIONS = new Set(['received', 'pre-assembly', 'production', 'qc', 'transport']);

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => (y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : '');
/** Calendar date of an instant in a fixed-offset or IANA zone. */
function dayIn(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** Text of a Feishu cell (string, number, [{text}], [number]). */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join('; ');
  if (typeof value === 'object') return cellText(value.text ?? value.value ?? '');
  return String(value);
}
/** A Longtree date: epoch ms (Beijing midnight), "2026-10-14 00:00", "2026.11.06", "20250105". Other text is a note. */
export function longtreeDate(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'number') return { date: dayIn(first, 'Asia/Shanghai'), note: '' };
  const text = cellText(value).replace(/\s+/g, ' ').trim();
  if (!text) return { date: '', note: '' };
  let m = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (m) return { date: iso(+m[1], +m[2], +m[3]), note: '' };
  m = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { date: iso(+m[1], +m[2], +m[3]), note: '' };
  if (/^\d{12,13}$/.test(text)) return { date: dayIn(Number(text), 'Asia/Shanghai'), note: '' };
  return { date: '', note: text };
}
const LONGTREE_FIELDS = {
  orderAt: '订单接收日期', weldAt: '钣焊上线日期', furnitureAt: '家具上线日期', assemblyAt: '总装上线日期', finishedAt: '总装入库日期',
  shippedAt: '发运日期', etd: '预计离港日期', atd: '实际离港日期', eta: '预计到港日期', ata: '实际到港日期',
};
/** Feishu records → Map chassis → dates. Duplicate chassis rows merge; a later row (higher 序号) wins per field. */
export function parseLongtree(records) {
  const out = new Map();
  const sorted = [...(records || [])].sort((a, b) => Number(cellText(a?.fields?.['序号'])) - Number(cellText(b?.fields?.['序号'])));
  for (const record of sorted) {
    const f = record?.fields || {};
    const chassis = normalizeChassis(cellText(f['车架号']));
    if (!chassis) continue;
    const row = out.get(chassis) || { chassis, model: '', notes: {} };
    const model = cellText(f['车型']).trim(); if (model) row.model = model;
    for (const [field, name] of Object.entries(LONGTREE_FIELDS)) {
      if (!(name in f)) continue;
      const { date, note } = longtreeDate(f[name]);
      if (date) { row[field] = date; delete row.notes[field]; } else if (note) row.notes[field] = note;
    }
    out.set(chassis, row);
  }
  return out;
}
const seconds = v => (v && typeof v === 'object' && Number.isFinite(Number(v._seconds)) ? Number(v._seconds) * 1000 : NaN);
const sydneyDay = v => dayIn(seconds(v), 'Australia/Sydney');
const sydneyTime = v => { const ms = seconds(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; };
/** prodReport rows → Map chassis → AU factory position. */
export function parseProdReport(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const chassis = normalizeChassis(r?.chassis || r?.id);
    if (!chassis) continue;
    const history = (Array.isArray(r.stageHistory) ? r.stageHistory : []).map(h => ({ stage: String(h?.stage || ''), location: String(h?.location || ''), at: sydneyTime(h?.enteredAt) })).filter(h => h.at);
    const last = history.at(-1);
    out.set(chassis, {
      chassis, location: String(r.location || '').trim(), station: String(r.stage || '').trim(),
      flags: Array.isArray(r.status) ? r.status.map(String) : [],
      enteredAt: sydneyDay(r.entryDate), movedAt: sydneyTime(r.moveDate), stationSince: last?.at || sydneyTime(r.moveDate),
      forecastAt: sydneyDay(r.forecastDate), productionAt: sydneyDay(r.productionDate), calculatedAt: sydneyDay(r.calculateDate),
      history,
    });
  }
  return out;
}
const portalDay = text => { const m = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? iso(+m[3], +m[2], +m[1]) : ''; };
/** Dealer Portal datetrack + pgirecord → Map chassis → {grAt, giAt}. 01/01/1970 placeholders are ignored. */
export function parsePortal(datetrack, pgirecord) {
  const out = new Map();
  const get = c => out.get(c) || out.set(c, { grAt: '', giAt: '' }).get(c);
  for (const [k, v] of Object.entries(datetrack || {})) {
    if (!v || typeof v !== 'object') continue;
    const c = normalizeChassis(v['Chassis Number'] || k); if (!c) continue;
    const gr = portalDay(v['Received in Melbourne']); if (gr > '1971') get(c).grAt = gr;
  }
  for (const [k, v] of Object.entries(pgirecord || {})) {
    if (!v || typeof v !== 'object') continue;
    const c = normalizeChassis(k); if (!c) continue;
    const row = get(c);
    const gi = portalDay(v.pgidate); if (gi > '1971') row.giAt = gi;
    const gr = portalDay(v.grDateLast); if (!row.grAt && gr > '1971') row.grAt = gr;
  }
  return out;
}

const daysBetween = (from, to) => (from && to ? Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86400000) : null);

/** Stage of one vehicle, Portal rule order (latest node first). */
export function stageOf(order, lt = {}, au, portal = {}, today) {
  const past = d => (d && d <= today ? d : '');
  if (past(portal.giAt)) return { stage: 'gi', since: portal.giAt };
  if (past(portal.grAt) || (au && AU_LOCATIONS.has(au.location.toLowerCase()))) return { stage: 'auFactory', since: past(portal.grAt) || au?.enteredAt || '' };
  if (past(lt.ata)) return { stage: 'seaArrived', since: lt.ata };
  if (past(lt.atd)) return { stage: 'seaOnWater', since: lt.atd };
  if (past(lt.shippedAt) && lt.etd) return { stage: 'seaPort', since: lt.shippedAt };
  if (past(lt.shippedAt)) return { stage: 'cnShipped', since: lt.shippedAt };
  if (past(lt.finishedAt)) return { stage: 'cnFinished', since: lt.finishedAt };
  if (past(lt.assemblyAt)) return { stage: 'cnAssembly', since: lt.assemblyAt };
  if (past(lt.weldAt)) return { stage: 'cnWelding', since: lt.weldAt };
  return { stage: 'cnWaiting', since: order.purchaseAt || order.signedAt || '' };
}

/**
 * Merge orders with the three sources. Orders not yet signed are left out (they are not on the
 * line); GI'd vehicles are counted, and only those GI'd within `recentGiDays` are listed.
 */
export function buildProductionLine({ orders, longtree, prod, portal, today, recentGiDays = 14 }) {
  const rows = [];
  const counts = Object.fromEntries(STAGES.map(s => [s.id, 0]));
  let unsigned = 0;
  for (const order of Object.values(orders || {})) {
    if (!order || order.status === 'cancelled') continue;
    const chassis = normalizeChassis(order.chassis);
    const lt = longtree.get(chassis), au = prod.get(chassis), p = portal.get(chassis) || {};
    const onLine = order.signedAt || order.purchaseAt || lt?.weldAt || lt?.assemblyAt || au || p.grAt || p.giAt;
    if (!onLine) { unsigned++; continue; }
    const { stage, since } = stageOf(order, lt, au, p, today);
    counts[stage]++;
    if (stage === 'gi' && daysBetween(p.giAt, today) > recentGiDays) continue;
    rows.push({
      id: chassis, chassis: order.chassis, model: order.model || lt?.model || '', dealer: order.dealer || '', customer: order.customer || '',
      stage, stageIndex: STAGE_INDEX[stage], since, daysInStage: daysBetween(since, today),
      signedAt: order.signedAt || '', forecastDate: order.forecastDate || '',
      cn: lt ? { orderAt: lt.orderAt || '', weldAt: lt.weldAt || '', furnitureAt: lt.furnitureAt || '', assemblyAt: lt.assemblyAt || '', finishedAt: lt.finishedAt || '', shippedAt: lt.shippedAt || '', notes: lt.notes } : null,
      sea: lt ? { etd: lt.etd || '', atd: lt.atd || '', eta: lt.eta || '', ata: lt.ata || '' } : null,
      au: au ? { location: au.location, station: au.station, flags: au.flags, enteredAt: au.enteredAt, stationSince: au.stationSince, daysAtStation: daysBetween(au.stationSince, today), forecastAt: au.forecastAt, history: au.history } : null,
      grAt: p.grAt || '', giAt: p.giAt || '', grToToday: p.grAt && !p.giAt ? daysBetween(p.grAt, today) : null,
    });
  }
  rows.sort((a, b) => b.stageIndex - a.stageIndex || String(a.since || '9999').localeCompare(String(b.since || '9999')));
  return { today, counts, unsigned, rows };
}

// ---- live sources (server side) ---------------------------------------------------------------
const FEISHU = 'https://open.feishu.cn/open-apis';
async function feishuRecords(env, fetcher) {
  const r = await fetcher(`${FEISHU}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: env.LONGTREE_APP_ID, app_secret: env.LONGTREE_APP_SECRET }), signal: AbortSignal.timeout(30000) });
  const auth = await r.json().catch(() => ({}));
  if (!r.ok || auth.code !== 0) throw new Error(`Longtree login failed (${auth.code ?? r.status})`);
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, Accept: 'application/json' };
  const call = async (path, params = {}) => {
    const res = await fetcher(`${FEISHU}${path}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(90000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.code !== 0) throw new Error(`Longtree ${path.split('/').slice(0, 4).join('/')} failed (${body.code ?? res.status})`);
    return body.data;
  };
  const app = (await call('/wiki/v2/spaces/get_node', { token: env.LONGTREE_WIKI_TOKEN || 'D8AmwXGMxieF9Ek3mPIcigYLnIg' })).node.obj_token;
  const table = env.LONGTREE_TABLE_ID || (await call(`/bitable/v1/apps/${app}/tables`, { page_size: 100 })).items?.[0]?.table_id;
  if (!table) throw new Error('Longtree table not found');
  const items = []; let token = '';
  for (let page = 0; page < 200; page++) {
    const data = await call(`/bitable/v1/apps/${app}/tables/${table}/records`, { page_size: 500, ...(token ? { page_token: token } : {}) });
    items.push(...(data.items || []));
    if (!data.has_more) return items;
    if (!data.page_token || data.page_token === token) throw new Error('Longtree pagination stopped');
    token = data.page_token;
  }
  throw new Error('Longtree has too many pages');
}
const PROD_BASE = 'https://australia-southeast1-rrvps-98af0.cloudfunctions.net';
async function prodReportRows(env, fetcher) {
  const r = await fetcher(`${env.PROD_REPORT_BASE || PROD_BASE}/getAuthToken`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: env.PROD_REPORT_EMAIL, password: env.PROD_REPORT_PASSWORD }), signal: AbortSignal.timeout(60000) });
  const auth = await r.json().catch(() => ({}));
  const token = auth?.data?.idToken;
  if (!r.ok || !token) throw new Error(`Production login failed (${r.status})`);
  const res = await fetcher(`${env.PROD_REPORT_BASE || PROD_BASE}/prodReport`, { redirect: 'manual', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body?.data)) throw new Error(`Production report failed (${res.status})`);
  return body.data;
}
async function portalNodes(url, fetcher) {
  const get = async path => { const r = await fetcher(`${url}/${encodeURIComponent(path)}.json`, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`Portal ${path} ${r.status}`); return r.json(); };
  const [datetrack, pgirecord] = await Promise.all([get('datetrack'), get('pgirecord')]);
  return { datetrack, pgirecord };
}

/** Cached sources; each source keeps its last good copy when a refresh fails. */
export function createProductionLineSource(env = {}, { fetcher = fetch, ttlMs = 15 * 60 * 1000, portalUrl = 'https://scheduling-dd672-default-rtdb.asia-southeast1.firebasedatabase.app' } = {}) {
  const sources = {
    longtree: { configured: Boolean(env.LONGTREE_APP_ID && env.LONGTREE_APP_SECRET), load: async () => parseLongtree(await feishuRecords(env, fetcher)) },
    prod: { configured: Boolean(env.PROD_REPORT_EMAIL && env.PROD_REPORT_PASSWORD), load: async () => parseProdReport(await prodReportRows(env, fetcher)) },
    portal: { configured: true, load: async () => { const n = await portalNodes((env.PORTAL_DATABASE_URL || portalUrl).replace(/\/+$/, ''), fetcher); return parsePortal(n.datetrack, n.pgirecord); } },
  };
  const state = Object.fromEntries(Object.keys(sources).map(k => [k, { data: new Map(), at: '', error: '', count: 0 }]));
  let inflight = null, loadedAt = 0;
  async function refresh() {
    await Promise.all(Object.entries(sources).map(async ([name, s]) => {
      if (!s.configured) { state[name].error = 'not configured'; return; }
      try { const data = await s.load(); state[name] = { data, at: new Date().toISOString(), error: '', count: data.size }; }
      catch (e) { state[name] = { ...state[name], error: e instanceof Error ? e.message : String(e) }; }
    }));
    loadedAt = Date.now();
  }
  return {
    // First load waits; later a stale copy is returned at once and refreshed in the background.
    async current({ force = false } = {}) {
      const stale = !loadedAt || Date.now() - loadedAt > ttlMs;
      if (force || stale) inflight ??= refresh().finally(() => { inflight = null; });
      if (force || !loadedAt) await inflight;
      return { refreshing: Boolean(inflight), longtree: state.longtree.data, prod: state.prod.data, portal: state.portal.data, status: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { at: v.at, error: v.error, count: v.count, configured: sources[k].configured }])) };
    },
  };
}
