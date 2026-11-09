// Production line (产线): where each order physically is, from Longtree (China) through the sea
// leg to the Australian factory and GI. Read-only from every source:
//   Longtree      Feishu Bitable "车辆生产发运进度 / 生产海运总表" (China production + shipping dates)
//   prodReport    Regent production API (AU factory location, station, flags, station history)
//   Dealer Portal Firebase: datetrack "Received in Melbourne" (GR) and pgirecord (GI)
// Stage rule follows the Dealer Portal (planningIntegration/vehicleStatus.ts getCurrentStatus):
// the latest node that has a date decides; a vehicle the AU factory reports as received/in
// production counts as in the AU factory even before the GR date reaches datetrack.
import { normalizeChassis } from './order-engine.mjs';
import { loadPortalBoard } from './campervan-plan.mjs';
import { mergeGrGi } from './sap-grgi.mjs';

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
/**
 * GR / GI per chassis. GR: SAP goods receipt at plant 3111 from the Portal TMS containers
 * (sap.grDate3111) first, then DateTrack "Received in Melbourne", then pgirecord grDateLast.
 * GI: pgirecord pgidate. Without a GR the TMS container status says why (in transit, GR pending…).
 * 01/01/1970 placeholders are ignored.
 */
export function parsePortal(datetrack, pgirecord, tmsContainers) {
  const out = new Map();
  const get = c => out.get(c) || out.set(c, { grAt: '', grSource: '', giAt: '', tmsStatus: '', container: '' }).get(c);
  for (const c of Object.values(tmsContainers || {})) {
    if (!c || typeof c !== 'object') continue;
    const gr = portalDay(c.sap?.grDate3111);
    for (const ch of Array.isArray(c.chassisNumbers) ? c.chassisNumbers : []) {
      const k = normalizeChassis(ch); if (!k) continue;
      const row = get(k);
      if (gr > '1971' && gr > row.grAt) { row.grAt = gr; row.grSource = 'TMS'; row.container = String(c.containerNumber || ''); }
      if (!row.grAt) { row.tmsStatus = String(c.status || ''); row.container = String(c.containerNumber || ''); }
    }
  }
  for (const [k, v] of Object.entries(datetrack || {})) {
    if (!v || typeof v !== 'object') continue;
    const c = normalizeChassis(v['Chassis Number'] || k); if (!c) continue;
    const gr = portalDay(v['Received in Melbourne']);
    if (gr > '1971' && !get(c).grAt) { get(c).grAt = gr; get(c).grSource = 'DateTrack'; }
  }
  for (const [k, v] of Object.entries(pgirecord || {})) {
    if (!v || typeof v !== 'object') continue;
    const c = normalizeChassis(k); if (!c) continue;
    const row = get(c);
    const gi = portalDay(v.pgidate); if (gi > '1971') { row.giAt = gi; row.giSource = 'pgirecord'; }
    const gr = portalDay(v.grDateLast); if (gr > '1971' && !row.grAt) { row.grAt = gr; row.grSource = 'pgirecord'; }
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
 * The production line is the Dealer Portal production board (same code, same groups, plan dates,
 * MRP dates and delay as the Portal page), with live facts added per vehicle: Longtree node dates,
 * the AU factory's current location/station, SAP GR/GI and the Orderdesk order.
 */
export const BOARD_GROUPS = [
  { id: 'au', band: 'execution', zh: '澳洲生产', en: 'AU production', note: '澳洲工厂车辆 · 实际上线取 Production Start，不将到厂日期当作上线日期。', phase: 'au' },
  { id: 'sea', band: 'execution', zh: '海运', en: 'Shipping', note: '国内出厂至澳洲工厂接收 · 包括港口等待、海运及入厂前转运。', phase: 'sea' },
  { id: 'cn', band: 'execution', zh: '国内生产', en: 'China production', note: '国内已上线车辆 · 从底盘焊接、总装到国内完工。', phase: 'cn' },
  { id: 'locked', band: 'scheduling', zh: '排产锁定线', en: 'Locked', note: '已确认待上线 · 仅以现有 Schedule Confirmed = Yes 判断锁定。' },
  { id: 'rolling', band: 'scheduling', zh: '滚动排产线', en: 'Rolling', note: '滚动安排待确认 · 不根据日期自动改写确认状态。' },
  { id: 'empty', band: 'preschedule', zh: 'Empty slots', en: 'Empty slots', note: '现有 SRV / SRM 未分配 slot · 原数据没有 Dealer 时明确显示待分配。' },
  { id: 'customers', band: 'preschedule', zh: 'Customer 订单池', en: 'Customer pool', note: '客户订单独立成池，Stock 不进入 Customer 订单池。' },
  { id: 'later', band: 'later', zh: '后续排产 / 日期待补', en: 'Later / dates missing', note: '国内计划上线在 60 天之后的车，或计划日期待补。' },
];
export function buildProductionLine({ board, orders, longtree, prod, portal, today, settings }) {
  const orderByChassis = new Map(Object.values(orders || {}).filter(o => o && o.status !== 'cancelled').map(o => [normalizeChassis(o.chassis), o]));
  const counts = Object.fromEntries(BOARD_GROUPS.map(g => [g.id, 0]));
  const rows = [];
  for (const b of board.rows) {
    counts[b.group] = (counts[b.group] || 0) + 1;
    const chassis = b.empty ? '' : normalizeChassis(b.chassis);
    const order = chassis ? orderByChassis.get(chassis) : undefined;
    const lt = chassis ? longtree.get(chassis) : undefined, au = chassis ? prod.get(chassis) : undefined, p = (chassis && portal.get(chassis)) || {};
    const live = chassis ? stageOf(order || {}, lt, au, p, today) : null;
    rows.push({
      id: b.id, chassis: b.chassis || '', empty: Boolean(b.empty), line: b.line || '', source: b.source || '', group: b.group, status: b.status || '',
      dealer: b.dealer || '', model: b.model || '', range: b.range || '', customer: order?.customer || b.customer || '', orderId: order ? chassis : '',
      production: b.production ? { status: b.production.status || '', stage: b.production.stage || '', location: b.production.location || '' } : null,
      cnActual: b.cnActual, cnStart: b.cnStart, cnPlanStart: b.cnPlanStart, cnPlanEnd: b.cnPlanEnd, auActual: b.auActual, auStart: b.auStart, auPlanStart: b.auPlanStart, auPlanEnd: b.auPlanEnd,
      planStart: b.planStart, planEnd: b.planEnd, expectedEnd: b.expectedEnd, delay: b.delay, cnMrp: b.cnMrp, auMrp: b.auMrp, overdue: Boolean(b.overdue), locked: Boolean(b.locked), warnings: b.warnings || [],
      live: live && {
        stage: live.stage, since: live.since, days: daysBetween(live.since, today),
        inLongtree: Boolean(lt), orderAt: lt?.orderAt || '', weldAt: lt?.weldAt || '', furnitureAt: lt?.furnitureAt || '', assemblyAt: lt?.assemblyAt || '', finishedAt: lt?.finishedAt || '', shippedAt: lt?.shippedAt || '',
        etd: lt?.etd || '', atd: lt?.atd || '', eta: lt?.eta || '', ata: lt?.ata || '', notes: lt?.notes || {},
        grAt: p.grAt || '', grSource: p.grSource || '', po: p.po || '', giAt: p.giAt || '', giSource: p.giSource || '', giDoc: p.giDoc || '', tmsStatus: p.tmsStatus || '', container: p.container || '',
        inProduction: Boolean(au), location: au?.location || '', station: au?.station || '', flags: au?.flags || [], enteredAt: au?.enteredAt || '', stationSince: au?.stationSince || '', daysAtStation: au ? daysBetween(au.stationSince, today) : null, history: au?.history || [],
      },
    });
  }
  return { today, counts, completed: board.completed, averages: board.averages, settings, rows };
}

// ---- live sources (server side) ---------------------------------------------------------------
const FEISHU = 'https://open.feishu.cn/open-apis';
async function feishuRecords(env, fetcher, retryDelayMs = 1500) {
  const r = await fetcher(`${FEISHU}/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: env.LONGTREE_APP_ID, app_secret: env.LONGTREE_APP_SECRET }), signal: AbortSignal.timeout(30000) });
  const auth = await r.json().catch(() => ({}));
  if (!r.ok || auth.code !== 0) throw new Error(`Longtree login failed (${auth.code ?? r.status})`);
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}`, Accept: 'application/json' };
  // Feishu sometimes answers "busy / data not ready" (e.g. 1254607, 1254290, HTTP 429/5xx); retry a few times.
  const call = async (path, params = {}) => {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
      const res = await fetcher(`${FEISHU}${path}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(90000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.code === 0) return body.data;
      last = String(body.code ?? res.status);
      if (res.status === 401 || res.status === 403 || [99991663, 99991668, 91402, 1254302].includes(body.code)) break; // auth/permission: no point retrying
    }
    throw new Error(`Longtree ${path.split('/').slice(0, 4).join('/')} failed (${last})`);
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
/** Cached sources; each keeps its last good copy when a refresh fails. Portal comes from the shared copy. */
export const SOURCE_TTL_MS = { longtree: 30 * 60 * 1000, prod: 15 * 60 * 1000 };
export function createProductionLineSource(env = {}, { fetcher = fetch, ttlMs = SOURCE_TTL_MS, portal, board = loadPortalBoard(), sap = null } = {}) {
  const sources = {
    longtree: { configured: Boolean(env.LONGTREE_APP_ID && env.LONGTREE_APP_SECRET), load: async () => parseLongtree(await feishuRecords(env, fetcher)) },
    prod: { configured: Boolean(env.PROD_REPORT_EMAIL && env.PROD_REPORT_PASSWORD), load: async () => parseProdReport(await prodReportRows(env, fetcher)) },
  };
  const state = Object.fromEntries(Object.keys(sources).map(k => [k, { data: new Map(), at: '', error: '', count: 0 }]));
  const ttl = name => (typeof ttlMs === 'number' ? ttlMs : ttlMs[name] ?? 15 * 60 * 1000);
  const loaded = {};
  let inflight = null, boardCache = null;
  const staleSources = force => Object.keys(sources).filter(name => force || !loaded[name] || Date.now() - loaded[name] > ttl(name));
  async function refresh(force = false) {
    await Promise.all(staleSources(force).map(async name => { const s = sources[name];
      if (!s.configured) { state[name].error = 'not configured'; loaded[name] = Date.now(); return; }
      try { const data = await s.load(); state[name] = { data, at: new Date().toISOString(), error: '', count: data.size }; }
      catch (e) { state[name] = { ...state[name], error: e instanceof Error ? e.message : String(e) }; }
      loaded[name] = Date.now();
    }));
  }
  // The board is recomputed only when the Portal copy or the day changes.
  async function portalBoard(copy, today) {
    if (boardCache && boardCache.at === copy.at && boardCache.today === today) return boardCache;
    const mod = await board, raw = copy.raw;
    const built = mod.buildProductionBoard(mod.boardVehiclesFromSources(raw, today), mod.DEFAULT_BOARD_SETTINGS, today);
    boardCache = { at: copy.at, today, board: { ...built, rows: mod.sortBoardRows(built.rows, 'status') }, grgi: parsePortal(raw.datetrack, raw.pgi, raw.tms), settings: mod.DEFAULT_BOARD_SETTINGS };
    return boardCache;
  }
  return {
    // First load waits; later a stale copy is returned at once and refreshed in the background.
    async current({ force = false, today } = {}) {
      const stale = staleSources(false).length > 0;
      if (force || stale) inflight ??= refresh(force).finally(() => { inflight = null; });
      const first = Object.values(loaded).length < Object.keys(sources).length;
      const [copy] = await Promise.all([portal.current({ force }), force || first ? inflight : null]);
      const pb = await portalBoard(copy, today);
      const sapCopy = sap ? await sap.current() : { rows: new Map(), at: '', count: 0, error: 'not configured' };
      return { refreshing: Boolean(inflight) || copy.refreshing, longtree: state.longtree.data, prod: state.prod.data, portal: mergeGrGi(pb.grgi, sapCopy.rows), board: pb.board, settings: pb.settings,
        status: { ...Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { at: v.at, error: v.error, count: v.count, configured: sources[k].configured }])), portal: { at: copy.at, error: copy.error || '', count: pb.board.rows.length, configured: true }, sap: { at: sapCopy.at, error: sapCopy.error, count: sapCopy.count, configured: Boolean(sap) } } };
    },
  };
}
