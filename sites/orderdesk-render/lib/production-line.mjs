// Production line (产线): where each order physically is, from Longtree (China) through the sea
// leg to the Australian factory and GI. Read-only from every source:
//   Longtree      Feishu Bitable "车辆生产发运进度 / 生产海运总表" (China production + shipping dates)
//   prodReport    Regent production API (AU factory location, station, flags, station history)
//   SAP           GR / GI per chassis, pushed by an in-network computer (sap-grgi.mjs)
// Vehicle SAP GR takes precedence. A displayed Shipment record without vehicle GR means shipping.
// Otherwise retain the Portal stage rules and AU production API facts; missing GR remains flagged.
import { effectiveSimulationCapacity } from './stock-production-plan.mjs';
import { normalizeChassis, toDay } from './order-engine.mjs';
import { loadPortalBoard } from './campervan-plan.mjs';
import { readFileSync } from 'node:fs';
import { parseTms } from './tms-shipping.mjs';
import { replayInventoryBasis, appendRollingToBasis } from './inventory-basis-replay.mjs';
import { signedPlansDate } from './order-signoff.mjs';
import { dealerSnapshot, dealerNeeds, pickRolling, dealerMonthly, withTransport, dealerOverview, dealerSlug, isStockCustomer, isRollingCustomer, isMotorhomeOrder, slugify, ROLLING_SIZE, DISPATCH_DAYS, IDEAL_STOCK_SOURCE, HANDOVER_MONTHS } from './dealership.mjs';
import { DISPLAY_MODELS, NOT_ON_YARD, modelPolicy } from './stock-forecast.mjs';
import { loadWorkCalendar, towableQuantities, planQuantities, dailyCapacity, capacityKind, buildPlanSlots } from './build-plan.mjs';

// One-off Longtree plan snapshot (Nov + Dec 2026 sheets): the rolling 60 days follow its order
// exactly while it is active. Delete or replace data/longtree-plan-*.json to change it.
export function loadRollingPlan(url = new URL('../data/longtree-plan-2026-11-12.json', import.meta.url)) {
  try { const doc = JSON.parse(readFileSync(url, 'utf8')); return { ...doc, byChassis: new Map(doc.rows.map(r => [normalizeChassis(r.chassis), r])) }; } catch { return null; }
}
const ROLLING = new Set(['locked', 'rolling']);
/** 下线 (finish) dates. CN = Longtree (Feishu) 总装入库 only, the same field the Longtree API script reads; nothing from the
 *  Portal. AU finish is left empty: it will come from Orderdesk's own AU scheduling (to be defined), not SAP or the Portal. */
function finishDates(b, lt, sap, today) {
  const tr = b.track || {}, past = d => (d && d <= today ? d : '');
  const cnDone = past(lt?.finishedAt);
  return { cnEnd: cnDone || '', cnEndActual: Boolean(cnDone), auEnd: '', auEndActual: false };
}
const EXECUTION = new Set(['transport', 'au', 'sea', 'cn']);

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
  { id: 'dealership', band: 'dealer', zh: 'Dealership', en: 'Dealership', note: '五家直营店（Frankston、Geelong、Launceston、St James、Traralgon）店里的车和在途车（PGI 后 100 天内、还没进店也没交付），口径同 Dealer Portal 管理页；标签上的数字是 new stock 合计。上面是每家近三个月交付、目标库存和还缺多少 stock。' },
  { id: 'transport', band: 'execution', zh: 'Transport', en: 'Transport', note: '澳洲生产系统显示在 Transport 的车（已下线，等运去经销商、还没 GI）；放在澳洲生产之前。', phase: 'au' },
  { id: 'au', band: 'execution', zh: '澳洲生产', en: 'AU production', note: 'SAP 有 GR 的算澳洲生产；没有 Shipment 记录时，澳洲生产系统显示已接收 / 在生产的也算澳洲生产。没有 GR 的标红；有 Shipment 记录且无 GR 的归海运。澳洲预计下线：按 Portal Production & dispatch 每月产量（Towable / SRM / SRV 各算各的）分到工作日历每个工作日，从今天开始按 澳洲生产（QC → 生产 → 预装 → 已接收）→ 海运（Shipment ETA）→ 国内生产 → 排产锁定线（计划顺序）→ 滚动排产线依次填。', phase: 'au' },
  { id: 'sea', band: 'execution', zh: '海运', en: 'Shipping', note: '有「集装箱 · 船 · ETA」（Shipment）记录但没有车辆 SAP GR 的，一律算海运，包括生产系统显示在澳洲的；其他已发运且没有 GR 的也算海运。有 GR 后归入澳洲生产 / Transport。', phase: 'sea' },
  { id: 'cn', band: 'execution', zh: '国内生产', en: 'China production', note: '国内已上线车辆（飞书有家具 / 钣焊 / 总装 / 入库日期就算，Portal 还在滚动排产的也移过来）· 从底盘焊接、总装到国内完工。', phase: 'cn' },
  { id: 'locked', band: 'scheduling', zh: '排产锁定线', en: 'Locked', note: 'Longtree 11 / 12 月计划里还没上线的车都在这里（已在国内生产 / 海运 / 澳洲的保持原位），按计划文件顺序；不再看 Portal 的 Schedule Confirmed。' },
  { id: 'rolling', band: 'scheduling', zh: '滚动排产线', en: 'Rolling', note: '按本次数量选入Customer和Stock，客户比例可设置并按每周均匀安排。客户按收到签字图日期先后选择，需求交付日期不得晚于AU下线日期。Stock按直营、JV、Independent优先级，先满足各组Ideal缺口，再按预计库存/Ideal最低均衡分配；库存参考上限不再截断数量。待核到货计库存预留，直营库存池可计划内部转配，前序固定产能保留。' },
  { id: 'customers', band: 'preschedule', zh: '库存订单池', en: 'Stock order pool', note: '已签字且未进入锁定线、实际生产、海运或到店的Customer及Stock均先留在订单池，不自动占产能。按数量生成后选中的车辆才加入滚动线；未选中的继续留池。SRV/SRM不加入Towable滚动排产。' },
  { id: 'processing', band: 'preschedule', zh: '处理中订单', en: 'Orders in progress', note: '尚未收到签字图纸的Customer及Stock，不分配滚动产能。只显示Customer name非空的记录。收到签字日期后重新按客户/库存规则处理。' },
  { id: 'later', band: 'later', zh: '后续排产 / 日期待补', en: 'Later / dates missing', note: '未被本期滚动排产选中的客户订单、SRV/SRM客户单及客户名待补订单，保留源计划信息，不占用本期滚动产能。已签字Stock留在库存订单池，未签字订单进入「处理中订单」。' },
];

