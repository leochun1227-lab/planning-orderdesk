// Rebuild the website from a manually maintained Planning Schedule (Orderlist + Calendar),
// keeping the CRM reference data (dealer mapping, exclusions) and the history of the
// current website state. Agreed 2026-11-05: Planning Schedule 2025 (4) (processed up to the
// 2026-11-04 CRM report) becomes the starting point; daily CRM updates continue from there.
//
//   python scripts/extract-planning-schedule.py "Planning Schedule 2025 (4).xlsm" ps.json
//   node --env-file=.env scripts/rebaseline-from-planning-schedule.mjs ps.json \
//        --report-date=2026-11-04 [--crm=Z1D50....xlsx] [--current=state.json] [--out=new-state.json] [--write]
//
// Without --write it only builds and checks the new state (and saves --out if given).
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeChassis, displayChassis, parseReportRows } from '../lib/order-engine.mjs';
import { parseCrmWorkbook } from '../lib/crm-workbook.mjs';
import { forecastResolver, reconcileSchedule } from '../lib/schedule.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const [psFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const reportDate = args['report-date'];
if (!psFile || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '')) { console.error('Usage: rebaseline-from-planning-schedule.mjs ps.json --report-date=YYYY-MM-DD [--crm=report.xlsx] [--current=state.json] [--out=file] [--write]'); process.exit(1); }

const ps = JSON.parse(await readFile(psFile, 'utf8'));
let store = null;
const current = args.current
  ? JSON.parse(await readFile(args.current, 'utf8'))
  : (store = (await import('./_store.mjs')).store, (await store.readState()).state);
if (!current) throw new Error('No current state to take refs/history from');

const now = new Date().toISOString();
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const day = v => (isDay(v) ? v : null);                 // "No"/blank -> null (the website's empty milestone)
const text = v => (v === null || v === undefined || v === 'null' ? null : String(v));

// Latest CRM customer text per chassis (first non-cancelled record, as the engine uses).
const crmCustomer = new Map(), crmStatuses = new Map();
if (args.crm) {
  const report = await parseCrmWorkbook(new Uint8Array(await readFile(args.crm)));
  for (const r of report.records) { const key = normalizeChassis(r.chassis); if (!crmStatuses.has(key)) crmStatuses.set(key, []); crmStatuses.get(key).push(r.quoteStatus); }
  for (const r of report.records) {
    const key = normalizeChassis(r.chassis);
    if (r.quoteStatus !== 'CANCELLED' && !crmCustomer.has(key)) crmCustomer.set(key, String(r.customer ?? '').trim());
  }
  for (const r of report.records) { const key = normalizeChassis(r.chassis); if (!crmCustomer.has(key)) crmCustomer.set(key, String(r.customer ?? '').trim()); }
  console.log(`CRM ${report.reportDate}: customer text for ${crmCustomer.size} chassis`);
}

const forecast = forecastResolver(ps.calendar);
const orders = {}, rows = [], seen = new Set();
for (const r of ps.rows) {
  const id = r.G ? normalizeChassis(r.G) : null;
  if (id && seen.has(id)) throw new Error(`Duplicate chassis in Orderlist: ${r.G} (row ${r.excelRow})`);
  rows.push({ chassis: id, dealer: r.I || null });
  if (!id) continue;
  seen.add(id);
  const old = current.orders?.[id] || {};
  const A = forecast(r.excelRow);
  if (r.A && A !== r.A) throw new Error(`Forecast mismatch at row ${r.excelRow}: Excel ${r.A}, calculated ${A}`);
  orders[id] = {
    ...old,
    id, chassis: displayChassis(id), slotRow: r.excelRow,
    forecastDate: A, requestDate: text(r.B), shipment: text(r.C), productionStatus: r.D || '', vinNumber: text(r.E),
    modelYear: text(r.F) || '', model: r.H || '', dealer: r.I || '', customer: r.J || '',
    receivedAt: day(r.K), sentLongtreeAt: day(r.L), specAt: day(r.M), signedAt: day(r.N), purchaseAt: day(r.O),
    priceVersion: text(r.P), index1: text(r.Q), rank1: text(r.R), rank2: text(r.S), estimatedSemiReceivedAt: text(r.T),
    status: r.D === 'Finished' ? 'completed' : 'active',
    cancelledAt: null,
    crmCustomer: crmCustomer.get(id) ?? old.crmCustomer ?? null,
    createdAt: old.createdAt || now, updatedAt: now,
  };
}

