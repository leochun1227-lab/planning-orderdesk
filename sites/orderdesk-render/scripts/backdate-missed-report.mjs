// Backfill a missed daily report (2026-11-06): the 11-05 CRM report was never imported, so the
// 11-06 import picked up two days of changes and dated them all 11-06. Planning's Excel
// ("Updating the schedule", Sheet2) recorded which of those happened on the missed day. This
// script moves exactly those changes to the missed day, as if that report had been imported:
//   signed    signedAt / purchaseAt (and a specAt filled in the same step) -> missed day
//   spec      specAt -> missed day
//   newOrders the order arrives on the missed day (receivedAt / sentLongtreeAt / its 'new' event);
//             a spec/signed change that Excel lists for the later day stays on the later day
//   cancelled cancelledAt and the cancel event -> missed day
// Slots: for a dealer that got new orders on both days, the missed day's orders take the
// dealer's earliest of those rows (Excel fills empty rows day by day).
//   node --env-file=.env scripts/backdate-missed-report.mjs --list=corrections.json [--write] [--out=next.json]
// corrections.json: {date, batchId, signed:[id], spec:[id], newOrders:[id], cancelled:[id]}
import { readFile, writeFile } from 'node:fs/promises';
import { excelRowOf, forecastResolver } from '../lib/schedule.mjs';
import { store } from './_store.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const list = JSON.parse(await readFile(args.list, 'utf8'));
const { date, batchId } = list;
const { state, etag } = await store.readState();
const later = state.imports?.[batchId];
if (!later) throw new Error(`Import ${batchId} not found`);
if (!(date < later.businessDate)) throw new Error(`${date} is not before ${later.businessDate}`);
const newBatch = `missed-${date}`;
if (state.imports[newBatch]) throw new Error(`${newBatch} already applied`);

const orders = structuredClone(state.orders), events = structuredClone(state.events);
const byOrder = new Map();
for (const e of Object.values(events)) if (e.batchId === batchId) byOrder.set(e.orderId, e);
const sets = Object.fromEntries(['signed', 'spec', 'newOrders', 'cancelled'].map(k => [k, new Set(list[k] || [])]));
const moveFields = id => sets.signed.has(id) ? ['signedAt', 'purchaseAt', 'specAt'] : sets.spec.has(id) ? ['specAt'] : [];
const later_ = later.businessDate;
let n = 0; const summary = { newCount: 0, changedCount: 0, cancelledCount: 0 };
const problems = [];

for (const id of new Set([...sets.signed, ...sets.spec, ...sets.newOrders, ...sets.cancelled])) {
  const e = byOrder.get(id), o = orders[id];
  if (!e || !o) { problems.push(`${id}: no event/order in ${batchId}`); continue; }
  if (sets.cancelled.has(id)) {
    if (e.type !== 'cancelled') { problems.push(`${id}: not a cancel event`); continue; }
    events[e.id] = { ...e, date, batchId: newBatch, backfilled: true };
    if (o.cancelledAt === later_) o.cancelledAt = date;
    summary.cancelledCount++; continue;
  }
  if (sets.newOrders.has(id)) {
    if (e.type !== 'new') { problems.push(`${id}: not a new event`); continue; }
    // Milestones reached by the later report stay on the later day as a separate 'changed' event.
    const stay = e.changes.filter(c => ['specAt', 'signedAt', 'purchaseAt'].includes(c.field));
    events[e.id] = { ...e, date, batchId: newBatch, backfilled: true, changes: e.changes.filter(c => !stay.includes(c)) };
    for (const f of ['receivedAt', 'sentLongtreeAt']) if (o[f] === later_) o[f] = date;
    if (stay.length) { const sid = `${batchId}_split_${id}`; events[sid] = { ...e, id: sid, type: 'changed', changes: stay }; }
    summary.newCount++; continue;
  }
  const fields = moveFields(id);
  const move = e.changes.filter(c => fields.includes(c.field) && c.after === later_);
  if (!move.length) { problems.push(`${id}: nothing to move`); continue; }
  const keep = e.changes.filter(c => !move.includes(c));
  const nid = `${newBatch}_${n++}`;
  events[nid] = { ...e, id: nid, date, batchId: newBatch, backfilled: true, changes: move.map(c => ({ ...c, after: date })) };
  if (keep.length) events[e.id] = { ...e, changes: keep }; else delete events[e.id];
  for (const c of move) o[c.field] = date;
  summary.changedCount++;
}

// Slot events of moved orders follow their order's day.
for (const e of Object.values(events)) {
  if (!e.scheduleAction || e.date !== later_) continue;
  if ((e.scheduleAction === 'assigned' && sets.newOrders.has(e.orderId)) || (e.scheduleAction === 'released' && sets.cancelled.has(e.orderId))) events[e.id] = { ...e, date };
}

// Slot order: per dealer, earlier day's new orders take the earliest rows among that dealer's new rows.
const rows = state.schedule.rows.map(r => ({ ...r }));
const forecast = forecastResolver(state.calendar);
const laterNew = new Set(Object.values(events).filter(e => e.batchId === batchId && e.type === 'new').map(e => e.orderId));
const swaps = [];
const dealers = new Set([...sets.newOrders].map(id => orders[id]?.dealer));
for (const dealer of dealers) {
  const ids = [...sets.newOrders, ...laterNew].filter(id => orders[id]?.dealer === dealer && orders[id]?.slotRow);
  const byRow = (a, b) => orders[a].slotRow - orders[b].slotRow;
  const wanted = [...ids.filter(id => sets.newOrders.has(id)).sort(byRow), ...ids.filter(id => !sets.newOrders.has(id)).sort(byRow)];
  const slots = ids.map(id => orders[id].slotRow).sort((a, b) => a - b);
  wanted.forEach((id, i) => {
    const row = slots[i], o = orders[id];
    if (o.slotRow === row) return;
    swaps.push({ id, dealer, from: o.slotRow, to: row });
    rows[row - 2] = { chassis: id, dealer: rows[row - 2].dealer };
    o.slotRow = row; o.forecastDate = forecast(excelRowOf(row - 2));
    const ae = Object.values(events).find(e => e.scheduleAction === 'assigned' && e.orderId === id);
    if (ae) events[ae.id] = { ...ae, changes: ae.changes.map(c => c.field === 'forecastDate' ? { ...c, after: o.forecastDate } : c) };
  });
}

const imports = {
  ...state.imports,
  [batchId]: { ...later, newCount: later.newCount - summary.newCount, changedCount: later.changedCount - summary.changedCount, cancelledCount: later.cancelledCount - summary.cancelledCount, note: `${summary.newCount + summary.changedCount + summary.cancelledCount} changes moved to ${newBatch}` },
  [newBatch]: { id: newBatch, kind: 'backfill', fileName: `Missed report ${date} · from Excel "Updating the schedule"`, businessDate: date, reportDate: date, processedAt: new Date().toISOString(), rows: 0, reviewCount: 0, ...summary },
};
const next = { ...state, orders, events, imports, schedule: { ...state.schedule, rows } };
console.log({ summary, swaps, problems });
if (problems.length && !args.force) { console.error('Problems found; nothing written (use --force to ignore).'); process.exit(1); }
if (args.out) await writeFile(args.out, JSON.stringify(next));
if (args.write) { const w = await store.writeState(next, etag); console.log('written, revision', w.revision); }