// ---- Orderdesk rules on top of the Portal board ------------------------------------------------
// Two grouping rules differ from the Dealer Portal on purpose (SAP and Longtree are fresher than
// datetrack): a vehicle with a SAP GR (or AU finished-goods receipt), or one the AU factory reports
// as received / in production, is AU production, whatever else says; a vehicle that has shipped (Longtree, or Portal already past China) without a GR is
// shipping. Everything else keeps the Portal group. Rows that move get their plan / expected dates
// recomputed the Portal way for the new group; untouched rows keep the Portal numbers exactly.
export const REGENT_STATUSES = [
  { key: 'finished', label: 'Finished', phase: 'au' },
  { key: 'ready for dispatch', label: 'Ready for Dispatch', phase: 'au' },
  { key: 'production commenced regent', label: 'Production Commenced Regent', phase: 'au' },
  { key: 'van arrived', label: 'Van Arrived', phase: 'au' },
  { key: 'van on the sea', label: 'Van on the sea', phase: 'sea' },
  { key: 'production commenced longtree', label: 'Production Commenced Longtree', phase: 'cn' },
  { key: 'po sent to lt', label: 'PO sent to LT', phase: 'pre' },
  { key: 'signoff', label: 'Signoff', phase: 'pre' },
];
const PHASE_ORDER = ['pre', 'cn', 'sea', 'au'];
const CRM_GRACE_DAYS = 7;
/** CRM Regent production status; blank CRM status falls back to PO sent → "PO sent to LT", signed → "Signoff". */
export function regentStatus(order) {
  if (!order) return { label: '', rank: 99, phase: '', derived: false };
  const raw = String(order.productionStatus || '').trim();
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  const i = REGENT_STATUSES.findIndex(s => key === s.key || key.startsWith(s.key));
  if (i >= 0) return { label: raw, rank: i, phase: REGENT_STATUSES[i].phase, derived: false };
  if (raw) return { label: raw, rank: 90, phase: '', derived: false };
  const j = order.purchaseAt ? 6 : order.signedAt ? 7 : -1;
  return j < 0 ? { label: '', rank: 99, phase: '', derived: false } : { label: REGENT_STATUSES[j].label, rank: j, phase: 'pre', derived: true };
}
/** Longtree progress, earliest → latest. Furniture starts before chassis welding; ETD/ETA count once set. */
export const LONGTREE_PROGRESS = [
  ['orderAt', '订单接收', 'Order received', true], ['furnitureAt', '家具上线', 'Furniture', true], ['weldAt', '钣焊上线', 'Welding', true],
  ['assemblyAt', '总装上线', 'Assembly', true], ['finishedAt', '总装入库', 'Finished', true], ['shippedAt', '发运', 'Shipped', true],
  ['etd', '预计离港', 'ETD', false], ['atd', '实际离港', 'Left CN port', true], ['eta', '预计到港', 'ETA', false], ['ata', '实际到港', 'Arrived AU port', true],
];
export function longtreeProgress(lt = {}, today) {
  for (let i = LONGTREE_PROGRESS.length - 1; i >= 0; i--) {
    const [field, , , actual] = LONGTREE_PROGRESS[i], d = lt[field];
    if (d && (!actual || d <= today)) return { rank: i + 1, field, date: d };
  }
  return { rank: 0, field: '', date: '' };
}
const DAY = 86400000;
const addDays = (d, n) => (d ? new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10) : '');
const latest = (...ds) => ds.filter(Boolean).sort().at(-1) || '';
function trackDay(v, today) {
  if (v == null || v === '') return '';
  const n = v && typeof v === 'object' && '_seconds' in v ? Number(v._seconds) : typeof v === 'number' ? v : NaN;
  let d = '';
  if (Number.isFinite(n) && n >= 1e8) d = dayIn(n < 1e12 ? n * 1000 : n, 'Australia/Sydney');
  else { const t = String(v).trim(), a = t.match(/^(\d{4})-(\d{2})-(\d{2})/), b = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/); d = a ? iso(+a[1], +a[2], +a[3]) : b ? iso(+b[3], +b[2], +b[1]) : ''; }
  return d && d <= today ? d : '';
}
/** The Portal's per-group plan / expected arithmetic (buildProductionBoard), for a row placed in another group. */
export function datesForGroup(b, group, today, settings = {}, lt = {}, sap = {}) {
  const cn = settings.cnDays ?? 20, sea = settings.seaDays ?? 50, au = settings.auDays ?? 40, cnMrp = settings.cnMrpDays ?? 5, auMrp = settings.auMrpDays ?? 5;
  const tr = b.track || {}, past = d => (d && d <= today ? d : '');
  const weld = b.cnActual || past(lt.weldAt), built = trackDay(tr.finishGoods, today) || past(lt.finishedAt), left = trackDay(tr.leavingFactory, today) || past(lt.shippedAt);
  const received = trackDay(tr['Received in Melbourne'], today) || past(sap.grAt), started = b.auActual || '', ready = trackDay(tr['Delivery Ready'], today);
  const T = b.cnPlanStart, C = b.cnPlanEnd, m = b.auPlanStart, B = b.auPlanEnd;
  const cnStart = weld || (T ? latest(T, today) : '');
  const cnEnd = built || (cnStart ? latest(C, addDays(cnStart, cn), group === 'cn' ? today : '') : '');
  const leaving = left || cnEnd;
  const arrive = received || (leaving ? latest(addDays(leaving, sea), group === 'sea' ? today : '') : '');
  const auStart = started || latest(m, arrive);
  const auEnd = ready || (auStart ? latest(B, addDays(auStart, au), group === 'au' ? today : '') : '');
  const planStart = group === 'au' ? m : group === 'sea' ? C : T;
  const planEnd = group === 'cn' ? C : group === 'sea' ? addDays(C, sea) : B;
  const expectedEnd = group === 'cn' ? cnEnd : group === 'sea' ? arrive : auEnd;
  const gap = planEnd && expectedEnd ? Math.round((Date.parse(expectedEnd) - Date.parse(planEnd)) / DAY) : null;
  return { cnStart, auStart, cnEnd, auEnd, planStart, planEnd, expectedEnd, delay: gap == null ? null : Math.max(0, gap), cnMrp: addDays(weld || cnStart, -cnMrp), auMrp: addDays(started || auStart, -auMrp), cnActual: weld || b.cnActual };
}
const SHIPPED_PORTAL = new Set(['au', 'sea']);
const atTransport = au => String(au?.location || '').toLowerCase() === 'transport';
export function groupFor(b, lt = {}, sap = {}, today, au = null, ship = null) {
  if (b.empty || !b.chassis) return b.group;
  if (sap.grAt) return atTransport(au) ? 'transport' : 'au';
  // Match exactly the Shipment object displayed in "Container · vessel · ETA". Vehicle GR is the boundary;
  // a production API location or a container-level GR must not override Shipment when the vehicle has no GR.
  if (ship) return 'sea';
  // Physically in the AU factory (production API location, or a Portal production start) without a
  // GR: still AU production; issuesFor flags the missing GR.
  if ((au && AU_LOCATIONS.has(String(au.location || '').toLowerCase())) || b.auActual) return atTransport(au) ? 'transport' : 'au';
  const shipped = [lt.shippedAt, lt.atd, lt.ata].some(d => d && d <= today);
  if (shipped || SHIPPED_PORTAL.has(b.group)) return 'sea';
  // Already on the Longtree line (furniture / welding / assembly / finished date in Feishu): China production, even when
  // the Portal still has it in the rolling 60 days or later (e.g. Nov / Dec plan cars that have started).
  if (!EXECUTION.has(b.group) && [lt.furnitureAt, lt.weldAt, lt.assemblyAt, lt.finishedAt].some(d => d && d <= today)) return 'cn';
  return b.group;
}
/** Checks that point at a wrong or missing record somewhere. error = something is wrong; warn = needs a look. */
export function issuesFor({ b, group, lt, au, sap = {}, regent, today }) {
  const out = [], add = (code, level, zh, en) => out.push({ code, level, zh, en });
  if (b.empty || !b.chassis) return out;
  const past = d => (d && d <= today ? d : '');
  const gr = sap.grAt, inFactory = au && AU_LOCATIONS.has(String(au.location || '').toLowerCase());
  if (!gr) {
    const why = [];
    if (inFactory) why.push([`生产系统：${au.location}${au.station ? ' · ' + au.station : ''}`, `production API: ${au.location}${au.station ? ' · ' + au.station : ''}`]);
    if (b.auActual) why.push([`Portal 生产上线 ${b.auActual}`, `Portal production start ${b.auActual}`]);
    if (regent.phase === 'au') why.push([`CRM：${regent.label}`, `CRM: ${regent.label}`]);
    if (why.length) add('inFactoryNoGr', 'error', `已在澳洲工厂/生产，SAP 没有 GR（${why.map(w => w[0]).join('；')}）`, `In the AU factory but no SAP GR (${why.map(w => w[1]).join('; ')})`);
    else if (past(lt?.ata)) { const d = daysBetween(lt.ata, today); if (d > 14) add('arrivedNoGr', 'warn', `到港 ${d} 天，SAP 还没有 GR`, `Arrived ${d} days ago, no SAP GR yet`); }
  }
  if (sap.giAt) add('giOpen', 'warn', `SAP 已 GI（${sap.giAt}），Portal 还没标发运`, `SAP GI on ${sap.giAt}, Portal not dispatched yet`);
  if (gr && lt && !lt.shippedAt && !lt.atd && !lt.ata) add('grNoShip', 'warn', '有 GR，但飞书没有发运 / 离港 / 到港日期', 'GR done, but Longtree has no ship / departure / arrival date');
  // CRM status against the facts. CRM "Van Arrived" = received at Regent (GR); arriving at the
  // Melbourne port is still "Van on the sea". Blank CRM status (shown as PO sent / Signoff) is not checked.
  const shipDay = past(lt?.shippedAt) || past(lt?.atd) || past(lt?.ata), cnDay = [lt?.furnitureAt, lt?.weldAt, lt?.assemblyAt, lt?.finishedAt].map(past).filter(Boolean).sort()[0] || '';
  const [fact, since] = gr ? ['au', gr] : shipDay ? ['sea', shipDay] : cnDay ? ['cn', cnDay] : ['pre', ''];
  if (regent.phase && !regent.derived && (lt || gr)) {
    const c = PHASE_ORDER.indexOf(regent.phase), f = PHASE_ORDER.indexOf(fact), late = daysBetween(since, today) ?? 0;
    const factZh = { au: `已 GR（${since}）`, sea: `已发运（${since}）`, cn: `国内已上线（${since}）` }[fact], factEn = { au: `GR on ${since}`, sea: `shipped ${since}`, cn: `in Longtree production since ${since}` }[fact];
    if (c < f && late > CRM_GRACE_DAYS) add('crmBehind', 'warn', `CRM 状态落后：CRM 还是「${regent.label}」，实际${factZh}`, `CRM behind: still "${regent.label}", actually ${factEn}`);
    else if (c > f && regent.phase !== 'au' && lt) add('crmAhead', 'warn', `CRM 状态超前：CRM「${regent.label}」，飞书 / SAP 还没有对应日期`, `CRM ahead: "${regent.label}", no matching Longtree / SAP date`);
  }
  // Longtree dates that cannot be right.
  if (lt) {
    const bad = [];
    for (const [a, z, la, lz] of [['weldAt', 'assemblyAt', '钣焊上线', '总装上线'], ['assemblyAt', 'finishedAt', '总装上线', '总装入库'], ['finishedAt', 'shippedAt', '总装入库', '发运'], ['shippedAt', 'atd', '发运', '实际离港'], ['atd', 'ata', '实际离港', '实际到港']])
      if (lt[a] && lt[z] && lt[z] < lt[a]) bad.push(`${lz} ${lt[z]} 早于${la} ${lt[a]}`);
    for (const [f, l] of [['finishedAt', '总装入库'], ['shippedAt', '发运'], ['atd', '实际离港'], ['ata', '实际到港']]) if (lt[f] && lt[f] > today) bad.push(`${l} ${lt[f]} 在未来`);
    if (gr && lt.ata && gr < lt.ata) bad.push(`GR ${gr} 早于实际到港 ${lt.ata}`);
    if (bad.length) add('dateOrder', 'warn', `日期不对：${bad.join('；')}`, `Date problem: ${bad.join('; ')}`);
  }
  return out;
}

