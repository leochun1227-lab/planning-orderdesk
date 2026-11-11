// Production line (产线): where each order physically is, from Longtree (China) through the sea
// leg to the Australian factory and GI. Read-only from every source:
//   Longtree      Feishu Bitable "车辆生产发运进度 / 生产海运总表" (China production + shipping dates)
//   prodReport    Regent production API (AU factory location, station, flags, station history)
//   SAP           GR / GI per chassis, pushed by an in-network computer (sap-grgi.mjs)
// Stage rule follows the Dealer Portal (planningIntegration/vehicleStatus.ts getCurrentStatus):
// the latest node that has a date decides; a vehicle the AU factory reports as received/in
// production counts as in the AU factory even before the GR date reaches datetrack.
import { normalizeChassis } from './order-engine.mjs';
import { loadPortalBoard } from './campervan-plan.mjs';
import { readFileSync } from 'node:fs';
import { parseTms } from './tms-shipping.mjs';

// One-off Longtree plan snapshot (Nov + Dec 2026 sheets): the rolling 60 days follow its order
// exactly while it is active. Delete or replace data/longtree-plan-*.json to change it.
export function loadRollingPlan(url = new URL('../data/longtree-plan-2026-11-12.json', import.meta.url)) {
  try { const doc = JSON.parse(readFileSync(url, 'utf8')); return { ...doc, byChassis: new Map(doc.rows.map(r => [normalizeChassis(r.chassis), r])) }; } catch { return null; }
}
const ROLLING = new Set(['locked', 'rolling']);
const EXECUTION = new Set(['au', 'sea', 'cn']);

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
  { id: 'au', band: 'execution', zh: '澳洲生产', en: 'AU production', note: 'SAP 有 GR（或完工入库），或澳洲生产系统显示已接收 / 在生产的车，都算澳洲生产；没有 GR 的标红 · 实际上线取 Production Start。', phase: 'au' },
  { id: 'sea', band: 'execution', zh: '海运', en: 'Shipping', note: '已发运（飞书有发运 / 离港 / 到港日期，或 Portal 已在海运 / 澳洲），SAP 还没有 GR，澳洲工厂也还没接收。', phase: 'sea' },
  { id: 'cn', band: 'execution', zh: '国内生产', en: 'China production', note: '国内已上线车辆 · 从底盘焊接、总装到国内完工。', phase: 'cn' },
  { id: 'locked', band: 'scheduling', zh: '排产锁定线', en: 'Locked', note: '已确认待上线 · 仅以现有 Schedule Confirmed = Yes 判断锁定。' },
  { id: 'rolling', band: 'scheduling', zh: '滚动排产线', en: 'Rolling', note: '滚动安排待确认 · 不根据日期自动改写确认状态。' },
  { id: 'empty', band: 'preschedule', zh: 'Empty slots', en: 'Empty slots', note: '现有 SRV / SRM 未分配 slot · 原数据没有 Dealer 时明确显示待分配。' },
  { id: 'customers', band: 'preschedule', zh: 'Customer 订单池', en: 'Customer pool', note: '客户订单独立成池，Stock 不进入 Customer 订单池。' },
  { id: 'later', band: 'later', zh: '后续排产 / 日期待补', en: 'Later / dates missing', note: '国内计划上线在 60 天之后的车，或计划日期待补。' },
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
  const received = trackDay(tr['Received in Melbourne'], today) || past(sap.grAt) || past(sap.fgAt), started = b.auActual || '', ready = trackDay(tr['Delivery Ready'], today);
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
  return { cnStart, auStart, planStart, planEnd, expectedEnd, delay: gap == null ? null : Math.max(0, gap), cnMrp: addDays(weld || cnStart, -cnMrp), auMrp: addDays(started || auStart, -auMrp), cnActual: weld || b.cnActual };
}
const SHIPPED_PORTAL = new Set(['au', 'sea']);
export function groupFor(b, lt = {}, sap = {}, today, au = null) {
  if (b.empty || !b.chassis) return b.group;
  if (sap.grAt || sap.fgAt) return 'au';
  // Physically in the AU factory (production API location, or a Portal production start) without a
  // GR: still AU production; issuesFor flags the missing GR.
  if ((au && AU_LOCATIONS.has(String(au.location || '').toLowerCase())) || b.auActual) return 'au';
  const shipped = [lt.shippedAt, lt.atd, lt.ata].some(d => d && d <= today);
  if (shipped || SHIPPED_PORTAL.has(b.group)) return 'sea';
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
    if (sap.fgAt) why.push([`完工入库 ${sap.fgAt}`, `finished-goods receipt ${sap.fgAt}`]);
    if (why.length) add('inFactoryNoGr', 'error', `已在澳洲工厂/生产，SAP 没有 GR（${why.map(w => w[0]).join('；')}）`, `In the AU factory but no SAP GR (${why.map(w => w[1]).join('; ')})`);
    else if (past(lt?.ata)) { const d = daysBetween(lt.ata, today); if (d > 14) add('arrivedNoGr', 'warn', `到港 ${d} 天，SAP 还没有 GR`, `Arrived ${d} days ago, no SAP GR yet`); }
  }
  if (sap.giAt) add('giOpen', 'warn', `SAP 已 GI（${sap.giAt}），Portal 还没标发运`, `SAP GI on ${sap.giAt}, Portal not dispatched yet`);
  if (gr && lt && !lt.shippedAt && !lt.atd && !lt.ata) add('grNoShip', 'warn', '有 GR，但飞书没有发运 / 离港 / 到港日期', 'GR done, but Longtree has no ship / departure / arrival date');
  // CRM status against the facts. CRM "Van Arrived" = received at Regent (GR); arriving at the
  // Melbourne port is still "Van on the sea". Blank CRM status (shown as PO sent / Signoff) is not checked.
  const shipDay = past(lt?.shippedAt) || past(lt?.atd) || past(lt?.ata), cnDay = [lt?.furnitureAt, lt?.weldAt, lt?.assemblyAt, lt?.finishedAt].map(past).filter(Boolean).sort()[0] || '';
  const [fact, since] = gr || sap.fgAt ? ['au', gr || sap.fgAt] : shipDay ? ['sea', shipDay] : cnDay ? ['cn', cnDay] : ['pre', ''];
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

