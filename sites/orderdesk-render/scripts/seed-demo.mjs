// Local/demo data: builds a realistic state through the real business engine.
//   FIREBASE_ROOT=orderdesk/_selftest node scripts/seed-demo.mjs --force
import { applyReport, reportFingerprint, dayInSydney } from '../lib/order-engine.mjs';
import { store, ensureEmpty, counts } from './_store.mjs';
const dealers = { '1001': 'Snowy River Perth', '1002': 'Regent RV Frankston', '1003': 'Green RV Forest Glen', '1004': 'Leisure Lion Newcastle' };
const models = ['SRC16', 'SRT19', 'SRP21', 'SRH16', 'RCC20'];
const statuses = ['QUOTED', 'FACTORY DRAWN', 'BUYER ORDERED'];
const rec = (i, status, extra = {}) => ({ chassis: 'SRC' + String(1000 + i), quoteStatus: status, description: `2027 ${models[i % 5]}`, dealerCode: String(1001 + (i % 4)), customer: i % 3 ? `Customer ${i}` : dealers[String(1001 + (i % 4))], expectedDate: `2027-0${1 + (i % 8)}-15`, sourceRow: 14 + i, ...extra });
const etag = await ensureEmpty();
const today = dayInSydney();
const day = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
let state = { orders: {}, events: {}, imports: {}, refs: { dealers, dealerNames: Object.values(dealers).map(s => s.toLowerCase()), excluded: [] }, meta: {} };
const first = Array.from({ length: 240 }, (_, i) => rec(i, statuses[i % 2]));
let r = applyReport(state, first, { batchId: await reportFingerprint(first, day(8)), fileName: 'CRM Report (demo baseline).xlsx', businessDate: day(8), reportDate: day(8), now: day(8) + 'T00:20:00Z' });
for (const e of Object.values(r.state.events)) e.migration = true;
state = { ...r.state, meta: { ...r.state.meta, lastReportDate: day(8) } };
const second = [...first.map((x, i) => i % 7 === 0 ? { ...x, quoteStatus: 'BUYER ORDERED' } : x), ...Array.from({ length: 12 }, (_, i) => rec(300 + i, 'QUOTED')), { ...rec(5, 'CANCELLED') }].filter(x => x.chassis !== 'SRC1005' || x.quoteStatus === 'CANCELLED');
r = applyReport(state, second, { batchId: await reportFingerprint(second, day(1)), fileName: 'Sales Order Report (Customer).xlsx', businessDate: today, reportDate: day(1), now: new Date().toISOString() });
state = { ...r.state, meta: { ...r.state.meta, lastReportDate: day(1) } };
await store.writeState(state, etag);
console.log('Seeded', counts(state), r.summary);