export function buildProductionLine({ board, orders, longtree, prod, portal, today, settings, plan = null, tms = new Map(), buildPlan = null, auCapacity = null, dealers = null, rollingSize = ROLLING_SIZE, rollingAdmissions = [], rollingSchedule = null, inventoryBasis = null, displayModels = DISPLAY_MODELS, notOnYardModels = NOT_ON_YARD }) {
  const activePlan = plan && (!plan.activeUntil || today <= plan.activeUntil) ? plan : null;
  const seen = new Map();
  for (const r of board.rows) { const c = r.empty ? '' : normalizeChassis(r.chassis); if (c) seen.set(c, [...(seen.get(c) || []), r.group]); }
  const orderByChassis = new Map(Object.values(orders || {}).filter(o => o && o.status !== 'cancelled').map(o => [normalizeChassis(o.chassis), o]));
  const cancelled = new Set(Object.values(orders || {}).filter(o => o?.status === 'cancelled').map(o => normalizeChassis(o.chassis)));
  const counts = Object.fromEntries(BOARD_GROUPS.map(g => [g.id, 0]));
  const rows = [], crmDone = [];
  for (const raw of board.rows) {
    if (raw.empty) continue; // Capacity-only slots are not orders and are not displayed on the production line.
    const chassis = raw.empty ? '' : normalizeChassis(raw.chassis);
    const order = chassis ? orderByChassis.get(chassis) : undefined;
    const signedAt = signedPlansDate([order?.signedAt, raw.signedAt], today);
    const lt = chassis ? longtree.get(chassis) : undefined, au = chassis ? prod.get(chassis) : undefined, p = (chassis && portal.get(chassis)) || {}, ship = (chassis && tms.get(chassis)) || null;
    let group = groupFor(raw, lt || {}, p, today, au, ship), source = raw, planRow = null, notInPlan = false;
    if (activePlan && chassis && !EXECUTION.has(group)) {
      planRow = activePlan.byChassis.get(chassis) || null;
      if (planRow) {
        group = 'locked'; // every plan car not yet on the line: 排产锁定线 (Portal Schedule Confirmed no longer used)
        source = { ...raw, cnPlanStart: planRow.weldPlan || planRow.assemblyPlan || raw.cnPlanStart };
      } else if (ROLLING.has(group)) { group = 'later'; notInPlan = true; }
    }
    if (['rolling', 'customers', 'later', 'processing'].includes(group)) {
      if (cancelled.has(chassis)) continue;
      group = signedAt ? (group === 'processing' ? 'customers' : group) : 'processing';
      if (group === 'processing') notInPlan = false;
    }
    const dateGroup = group === 'transport' ? 'au' : group, moved = dateGroup !== raw.group || source !== raw;
    const b = !moved ? raw : { ...source, ...datesForGroup(source, dateGroup, today, settings, lt || {}, p), overdue: Boolean(ROLLING.has(group) && source.cnPlanStart && source.cnPlanStart < today) };
    const regent = regentStatus(order), progress = longtreeProgress(lt || {}, today);
    // CN planned finish (国内计划下线): only the Longtree plan sheets — 总装计划交付日期, else 总装计划下线日期; a cell that
    // only says 「总装1月计划」 gives a month; nothing in the sheets (or not in them) = empty. Never the Portal.
    const sheet = (chassis && plan?.byChassis?.get(chassis)) || null;
    const cnPlan = { date: sheet?.finishPlan || sheet?.assemblyEndPlan || '', month: sheet ? sheet.finishMonth || sheet.assemblyEndMonth || '' : '' };
    // CRM already Finished / Ready for Dispatch and not on the AU production system: taken off the line (only counted).
    if (group === 'au' && CRM_DONE.has(regent.label) && !au?.location) { crmDone.push(chassis); continue; }
    counts[group] = (counts[group] || 0) + 1;
    const live = chassis ? stageOf(order || {}, lt, au, p, today) : null;
    const customer = String(order?.customer ?? b.customer ?? '');
    rows.push({
      id: b.id, chassis: b.chassis || '', empty: Boolean(b.empty), line: b.line || '', source: b.source || '', group, portalGroup: raw.group, status: b.status || '',
      regent: regent.label, regentRank: regent.rank, regentDerived: regent.derived, ltRank: progress.rank, ltField: progress.field, ltDate: progress.date,
      today, orderRow: order?.slotRow ?? null, forecast: order?.forecastDate || '',
      planOrder: planRow && ROLLING.has(group) ? planRow.order : null, planRef: planRow ? planRow.months.join(' / ') : '', planWeld: planRow?.weldPlan || '', planAssembly: planRow?.assemblyPlan || '',
      issues: [
        ...((seen.get(chassis) || []).length > 1 ? [{ code: 'duplicate', level: 'error', zh: `车架号在产线出现 ${seen.get(chassis).length} 次（${seen.get(chassis).map(x => BOARD_GROUPS.find(gr => gr.id === x)?.zh || x).join('、')}）`, en: `Chassis appears ${seen.get(chassis).length} times on the line (${seen.get(chassis).join(', ')})` }] : []),
        ...(notInPlan ? [{ code: 'notInPlan', level: 'warn', zh: `不在 Longtree 11 / 12 月排产计划里（Portal 国内计划上线 ${raw.cnPlanStart || '—'}，原在${raw.group === 'locked' ? '排产锁定线' : '滚动排产线'}）`, en: `Not in the Longtree Nov / Dec plan (Portal CN plan start ${raw.cnPlanStart || '—'}, was ${raw.group})` }] : []),
        ...issuesFor({ b, group, lt, au, sap: p, regent, today })],
      dealer: b.dealer || '', customer, signedAt, modelYear: String(order?.modelYear || b.modelYear || '').trim(),
      // Orderlist "Request Delivery Date" as the Portal schedule (the uploaded Orderlist) has it, blank included; vans not in
      // that list (SRM / SRV) take the Orderdesk order's date. Blank = no requested date (Orderdesk 'ASAP').
      requestDate: raw.inSchedule ? raw.requestDate || '' : requestDateOf(order?.requestDate), model: b.model || '', range: b.range || '', orderId: order ? chassis : '',
      production: b.production ? { status: b.production.status || '', stage: b.production.stage || '', location: b.production.location || '' } : null,
      cnActual: b.cnActual, cnStart: b.cnStart, cnPlanStart: b.cnPlanStart, cnPlanEnd: cnPlan.date, cnPlanMonth: cnPlan.date ? '' : cnPlan.month, auActual: b.auActual, auStart: b.auStart, auPlanStart: b.auPlanStart, auPlanEnd: b.auPlanEnd,
      ...finishDates(b, lt, p, today),
      planStart: b.planStart, planEnd: b.planEnd, expectedEnd: b.expectedEnd, delay: b.delay, cnMrp: b.cnMrp, auMrp: b.auMrp, overdue: Boolean(b.overdue), locked: Boolean(b.locked), warnings: b.warnings || [],
      live: live && {
        stage: live.stage, since: live.since, days: daysBetween(live.since, today),
        inLongtree: Boolean(lt), orderAt: lt?.orderAt || '', weldAt: lt?.weldAt || '', furnitureAt: lt?.furnitureAt || '', assemblyAt: lt?.assemblyAt || '', finishedAt: lt?.finishedAt || '', shippedAt: lt?.shippedAt || '',
        etd: lt?.etd || '', atd: lt?.atd || '', eta: lt?.eta || '', ata: lt?.ata || '', notes: lt?.notes || {},
        ship,
        inSap: Boolean(chassis && portal.has(chassis)), grAt: p.grAt || '', po: p.po || '', grDoc: p.grDoc || '', giAt: p.giAt || '', giDoc: p.giDoc || '',
        inProduction: Boolean(au), location: au?.location || '', station: au?.station || '', flags: au?.flags || [], enteredAt: au?.enteredAt || '', stationSince: au?.stationSince || '', daysAtStation: au ? daysBetween(au.stationSince, today) : null, history: au?.history || [],
      },
    });
  }
  // Rebuild after physical/locked grouping: signed Towable Customer only, independent of dealer stock needs.
  for (const r of rows) if (r.group === 'rolling') r.group = 'customers';
  let dealership = null, dealersAll = null, shown = null, lockedLast = today, rollingEnd = today;
  const preparedBasis = auCapacity ? forecastAuFinish(rows, auCapacity, today, inventoryBasis, dealers || []).basisReplay || null : null;
  auCapacity = effectiveSimulationCapacity(inventoryBasis, auCapacity);
  if (dealers) {
    dealersAll = dealers; shown = dealers.filter(d => d.own !== false); // Dealership tab: self-owned yard + transit
    dealers = withTransport(shown, rows, today); // analysis still combines Transport and transit
    // The rolling line takes the Towable places after the last Towable van ahead of it; its last place is `rollingEnd`.
    lockedLast = preparedBasis?.rollingBoundary || rows.reduce((m, r) => (r.auForecast?.kind === 'towable' && r.auEnd > m ? r.auEnd : m), '') || today;
  }
  // Pool membership never books capacity. Only an explicit saved proposal/admission does.
  const pick = pickRolling(rows);
  if (Array.isArray(rollingSchedule)) {
    pick.picked = []; pick.customers = 0;
    const selected = new Set();
    for (const a of rollingSchedule) {
      const matching = rows.filter(r => normalizeChassis(r.chassis) === normalizeChassis(a.chassis)), r = matching.length === 1 ? matching[0] : null;
      if (!r || selected.has(r.chassis) || !['customers', 'later'].includes(r.group) || !signedPlansDate([r.signedAt], today) || isMotorhomeOrder(r)
        || !a.auEnd || a.auEnd < today || r.model !== a.model) continue;
      const stock = isStockCustomer(r.customer), known = dealersAll || dealers || [];
      const sourceSlug = dealerSlug(known, r.dealer), targetSlug = dealerSlug(known, a.dealer);
      const targetDealer = known.find(d => d.slug === targetSlug);
      const transfer = sourceSlug !== targetSlug;
      if (transfer) continue; // Only the applied inventory basis may change a dealer.
      if (stock && ((!a.fullTarget && modelPolicy(r.model, r.modelYear, displayModels, notOnYardModels) !== 'display')
        || !String(r.model || '').trim() || targetSlug === 'traralgon' || targetDealer?.paused || r.regentRank < 6)) continue;
      if (!stock && !isRollingCustomer(r)) continue;
      selected.add(r.chassis); r.rollingNotBefore = a.auEnd;
      if (stock) { r.rollingApproval = { planId: a.planId, arrival: a.arrival, auEnd: a.auEnd }; pick.stockPicked[dealerSlug(dealersAll || dealers || [], r.dealer)] = (pick.stockPicked[dealerSlug(dealersAll || dealers || [], r.dealer)] || 0) + 1; }
      else pick.customers++;
      pick.picked.push({ r, kind: stock ? 'stock' : 'customer' });
    }
    for (const r of rows) if (['customers', 'later'].includes(r.group) && isRollingCustomer(r) && !selected.has(r.chassis)) { r.group = 'customers'; r.waitingRolling = true; }
  }
  const admitted = new Set();
  for (const a of (rollingSchedule ? [] : [...rollingAdmissions]).sort((a, b) => a.auEnd.localeCompare(b.auEnd) || a.chassis.localeCompare(b.chassis))) {
    const matching = rows.filter(r => normalizeChassis(r.chassis) === normalizeChassis(a.chassis));
    const r = matching.length === 1 ? matching[0] : null;
    if (!r || admitted.has(r.chassis) || !['customers', 'later'].includes(r.group) || isMotorhomeOrder(r) || !isStockCustomer(r.customer)
      || !signedPlansDate([r.signedAt], today) || r.regentRank < 6 || modelPolicy(r.model, r.modelYear, displayModels, notOnYardModels) !== 'display' || slugify(r.dealer) === 'traralgon'
      || r.model !== a.model || dealerSlug(dealersAll || dealers || [], r.dealer) !== a.slug || !a.planId || !/^\d{4}-\d{2}-\d{2}$/.test(a.auEnd) || a.auEnd < today) continue;
    admitted.add(r.chassis); r.rollingApproval = { planId: a.planId, arrival: a.arrival, auEnd: a.auEnd };
    r.rollingNotBefore = a.auEnd;
    pick.picked.push({ r, kind: 'stock' });
    pick.stockPicked[a.slug] = (pick.stockPicked[a.slug] || 0) + 1;
  }
  pick.picked.forEach(({ r, kind }, i) => { r.group = 'rolling'; r.rollingOrder = i + 1; r.rollingKind = kind; r.issues = r.issues.filter(x => x.code !== 'notInPlan'); });
  for (const r of rows) {
    if (r.group === 'later' && !r.waitingRolling) r.group = 'customers';
    if (r.group === 'customers' && !r.returnedToPool && !isStockCustomer(r.customer) && !isRollingCustomer(r)) r.group = 'later';
  }
  if (shown) {
    const names = new Map(); for (const r of rows) if (r.dealer && !names.has(slugify(r.dealer))) names.set(slugify(r.dealer), r.dealer);
    const transfers = new Map(['own', 'jv', 'independent'].flatMap(g => inventoryBasis?.[g]?.actions || []).filter(a => a.group === 'yard' && a.reallocated).map(a => [normalizeChassis(a.chassis), a]));
    for (const d of shown) for (const v of d.vehicles) {
      const r = dealerRow(d, v, names.get(d.slug) || d.name, today), a = transfers.get(normalizeChassis(v.chassis));
      if (a) {
        r.originalDealer = r.dealer; r.dealer = a.proposedDealer || dealersAll.find(x => x.slug === a.to)?.name || r.dealer;
        r.plannedReallocation = true; r.inventoryAdjustment = 'reallocate';
        r.dealerSite = { ...r.dealerSite, slug: a.to, where: 'transit', arrive: a.plannedArrival, since: a.depart, via: 'planned-reallocation' };
      }
      rows.push(r);
    }
    dealership = { lockedLast, rollingEnd, size: rollingSize, picked: pick.picked.length, customers: pick.customers, dispatchDays: DISPATCH_DAYS, months: HANDOVER_MONTHS, targetSource: IDEAL_STOCK_SOURCE,
      dealers: dealers.map(d => { const { vehicles, ...rest } = d; return { ...rest, monthly: [], stockPicked: pick.stockPicked[d.slug], stockAvailable: pick.stockAvailable[d.slug], customerPicked: pick.picked.filter(p => p.kind === 'customer' && slugify(p.r.dealer) === d.slug).length }; }) };
  }
  for (const id of Object.keys(counts)) counts[id] = rows.filter(r => r.group === id).length;
  if (dealership) counts.dealership = dealership.dealers.reduce((n, d) => n + d.yard.stock, 0);
  const auForecast = auCapacity ? forecastAuFinish(rows, auCapacity, today, null, dealersAll || dealers || [], preparedBasis) : null;
  for (const id of Object.keys(counts)) if (id !== 'dealership') counts[id] = rows.filter(r => r.group === id && !r.planningExcluded).length;
  if (dealership) {
    if (inventoryBasis) lockedLast = auForecast.basisReplay.rollingBoundary;
    dealership.lockedLast = lockedLast;
    const rolling = rows.filter(r => r.group === 'rolling');
    rollingEnd = rolling.some(r => !r.auEnd || r.auForecast?.note === 'overflow') ? '' : rolling.reduce((last, r) => r.auEnd > last ? r.auEnd : last, lockedLast);
    dealership.rollingEnd = rollingEnd;
    const needs = dealerNeeds(dealers, rows, today, rollingEnd);
    dealership.dealers.forEach((x, i) => { Object.assign(x, needs[i]); x.monthly = dealerMonthly(dealers[i], rows, today); });
    const jv = withTransport(dealersAll.filter(d => d.jv), rows, today);
    const jvNeeds = dealerNeeds(jv, rows, today, rollingEnd);
    dealership.jvDealers = jv.map((d, i) => {
      const { vehicles, ...rest } = d;
      return { ...rest, ...jvNeeds[i], monthly: dealerMonthly(d, rows, today), stockPicked: pick.stockPicked[d.slug] || 0,
        stockAvailable: rows.filter(r => r.group === 'customers' && slugify(r.dealer) === d.slug && isStockCustomer(r.customer)).length,
        customerPicked: pick.picked.filter(p => p.kind === 'customer' && slugify(p.r.dealer) === d.slug).length };
    });
    dealership.all = dealerOverview(dealersAll, rows, today);
  }
  return { today, counts, dealership, completed: board.completed, crmDone, averages: board.averages, settings, rows: sortLineRows(rows.filter(r => !r.planningExcluded)), auForecast,
    buildPlan: buildPlan ? { months: buildPlan.months, calendar: 'VIC 2026 + 2027 Draft V3' } : null,
    plan: activePlan ? { name: activePlan.name, files: activePlan.files, activeUntil: activePlan.activeUntil, count: activePlan.rows.length } : null };
}
/** A vehicle at (or on its way to) one of our dealerships, shaped like a production-line row. */
function dealerRow(d, v, dealerName, today) {
  const prefix = v.chassis.slice(0, 3).toUpperCase();
  return { id: `dealer-${d.slug}-${v.via || v.where}-${v.chassis}`, chassis: v.chassis, empty: false, line: prefix === 'SRV' || prefix === 'SRM' ? prefix : 'Towable', source: 'Dealer Portal', group: 'dealership', portalGroup: 'dealership', status: '',
    regent: '', regentRank: 99, regentDerived: false, ltRank: 0, ltField: '', ltDate: '', today, orderRow: null, forecast: '', planOrder: null, planRef: '', planWeld: '', planAssembly: '', issues: [],
    dealer: dealerName, model: v.model, range: prefix, customer: v.customer, orderId: '', production: null,
    cnActual: '', cnStart: '', cnPlanStart: '', cnPlanEnd: '', cnPlanMonth: '', auActual: '', auStart: '', auPlanStart: '', auPlanEnd: '', cnEnd: '', cnEndActual: false, auEnd: '', auEndActual: false,
    planStart: '', planEnd: '', expectedEnd: '', delay: null, cnMrp: '', auMrp: '', overdue: false, locked: false, warnings: [], live: null,
    dealerSite: { slug: d.slug, where: v.where, via: v.via || 'pgi', category: v.category, since: v.since, days: v.days, arrive: v.arrive || '', target: d.target } };
}
// Expected AU finish (下线) for the AU production group. Capacity per working day comes from the Dealer Portal
// "Production & dispatch" plan: Towable = total − SRM − SRV, and SRM / SRV each have their own number, so they never take
// Towable places. Each month is spread over the working days of the VIC work calendar. The cars are queued by how far
// they are on the AU line (QC → production → pre-assembly → received → no production record), then by time at that
// station, then GR date; the queue fills today's places first, then the next working day, and so on.
const AU_STAGE = { qc: 0, production: 1, 'pre-assembly': 2, received: 3 };
const CRM_DONE = new Set(['Finished', 'Ready for Dispatch']);
export function forecastAuFinish(rows, capacity, today, inventoryBasis = null, dealers = [], preparedBasis = null) {
  const slots = { towable: [], srm: [], srv: [] };
  for (const d of [...capacity.keys()].filter(d => d >= today).sort()) for (const k of Object.keys(slots)) for (let i = 0; i < capacity.get(d)[k]; i++) slots[k].push([d, capacity.get(d)[k]]);
  // Queue: AU production (by line progress) → shipping (by ETA) → China production (group order) → rolling 60 days (plan order).
  const of = g => rows.filter(r => !r.empty && (Array.isArray(g) ? g.includes(r.group) : r.group === g));
  const queue = [
    ...of('au').sort(by(num(r => AU_STAGE[r.live?.location] ?? 4), asc(r => r.live?.stationSince || r.live?.enteredAt), asc(r => r.live?.grAt), asc(r => r.chassis))),
    ...of('sea').sort(GROUP_SORT.sea),
    ...of('cn').sort(GROUP_SORT.cn),
    ...of('locked').sort(by(num(r => r.planOrder), asc(r => r.chassis))),
    ...of('rolling').sort(by(num(r => r.rollingOrder), asc(r => r.chassis))),
  ];
  const used = { towable: 0, srm: 0, srv: 0 }, summary = { towable: 0, srm: 0, srv: 0, overflow: 0 };
  if (!preparedBasis) for (const [order, r] of queue.entries()) {
    const kind = capacityKind(r.model);
    if (r.group === 'rolling' && r.rollingNotBefore) {
      while (slots[kind][used[kind]] && slots[kind][used[kind]][0] < r.rollingNotBefore) used[kind]++;
    }
    const slot = slots[kind][used[kind]];
    used[kind]++;
    if (!slot) { r.auForecast = { kind, seq: used[kind], order, note: 'overflow' }; summary.overflow++; continue; }
    r.auEnd = slot[0]; r.auEndActual = false;
    r.auForecast = { kind, seq: used[kind], order, perDay: slot[1], stage: r.live?.location || '' };
    summary[kind]++;
    // Not physically possible: the van would finish in AU before the Shipment page ETA. Only vehicles that are on the
    // Shipment page and not arrived yet; nothing is estimated for vehicles without a Shipment ETA.
    const ship = r.live?.ship, arrive = ship && !ship.arrived ? ship.eta || '' : '';
    if (arrive && r.auEnd < arrive) r.auForecast.beforeArrival = arrive;
  }
  if (preparedBasis) { appendRollingToBasis({ rows, capacity, today, basis: preparedBasis }); summary.basisReplay = preparedBasis; }
  if (inventoryBasis) {
    const adjusted = replayInventoryBasis({ line: { rows, today }, report: inventoryBasis, capacity, dealers, includeRolling: true });
    adjusted.line.rows.forEach((r, i) => Object.assign(rows[i], r)); summary.basisReplay = adjusted.replay;
  }
  if (inventoryBasis || preparedBasis) {
    for (const kind of ['towable', 'srm', 'srv']) summary[kind] = queue.filter(r => ['au', 'sea', 'cn', 'locked', 'rolling'].includes(r.group) && !r.planningExcluded && r.auEnd && capacityKind(r.model) === kind).length;
    summary.overflow = queue.filter(r => ['au', 'sea', 'cn', 'locked', 'rolling'].includes(r.group) && !r.planningExcluded && !r.auEnd).length;
  }
  for (const g of ['au', 'sea', 'cn', 'locked', 'rolling']) summary[g] = queue.filter(r => r.group === g && !r.planningExcluded).reduce((m, r) => ({ first: m.first && m.first < r.auEnd ? m.first : r.auEnd, last: r.auEnd > m.last ? r.auEnd : m.last, n: m.n + 1 }), { first: '', last: '', n: 0 });
  summary.beforeArrival = queue.filter(r => r.auForecast?.beforeArrival).length;
  const first = [...capacity.keys()].filter(d => d >= today).sort()[0];
  return { ...summary, today: first ? { date: first, ...capacity.get(first) } : null, last: queue.reduce((m, r) => (r.auEnd > m ? r.auEnd : m), '') };
}