// Orders the website knows but the Orderlist does not: keep cancelled history; keep the
// rest visible (campervans and manual adds) as unplaced orders.
const pending = [];
const kept = { cancelled: 0, notInOrderlist: [] };
for (const [id, o] of Object.entries(current.orders || {})) {
  if (orders[id]) continue;
  // Removed from the Orderlist because the CRM cancelled it (same duplicate-aware rule as applyReport).
  const st = crmStatuses.get(id);
  if (o.status !== 'cancelled' && st && st.length === 1 && st[0] === 'CANCELLED') {
    orders[id] = { ...o, slotRow: null, status: 'cancelled', cancelledAt: reportDate, updatedAt: now };
    kept.cancelledByCrm = (kept.cancelledByCrm || 0) + 1; continue;
  }
  orders[id] = { ...o, slotRow: null };
  if (o.status === 'cancelled') kept.cancelled++;
  else { kept.notInOrderlist.push(`${o.chassis} (${o.dealer}, ${o.status})`); if (o.status === 'active') pending.push(id); }
}

// Audit trail: one migration event per order whose tracked fields changed.
const FIELDS = ['status', 'dealer', 'customer', 'requestDate', 'receivedAt', 'sentLongtreeAt', 'specAt', 'signedAt', 'purchaseAt', 'productionStatus', 'forecastDate'];
const batchId = 'baseline-' + reportDate;
const events = { ...current.events };
let changedOrders = 0;
for (const [id, o] of Object.entries(orders)) {
  const old = current.orders?.[id];
  const changes = old ? FIELDS.filter(f => (old[f] ?? null) !== (o[f] ?? null)).map(f => ({ field: f, before: old[f] ?? null, after: o[f] ?? null })) : [];
  if (!old) changes.push({ field: 'status', before: null, after: o.status });
  if (!changes.length) continue;
  changedOrders++;
  const eid = `${batchId}_${id}`;
  events[eid] = { id: eid, orderId: id, chassis: o.chassis, dealer: o.dealer, type: old ? 'changed' : 'new', date: reportDate, at: now, batchId, changes, migration: true, sourceFile: ps.source };
}

const summary = { id: batchId, kind: 'baseline', fileName: ps.source, businessDate: reportDate, reportDate, processedAt: now, rows: ps.rows.length, newCount: 0, changedCount: changedOrders, cancelledCount: 0, reviewCount: pending.length, migration: true };
let next = {
  ...current,
  orders, events,
  imports: { ...current.imports, [batchId]: summary },
  schedule: { rows, pending, source: ps.source, baselineDate: reportDate },
  calendar: ps.calendar,
  refs: { ...current.refs, excludedPrefixes: current.refs?.excludedPrefixes || ['SRV', 'SRM'] },
  baselineOrders: Object.fromEntries(Object.entries(orders).filter(([id]) => seen.has(id))),
  meta: { ...current.meta, lastReportDate: reportDate, baselineDate: reportDate, baselineSource: ps.source, baselineCount: seen.size, lastImport: summary, updatedAt: now },
};
// Reconcile must be a no-op on a fresh baseline (every Orderlist order already has its row).
const check = reconcileSchedule(next, next);
if (check !== next) throw new Error('Schedule not consistent after rebaseline');

const count = s => ({ orders: Object.keys(s.orders).length, active: Object.values(s.orders).filter(o => o.status === 'active').length, completed: Object.values(s.orders).filter(o => o.status === 'completed').length, cancelled: Object.values(s.orders).filter(o => o.status === 'cancelled').length, events: Object.keys(s.events).length });
console.log('before', count(current));
console.log('after ', count(next), `· rows ${rows.length} · empty slots ${rows.filter(r => !r.chassis).length} · orders changed ${changedOrders} · kept cancelled ${kept.cancelled} · cancelled per CRM ${kept.cancelledByCrm || 0}`);
console.log('not in Orderlist (kept, unplaced):', kept.notInOrderlist.join('; ') || 'none');
if (args.out) await writeFile(args.out, JSON.stringify(next));
if (args.write) {
  store ??= (await import('./_store.mjs')).store;
  const { etag } = await store.readState();
  await store.writeState(next, etag);
  console.log('Written to Firebase.');
}