export function buildProductionLine({ board, orders, longtree, prod, portal, today, settings, plan = null, tms = new Map() }) {
  const activePlan = plan && (!plan.activeUntil || today <= plan.activeUntil) ? plan : null;
  const seen = new Map();
  for (const r of board.rows) { const c = r.empty ? '' : normalizeChassis(r.chassis); if (c) seen.set(c, [...(seen.get(c) || []), r.group]); }
  const orderByChassis = new Map(Object.values(orders || {}).filter(o => o && o.status !== 'cancelled').map(o => [normalizeChassis(o.chassis), o]));
  const counts = Object.fromEntries(BOARD_GROUPS.map(g => [g.id, 0]));
  const rows = [];
  for (const raw of board.rows) {
    const chassis = raw.empty ? '' : normalizeChassis(raw.chassis);
    const order = chassis ? orderByChassis.get(chassis) : undefined;
    const lt = chassis ? longtree.get(chassis) : undefined, au = chassis ? prod.get(chassis) : undefined, p = (chassis && portal.get(chassis)) || {};
    let group = groupFor(raw, lt || {}, p, today, au), source = raw, planRow = null, notInPlan = false;
    if (activePlan && chassis && !EXECUTION.has(group)) {
      planRow = activePlan.byChassis.get(chassis) || null;
      if (planRow) {
        group = raw.locked ? 'locked' : 'rolling';
        source = { ...raw, cnPlanStart: planRow.weldPlan || planRow.assemblyPlan || raw.cnPlanStart, cnPlanEnd: planRow.finishPlan || raw.cnPlanEnd };
      } else if (ROLLING.has(group)) { group = 'later'; notInPlan = true; }
    }
    const moved = group !== raw.group || source !== raw;
    const b = !moved ? raw : { ...source, ...datesForGroup(source, group, today, settings, lt || {}, p), overdue: Boolean(ROLLING.has(group) && source.cnPlanStart && source.cnPlanStart < today) };
    counts[group] = (counts[group] || 0) + 1;
    const regent = regentStatus(order), progress = longtreeProgress(lt || {}, today);
    const live = chassis ? stageOf(order || {}, lt, au, p, today) : null;
    rows.push({
      id: b.id, chassis: b.chassis || '', empty: Boolean(b.empty), line: b.line || '', source: b.source || '', group, portalGroup: raw.group, status: b.status || '',
      regent: regent.label, regentRank: regent.rank, regentDerived: regent.derived, ltRank: progress.rank, ltField: progress.field, ltDate: progress.date,
      planOrder: planRow && ROLLING.has(group) ? planRow.order : null, planRef: planRow ? planRow.months.join(' / ') : '', planWeld: planRow?.weldPlan || '', planAssembly: planRow?.assemblyPlan || '',
      issues: [
        ...((seen.get(chassis) || []).length > 1 ? [{ code: 'duplicate', level: 'error', zh: `车架号在产线出现 ${seen.get(chassis).length} 次（${seen.get(chassis).map(x => BOARD_GROUPS.find(gr => gr.id === x)?.zh || x).join('、')}）`, en: `Chassis appears ${seen.get(chassis).length} times on the line (${seen.get(chassis).join(', ')})` }] : []),
        ...(notInPlan ? [{ code: 'notInPlan', level: 'warn', zh: `不在 Longtree 11 / 12 月排产计划里（Portal 国内计划上线 ${raw.cnPlanStart || '—'}，原在${raw.group === 'locked' ? '排产锁定线' : '滚动排产线'}）`, en: `Not in the Longtree Nov / Dec plan (Portal CN plan start ${raw.cnPlanStart || '—'}, was ${raw.group})` }] : []),
        ...issuesFor({ b, group, lt, au, sap: p, regent, today })],
      dealer: b.dealer || '', model: b.model || '', range: b.range || '', customer: order?.customer || b.customer || '', orderId: order ? chassis : '',
      production: b.production ? { status: b.production.status || '', stage: b.production.stage || '', location: b.production.location || '' } : null,
      cnActual: b.cnActual, cnStart: b.cnStart, cnPlanStart: b.cnPlanStart, cnPlanEnd: b.cnPlanEnd, auActual: b.auActual, auStart: b.auStart, auPlanStart: b.auPlanStart, auPlanEnd: b.auPlanEnd,
      planStart: b.planStart, planEnd: b.planEnd, expectedEnd: b.expectedEnd, delay: b.delay, cnMrp: b.cnMrp, auMrp: b.auMrp, overdue: Boolean(b.overdue), locked: Boolean(b.locked), warnings: b.warnings || [],
      live: live && {
        stage: live.stage, since: live.since, days: daysBetween(live.since, today),
        inLongtree: Boolean(lt), orderAt: lt?.orderAt || '', weldAt: lt?.weldAt || '', furnitureAt: lt?.furnitureAt || '', assemblyAt: lt?.assemblyAt || '', finishedAt: lt?.finishedAt || '', shippedAt: lt?.shippedAt || '',
        etd: lt?.etd || '', atd: lt?.atd || '', eta: lt?.eta || '', ata: lt?.ata || '', notes: lt?.notes || {},
        ship: (chassis && tms.get(chassis)) || null,
        inSap: Boolean(chassis && portal.has(chassis)), grAt: p.grAt || '', po: p.po || '', grDoc: p.grDoc || '', fgAt: p.fgAt || '', fgDoc: p.fgDoc || '', giAt: p.giAt || '', giDoc: p.giDoc || '',
        inProduction: Boolean(au), location: au?.location || '', station: au?.station || '', flags: au?.flags || [], enteredAt: au?.enteredAt || '', stationSince: au?.stationSince || '', daysAtStation: au ? daysBetween(au.stationSince, today) : null, history: au?.history || [],
      },
    });
  }
  return { today, counts, completed: board.completed, averages: board.averages, settings, rows: sortLineRows(rows),
    plan: activePlan ? { name: activePlan.name, files: activePlan.files, activeUntil: activePlan.activeUntil, count: activePlan.rows.length } : null };
}
/** Regent status (Finished first) → Longtree progress (latest node first) → that node's date → CN start. */
export function sortLineRows(rows) {
  const planKey = r => (ROLLING.has(r.group) ? r.planOrder ?? 1e9 : 0);
  return rows.map((r, i) => ({ r, i })).sort((a, z) => planKey(a.r) - planKey(z.r) || (a.r.regentRank ?? 99) - (z.r.regentRank ?? 99) || (z.r.ltRank ?? 0) - (a.r.ltRank ?? 0)
    || (a.r.ltDate || '9999').localeCompare(z.r.ltDate || '9999') || (a.r.cnStart || '9999').localeCompare(z.r.cnStart || '9999') || a.i - z.i).map(x => x.r);
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
    boardCache = { at: copy.at, today, board: { ...built, rows: mod.sortBoardRows(built.rows, 'status') }, settings: mod.DEFAULT_BOARD_SETTINGS, tms: parseTms(raw.tms), tmsAt: raw.tms?.meta?.updatedAtUTC || '' };
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
      return { refreshing: Boolean(inflight) || copy.refreshing, longtree: state.longtree.data, prod: state.prod.data, portal: sapCopy.rows, board: pb.board, settings: pb.settings, tms: pb.tms,
        status: { ...Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { at: v.at, error: v.error, count: v.count, configured: sources[k].configured }])), portal: { at: copy.at, error: copy.error || '', count: pb.board.rows.length, configured: true }, sap: { at: sapCopy.at, error: sapCopy.error, count: sapCopy.count, configured: Boolean(sap) }, tms: { at: pb.tmsAt, error: pb.tms.size ? '' : (copy.error || 'no data'), count: pb.tms.size, configured: true } } };
    },
  };
}