/** CN finish for sorting: actual, else the plan day, else the end of the plan month (2027-01 → 2027-01-32). */
export const cnFinishKey = r => (r.cnEndActual ? r.cnEnd : r.cnPlanEnd || (r.cnPlanMonth ? `${r.cnPlanMonth}-32` : '')) || '';
/** Port ETA: only the Dealer Portal Shipment page (tmssystem Vessel movements & ETA) — never filled in from Longtree
 *  (Feishu) dates or our own estimates. No vehicle on the Shipment page = no ETA. */
export function etaKey(r) {
  return r.live?.ship?.eta || '';
}
const by = (...keys) => (a, z) => { for (const k of keys) { const d = k(a, z); if (d) return d; } return 0; };
const asc = f => (a, z) => (f(a) || '9999').localeCompare(f(z) || '9999');
const num = f => (a, z) => (f(a) ?? 1e9) - (f(z) ?? 1e9);
/** Default order inside each group: the date the people looking at that group care about. */
export const GROUP_SORT = {
  transport: by(asc(r => r.live?.stationSince || r.live?.enteredAt)),
  // AU production: by expected AU finish (下线) date; cars beyond the planned capacity last.
  au: by(num(r => (r.auEnd ? 1 : 2)), asc(r => r.auEnd), num(r => r.auForecast?.order), asc(r => r.live?.grAt)),
  sea: by(asc(etaKey)),
  cn: by((a, z) => (z.ltRank ?? 0) - (a.ltRank ?? 0), asc(cnFinishKey)),
  locked: by(num(r => r.planOrder)),
  rolling: by(num(r => r.rollingOrder)),
  dealership: by(asc(r => r.dealerSite?.slug), asc(r => (r.dealerSite?.where === 'yard' ? 'a' : 'b')), asc(r => ({ stock: 'a', customer: 'b', second: 'c' })[r.dealerSite?.category] || 'z'), num(r => -(r.dealerSite?.days ?? 0))),
  customers: by(asc(r => r.signedAt), num(r => r.orderRow), asc(r => r.forecast)),
  processing: by(num(r => r.orderRow), asc(r => r.forecast)),
  later: by(num(r => r.orderRow), asc(r => r.forecast), num(r => r.regentRank ?? 99)),
};
const GROUP_INDEX = ['dealership', 'transport', 'au', 'sea', 'cn', 'locked', 'rolling', 'customers', 'processing', 'later'];
export function sortLineRows(rows) {
  return rows.map((r, i) => ({ r, i })).sort((a, z) => (GROUP_INDEX.indexOf(a.r.group) - GROUP_INDEX.indexOf(z.r.group)) || (GROUP_SORT[a.r.group] || (() => 0))(a.r, z.r)
    || (a.r.cnStart || '9999').localeCompare(z.r.cnStart || '9999') || a.i - z.i).map(x => x.r);
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
  // LONGTREE_WIKI_TOKEN is a wiki node/resource ID, not an access credential.
  // Requests are separately authenticated with the tenant token obtained above
  // using LONGTREE_APP_ID / LONGTREE_APP_SECRET from the environment.
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
const requestDateOf = v => { const d = toDay(v); return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : ''; };
// Orderlist cell → date (dd/mm/yyyy or ISO), or the text as typed ("Urgent", "(fixed in August)"); 1900 / ASAP → blank.
const requestCell = v => { const d = toDay(v); return d === 'ASAP' ? '' : d || String(v ?? '').trim(); };
// The bundled Portal board drops model year, sign-off and request delivery date. Carry explicit values from the same cached records.
function portalOrderDetails(raw, today) {
  const details = new Map();
  const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
  const scheduled = new Set(list(raw.schedule));
  for (const records of [raw.campers, raw.schedule, raw.motorhome?.orders]) for (const r of list(records)) {
    if (!r || typeof r !== 'object') continue;
    const chassis = normalizeChassis(r.chassisNumber || r.Chassis || r.chassis);
    const year = [r.modelYear, r.ModelYear, r['Model Year']].map(v => String(v ?? '').trim()).find(Boolean);
    const signedAt = signedPlansDate([r.signedAt, r['Signed Plans Received'], r.signedOrderReceived, r.signedOffDate], today);
    const inSchedule = scheduled.has(r), requestDate = inSchedule ? requestCell(r['Request Delivery Date']) : '';
    const was = details.get(chassis);
    if (chassis && (year || signedAt || inSchedule)) details.set(chassis, { modelYear: year || was?.modelYear || '', signedAt: signedAt || was?.signedAt || '',
      inSchedule: inSchedule || Boolean(was?.inSchedule), requestDate: inSchedule ? requestDate : was?.requestDate || '' });
  }
  return details;
}
export function createProductionLineSource(env = {}, { fetcher = fetch, ttlMs = SOURCE_TTL_MS, portal, board = loadPortalBoard(), sap = null } = {}) {
  const calendar = loadWorkCalendar();
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
    const details = portalOrderDetails(raw, today);
    const rows = built.rows.map(r => { const d = details.get(normalizeChassis(r.chassis));
      return { ...r, modelYear: d?.modelYear || r.modelYear || '', signedAt: signedPlansDate([r.signedAt, d?.signedAt], today), inSchedule: Boolean(d?.inSchedule), requestDate: d?.requestDate || '' }; });
    let dealers = null, forecastDealers = null, dealersError = '';
    try { dealers = raw.yard ? dealerSnapshot(raw, today, { all: true }) : null; forecastDealers = raw.yard ? dealerSnapshot(raw, today, { all: true, towableOnly: true }) : null; if (!dealers) dealersError = 'no data'; } catch (e) { dealersError = e instanceof Error ? e.message : String(e); }
    boardCache = { at: copy.at, today, board: { ...built, rows: mod.sortBoardRows(rows, 'status') }, settings: mod.DEFAULT_BOARD_SETTINGS, tms: parseTms(raw.tms), tmsAt: raw.tms?.meta?.updatedAtUTC || '', dealers, forecastDealers, dealersError,
    };
    return boardCache;
  }
  // The Production & dispatch plan is re-read every 5 minutes (portal-source); recomputed only when it changed.
  let planCache = null;
  function portalPlan(plan) {
    if (!plan) return { buildPlan: null, auCapacity: null };
    if (planCache?.key === plan.key) return planCache;
    const r = plan.raw, plans = { dispatchPlan: r.dispatchPlan, motorhomePlans: { 2026: r.mhPlan2026, 2027: r.mhPlan2027 } };
    planCache = { key: plan.key, buildPlan: buildPlanSlots(towableQuantities(plans), calendar), auCapacity: dailyCapacity(planQuantities({ ...plans, modelNames: r.mhModels }), calendar),
      updatedAt: [r.dispatchPlan?.['2026']?.updatedAt, r.dispatchPlan?.['2027']?.updatedAt].filter(Boolean).sort().pop() || '' };
    return planCache;
  }
  return {
    // First load waits; later a stale copy is returned at once and refreshed in the background.
    async current({ force = false, today } = {}) {
      const stale = staleSources(false).length > 0;
      if (force || stale) inflight ??= refresh(force).finally(() => { inflight = null; });
      const first = Object.values(loaded).length < Object.keys(sources).length;
      const [copy] = await Promise.all([portal.current({ force }), force || first ? inflight : null]);
      const pb = { ...(await portalBoard(copy, today)), ...portalPlan(copy.plan) };
      const sapCopy = sap ? await sap.current() : { rows: new Map(), at: '', count: 0, error: 'not configured' };
      return { refreshing: Boolean(inflight) || copy.refreshing, longtree: state.longtree.data, prod: state.prod.data, portal: sapCopy.rows, board: pb.board, settings: pb.settings, tms: pb.tms, buildPlan: pb.buildPlan, auCapacity: pb.auCapacity, dealers: pb.dealers, forecastDealers: pb.forecastDealers,
        status: { ...Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { at: v.at, error: v.error, count: v.count, configured: sources[k].configured }])), portal: { at: copy.at, error: copy.error || '', count: pb.board.rows.length, configured: true }, sap: { at: sapCopy.at, error: sapCopy.error, count: sapCopy.count, configured: Boolean(sap) }, tms: { at: pb.tmsAt, error: pb.tms.size ? '' : (copy.error || 'no data'), count: pb.tms.size, configured: true }, plan: { at: copy.plan?.at || '', updatedAt: pb.updatedAt || '', error: copy.planError || '', count: pb.auCapacity?.size || 0, configured: true }, dealers: { at: copy.at, error: pb.dealersError || '', count: pb.dealers ? pb.dealers.reduce((n, d) => n + d.vehicles.length, 0) : 0, configured: true } } };
    },
  };
}
