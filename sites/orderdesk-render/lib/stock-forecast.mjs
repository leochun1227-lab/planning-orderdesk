// Read-only stock scenarios. No order, Portal, production-slot or transport writes.
import { DEALERSHIPS, JV_DEALERS, leadDays, isStockCustomer, slugify } from './dealership.mjs';

export const DISPLAY_MODELS = ['SRC22S', 'SRC19', 'SRC18', 'SRC21', 'SRC21S', 'SRC17', 'SRC22', 'SRC24', 'SRC14', 'SRC16',
  'SRC22F 3 Bunks', 'SRC21C', 'SRH16', 'SRH16F 1 Bunk', 'SRH14', 'SRH15', 'SRH15F 2 Bunks', 'SRP19', 'SRP19F 2 Bunks',
  'SRS12', 'SRT20', 'SRT19', 'SRT16', 'SRT19F', 'SRT22F 2 Bunks'];
export const NOT_ON_YARD = ['SRC20', 'SRC22F 2 Bunks', 'SRC20F 2 Bunks', 'SRH13', 'SRP20', 'SRP17', 'SRP14', 'SRS9', 'SRT22F 3 Bunks', 'SRT22'];
const key = v => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
const display = new Set(DISPLAY_MODELS.map(key)), noYard = new Set(NOT_ON_YARD.map(key));
const norm = v => key(v).replace(/[-\s]/g, '');
export const isTowable = r => !/^SR[MV]/.test(norm(r.chassis)) && !/^SR[MV]/.test(key(r.model)) && !/^SR[MV]$/i.test(r.line || '');
const MS = 86400000, stamp = s => Date.parse(s + 'T00:00:00Z');
const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(stamp(v)) && new Date(stamp(v)).toISOString().slice(0, 10) === v ? v : '';
const plus = (d, n) => new Date(stamp(d) + n * MS).toISOString().slice(0, 10);
export function addCalendarMonth(day, n = 1) {
  const d = new Date(stamp(day)), old = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(old, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
}
export function forecastMultiplier(v = 1.3) {
  if (v === '' || v === null || !Number.isFinite(Number(v)) || Number(v) <= 0 || Number(v) > 10) throw new Error('库存倍数须大于0且不超过10 / Stock multiplier must be greater than 0 and at most 10');
  return Number(v);
}
const r1 = v => Math.round((v + Number.EPSILON) * 10) / 10;
const phase = { cn: '国内生产', locked: '排产锁定线', rolling: '滚动排产线', customers: '库存订单池', processing: '处理中订单', later: '日期待补', au: '澳洲生产', sea: '海运', transport: 'Transport', pgi: 'PGI在途', yard: '现货调拨' };
export function modelPolicy(model, year) {
  const m = key(model);
  if (String(year) === '2027' && ['SRT18', 'SRP18F 2 BUNKS'].includes(m)) return 'deleted';
  return display.has(m) ? 'display' : noYard.has(m) ? 'notOnYard' : 'check';
}
const priority = { transport: 0, au: 1, sea: 2, cn: 3, locked: 4, rolling: 5, customers: 6, processing: 7, later: 8 };
const ACTIONS = { keep: ['保持原计划', 'Keep'], cancel: ['建议取消', 'Cancel'], delay: ['延期', 'Delay'], reallocate: ['转配', 'Reallocate'], pool: ['暂不生产', 'Do not build yet'], pending: ['待分流/核对', 'Review'], blocked: ['拦截待改送', 'Redirect before delivery'] };
const REASONS = {
  deleted: ['MY2027已删除车型，未开工不再补库。', 'Deleted MY2027 model; no new stock production.'],
  notOnYard: ['Not on yard车型，不作常态展车补库。', 'Not-on-yard model; no routine yard replenishment.'],
  check: ['车型未准确匹配推荐清单，先核对用途和型号。', 'Model is not an exact match to the recommended lineup; review first.'],
  pool: ['库存池尚未安排生产，不计到货、不计取消，需补货时再排。', 'Unscheduled pool stock is excluded from arrivals and cancellations; schedule only when needed.'],
  processing: ['未排入生产的Stock，先保留待处理，不假设已生产或已取消。', 'Unscheduled stock remains pending; no production or cancellation assumed.'],
  capacity: ['1个自然月内无同时满足库存上限及车型缓冲的接收窗口。', 'No receiving window within one calendar month meets both stock and model limits.'],
  started: ['已开工，不能按未生产订单取消；接收用途仍需落实。', 'Production has started; do not treat as an unbuilt cancellation. Receiving demand is unresolved.'],
  date: ['缺少有效AU完工或运输日期，未虚构到货日期。', 'A valid AU finish or transit date is missing; no arrival date is fabricated.'],
  horizon: ['日期超出未来36个月的规划范围，单列核对，不自动取消。', 'Date is outside the next 36 months; review separately rather than cancel automatically.'],
  stopped: ['Traralgon停止收车，原下游车辆待确认改送，未假定实际拦截已执行。', 'Traralgon is not receiving. Confirm a new destination; interception has not been executed.'],
  fixed: ['已在下游，沿用原到店计划；不能靠取消未开工单消除这些库存。', 'Downstream supply retains its arrival plan; cancelling unstarted orders does not remove it.'],
  allocated: ['在1个月内尽早安排；跨店仅限直营店，JV不转配。', 'Earliest feasible window within one month; reallocations stay within self-owned dealers.'],
  yard: ['现货调拨候选；发车前核实未售及承运安排。运输按两店下线至店天数相加暂估。', 'Yard-transfer candidate; verify unsold vehicle and carrier before dispatch. Transit allowance is the sum of both dealers’ lead times.'],
};
export const actionLabel = (a, zh = true) => ACTIONS[a]?.[zh ? 0 : 1] || a;
export const reasonLabel = (a, zh = true) => REASONS[a]?.[zh ? 0 : 1] || a;
const suffix = a => { let max = -Infinity; const out = new Float64Array(a.length); for (let i = a.length - 1; i >= 0; i--) { max = Math.max(max, a[i]); out[i] = max; } return out; };

export function buildStockForecast({ dealers, rows = [], today, multiplier = 1.3, months = 8 }) {
  multiplier = forecastMultiplier(multiplier);
  if (!valid(today)) throw new Error('Invalid forecast date');
  if (![8, 14].includes(Number(months))) throw new Error('预测月份须为8或14 / Forecast months must be 8 or 14');
  months = Number(months);
  if (!Array.isArray(dealers)) throw new Error('Dealer stock data is unavailable');
  const wanted = new Set([...DEALERSHIPS, ...JV_DEALERS].map(d => d.slug));
  const inputs = dealers.filter(d => wanted.has(d.slug));
  const index = new Map(inputs.map(d => [d.slug, d]));
  const warnings = [];
  const seen = new Set(), orders = [];
  // Physical yard / PGI records take precedence over a still-open production row of the same chassis.
  for (const d of inputs) for (const v of d.vehicles || []) if (norm(v.chassis) && isTowable(v)) seen.add(norm(v.chassis));
  for (const r of [...rows].sort((a, b) => (priority[a.group] ?? 99) - (priority[b.group] ?? 99))) {
    const chassis = norm(r.chassis), slug = slugify(r.dealer);
    if (!chassis || r.empty || r.group === 'dealership' || !(r.group in priority) || !index.has(slug) || !isTowable(r) || !isStockCustomer(r.customer)) continue;
    if (seen.has(chassis)) { warnings.push({ code: 'duplicate', chassis }); continue; }
    seen.add(chassis); orders.push({ ...r, chassis, slug });
  }
  const maxEnd = addCalendarMonth(today, 36), firstMonth = today.slice(0, 7) + '-01';
  let end = plus(addCalendarMonth(firstMonth, Math.max(14, months)), -1);
  for (const r of orders) if (valid(r.auEnd) && r.auEnd <= maxEnd) end = [end, plus(addCalendarMonth(r.auEnd), 26)].sort().at(-1);
  end = end > maxEnd ? maxEnd : end;
  const N = Math.round((stamp(end) - stamp(today)) / MS) + 1, at = day => Math.round((stamp(day) - stamp(today)) / MS);
  const dates = Array.from({ length: N }, (_, i) => plus(today, i));
  const fractions = dates.map(day => { const d = new Date(stamp(day)); return 1 / new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); });
  const units = new Map(inputs.map(d => [d.slug, { d, lead: leadDays(d), stop: d.slug === 'traralgon' || Boolean(d.paused), cap: Math.floor(d.target * multiplier), events: new Float64Array(N), models: new Map(), modelCache: new Map(), initialModels: {}, avg: Math.max(0, Number(d.handover?.avgStock) || 0) }]));
  for (const u of units.values()) for (const v of u.d.vehicles || []) if (v.where === 'yard' && v.category === 'stock' && isTowable(v)) u.initialModels[key(v.model)] = (u.initialModels[key(v.model)] || 0) + 1;
  function curve(initial, events, avg) {
    let stock = initial; const balance = new Float64Array(N), sold = new Float64Array(N), missed = new Float64Array(N);
    for (let t = 0; t < N; t++) { const available = Math.max(0, stock + events[t]), expected = avg * fractions[t]; sold[t] = Math.min(available, expected); missed[t] = expected - sold[t]; stock = available - sold[t]; balance[t] = stock; }
    return { balance, sold, missed };
  }
  const refresh = u => { Object.assign(u, curve(u.d.yard.stock, u.events, u.avg)); u.max = suffix(u.balance); };
  function modelCurve(u, model) {
    const m = key(model); if (!u.modelCache.has(m)) { const c = curve(u.initialModels[m] || 0, u.models.get(m) || new Float64Array(N), u.d.handover?.stockByModel?.[m] || 0); u.modelCache.set(m, { ...c, max: suffix(c.balance) }); }
    return u.modelCache.get(m);
  }
  function event(u, day, model, quantity, recalc = true) {
    const t = Math.max(0, at(day)); if (t >= N) return;
    u.events[t] += quantity;
    const m = key(model); if (!u.models.has(m)) u.models.set(m, new Float64Array(N)); u.models.get(m)[t] += quantity; u.modelCache.delete(m);
    if (recalc) refresh(u);
  }
  const actions = [];
  function record(r, group = r.group) {
    const u = units.get(r.slug), originalAu = valid(r.auEnd);
    const originalArrival = group === 'pgi' ? valid(r.arrive) : group === 'transport' && u.lead != null ? plus(today, u.lead) : originalAu && u.lead != null ? plus(originalAu, u.lead) : '';
    const policy = modelPolicy(r.model, r.modelYear);
    const a = { chassis: r.chassis, model: r.model || '', range: r.range || (String(r.model || '').match(/^[A-Za-z]+/) || [''])[0], modelYear: r.modelYear || '',
      group, phase: phase[group] || group, from: r.slug, originalDealer: u.d.name, to: '', proposedDealer: '', originalAu, plannedAu: '', originalArrival,
      forecast: valid(r.forecast), plannedArrival: '', depart: '', delayDays: null, arrivalDelayDays: null, action: 'keep', reason: '', policy, receive: false, delayed: false, reallocated: false };
    actions.push(a); return a;
  }
  for (const u of units.values()) for (const v of u.d.vehicles || []) {
    if (v.where !== 'transit' || v.category !== 'stock' || !isTowable(v)) continue;
    const a = record({ ...v, chassis: norm(v.chassis), slug: u.d.slug }, 'pgi');
    if (u.stop) { a.action = 'blocked'; a.reason = 'stopped'; }
    else if (!a.originalArrival) { a.action = 'pending'; a.reason = 'date'; }
    else { a.to = u.d.slug; a.proposedDealer = u.d.name; a.plannedArrival = a.originalArrival < today ? today : a.originalArrival; a.receive = true; a.reason = 'fixed'; event(u, a.plannedArrival, a.model, 1, false); }
  }
  const adjustable = [];
  for (const r of orders) {
    const u = units.get(r.slug), a = record(r);
    if (['customers', 'processing', 'later'].includes(r.group)) { a.action = r.group === 'customers' ? 'pool' : 'pending'; a.reason = r.group === 'customers' ? 'pool' : 'processing'; continue; }
    if (['au', 'sea', 'transport'].includes(r.group)) {
      if (u.stop) { a.action = 'blocked'; a.reason = 'stopped'; }
      else if (!a.originalArrival) { a.action = 'pending'; a.reason = 'date'; }
      else { a.to = u.d.slug; a.proposedDealer = u.d.name; a.plannedAu = a.originalAu; a.plannedArrival = a.originalArrival < today ? today : a.originalArrival; a.receive = true; a.reason = 'fixed'; event(u, a.plannedArrival, a.model, 1, false); }
    } else adjustable.push(a);
  }
  // Original view uses the same Towable-only population and excludes unscheduled stock-pool orders.
  const baseline = new Map();
  for (const u of units.values()) { const ev = new Float64Array(u.events); for (const a of adjustable.filter(a => a.from === u.d.slug && a.originalArrival && !u.stop)) { const t = Math.max(0, at(a.originalArrival)); if (t < N) ev[t]++; } baseline.set(u.d.slug, { events: ev, ...curve(u.d.yard.stock, ev, u.avg) }); refresh(u); }

  // Current yard stock can move only between self-owned stores. Future moves remain named candidates.
  const moved = new Set();
  function redistribute(until) {
    for (let t = 0; t < Math.min(N, until); t += 7) {
      const donors = [...units.values()].filter(u => u.d.own !== false && !u.stop && u.lead != null && u.balance[t] > u.cap + 1);
      donors.sort((a, b) => b.balance[t] - a.balance[t] || a.d.slug.localeCompare(b.d.slug));
      for (const u of donors) {
        const vans = (u.d.vehicles || []).filter(v => v.where === 'yard' && v.category === 'stock' && isTowable(v) && display.has(key(v.model))).sort((a, b) => (b.days || 0) - (a.days || 0) || a.chassis.localeCompare(b.chassis));
        while (u.balance[t] > u.cap + 1) {
          let best = null;
          for (const v of vans) {
            if (moved.has(norm(v.chassis)) || modelCurve(u, v.model).balance[t] < 2) continue;
            for (const dest of units.values()) {
              if (dest === u || dest.stop || dest.d.own === false || dest.lead == null) continue;
              const receiveAt = t + u.lead + dest.lead; if (receiveAt >= N) continue;
              if (dest.balance[receiveAt] >= dest.d.target || dest.max[receiveAt] > dest.cap - 1 + 1e-8 || modelCurve(dest, v.model).balance[receiveAt] > 1) continue;
              const score = dest.balance[receiveAt] + receiveAt / N;
              if (!best || score < best.score) best = { v, dest, receiveAt, score };
            }
          }
          if (!best) break;
          const { v, dest, receiveAt } = best;
          const a = record({ ...v, chassis: norm(v.chassis), slug: u.d.slug }, 'yard');
          Object.assign(a, { action: 'reallocate', reason: 'yard', to: dest.d.slug, proposedDealer: dest.d.name, plannedArrival: dates[receiveAt], depart: dates[t], receive: true, reallocated: true });
          moved.add(norm(v.chassis)); event(u, a.depart, a.model, -1); event(dest, a.plannedArrival, a.model, 1);
        }
      }
    }
  }
  redistribute(Math.min(91, N));
  const readyOrder = (a, b) => (a.originalAu || '9999').localeCompare(b.originalAu || '9999') || a.chassis.localeCompare(b.chassis);
  function allocate(a) {
    const original = units.get(a.from), started = a.group === 'cn';
    if (a.policy !== 'display') { a.action = started || a.policy === 'check' ? 'pending' : 'cancel'; a.reason = a.policy; return; }
    if (!a.originalAu) { a.action = 'pending'; a.reason = 'date'; return; }
    if (a.originalAu > maxEnd) { a.action = 'pending'; a.reason = 'horizon'; return; }
    const choices = [];
    for (const dest of units.values()) {
      if (dest.stop || dest.lead == null || (original.d.own === false ? dest !== original : dest.d.own === false)) continue;
      const ready = Math.max(0, at(plus(a.originalAu, dest.lead)));
      let deadline = plus(addCalendarMonth(a.originalAu), dest.lead);
      if (a.originalArrival && addCalendarMonth(a.originalArrival) < deadline) deadline = addCalendarMonth(a.originalArrival);
      const latest = Math.min(N - 1, at(deadline));
      for (let t = ready; t <= latest; t++) {
        if (dest.max[t] > dest.cap - 1 + 1e-8 || modelCurve(dest, a.model).max[t] > Math.max(2, Math.ceil(dest.d.target / DISPLAY_MODELS.length)) - 1 + 1e-8) continue;
        const delay = Math.max(0, t - at(a.originalAu) - dest.lead);
        choices.push({ dest, t, delay, score: delay + (dest === original ? 0 : 7) }); break;
      }
    }
    choices.sort((a, b) => a.score - b.score || a.t - b.t || a.dest.d.slug.localeCompare(b.dest.d.slug));
    const best = choices[0];
    if (!best) { a.action = started ? 'pending' : 'cancel'; a.reason = started ? 'started' : 'capacity'; return; }
    const { dest, t, delay } = best;
    Object.assign(a, { to: dest.d.slug, proposedDealer: dest.d.name, plannedArrival: dates[t], plannedAu: plus(dates[t], -dest.lead), delayDays: delay,
      arrivalDelayDays: a.originalArrival ? Math.round((stamp(dates[t]) - stamp(a.originalArrival)) / MS) : null, receive: true, reallocated: dest !== original, reason: 'allocated' });
    a.delayed = a.delayDays > 0 || a.arrivalDelayDays > 0;
    a.action = a.reallocated ? 'reallocate' : a.delayed ? 'delay' : 'keep';
    event(dest, a.plannedArrival, a.model, 1);
  }
  for (const a of adjustable.filter(a => a.group === 'cn').sort(readyOrder)) allocate(a);
  redistribute(N);
  for (const a of adjustable.filter(a => a.group !== 'cn').sort((a, b) => (priority[a.group] - priority[b.group]) || readyOrder(a, b))) allocate(a);

  const keys = Array.from({ length: months }, (_, i) => addCalendarMonth(firstMonth, i).slice(0, 7));
  function monthly(u) {
    const before = baseline.get(u.d.slug);
    return keys.map(month => {
      const indices = dates.flatMap((d, i) => d.startsWith(month) ? [i] : []), last = indices.at(-1);
      const sum = (a, ids = indices) => ids.reduce((s, i) => s + a[i], 0);
      const incoming = actions.filter(a => a.receive && a.to === u.d.slug && a.plannedArrival.startsWith(month)).length;
      const outgoing = actions.filter(a => a.group === 'yard' && a.from === u.d.slug && a.depart.startsWith(month)).length;
      return { month, stockIn: incoming, stockOut: r1(sum(u.sold)), plannedSales: r1(u.avg * sum(fractions)), transferOut: outgoing,
        unmet: r1(sum(u.missed)), endStock: r1(u.balance[last]), baselineEndStock: r1(before.balance[last]), baselineIn: sum(before.events) };
    });
  }
  function summary(list) {
    const canceled = list.filter(a => a.action === 'cancel').length, delayed = list.filter(a => a.delayed).length;
    return { canceled, delayed, cnDelayed: list.filter(a => a.group === 'cn' && a.delayed).length, cnCompletionDelayed: list.filter(a => a.group === 'cn' && a.delayDays > 0).length,
      lockedCanceled: list.filter(a => a.group === 'locked' && a.action === 'cancel').length, rollingCanceled: list.filter(a => a.group === 'rolling' && a.action === 'cancel').length,
      poolNotBuilt: list.filter(a => a.action === 'pool').length, reallocated: list.filter(a => a.reallocated).length,
      pending: list.filter(a => ['pending', 'blocked'].includes(a.action)).length, changes: list.filter(a => a.action !== 'keep').length };
  }
  function section(jv) {
    const all = [...units.values()].filter(u => Boolean(u.d.jv) === jv);
    const slugs = new Set(all.map(u => u.d.slug)), list = actions.filter(a => slugs.has(a.from));
    return { summary: summary(list), actions: list,
      dealers: all.map(u => { const { vehicles, ...rest } = u.d, m = monthly(u); return { ...rest, paused: false, stopReceiving: u.stop, lead: u.lead, cap: u.cap, monthly: m,
        need: Math.max(0, Math.ceil(u.d.target - m.at(-1).endStock)), stats: summary(list.filter(a => a.from === u.d.slug)),
        overCapMonths: m.filter(m => m.endStock > u.cap).length, shortageMonths: m.filter(m => m.unmet > 0).length }; }) };
  }
  const result = { today, multiplier, months, planningEnd: end, maxDelayMonths: 1, own: section(false), jv: section(true), totals: summary(actions), warnings };
  return result;
}
