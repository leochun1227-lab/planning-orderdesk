// Initial reconciliation (2026-11-06): apply the CRM report that the baseline Planning Schedule was
// already processed with, using the normal daily rules, but record the result as "initial
// reconciliation" (migration) so the first real daily import only shows real changes.
// Typical effect: blank Request dates become ASAP/dates, Customer notes follow the CRM (except
// customerManual orders), CRM model-year/customer texts are recorded. lastReportDate is unchanged.
//   node --env-file=.env scripts/normalize-from-crm.mjs --crm=<report used for the baseline.xlsx> [--write]
import { readFile } from 'node:fs/promises';
import { applyReport } from '../lib/order-engine.mjs';
import { parseCrmWorkbook } from '../lib/crm-workbook.mjs';
import { store } from './_store.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const report = await parseCrmWorkbook(new Uint8Array(await readFile(args.crm)));
const { state, etag } = await store.readState();
if (report.reportDate !== state.meta.lastReportDate) throw new Error(`Report ${report.reportDate} is not the baseline report ${state.meta.lastReportDate}`);
const batchId = `crm-normalize-${report.reportDate}`;
const r = applyReport(state, report.records, { batchId, fileName: `Initial reconciliation · ${report.reportDate} CRM`, businessDate: report.reportDate, reportDate: report.reportDate, now: new Date().toISOString() });
const events = { ...r.state.events };
const fields = {}; const statuses = {};
for (const e of Object.values(events)) if (e.batchId === batchId) {
  events[e.id] = { ...e, migration: true };
  statuses[e.type] = (statuses[e.type] || 0) + 1;
  for (const c of e.changes) fields[c.field] = (fields[c.field] || 0) + 1;
}
const next = { ...r.state, events, meta: { ...state.meta, lastReportDate: state.meta.lastReportDate, lastImport: state.meta.lastImport }, imports: { ...r.state.imports, [batchId]: { ...r.state.imports[batchId], kind: 'baseline', migration: true } } };
const crmFieldsRecorded = Object.values(next.orders).filter(o => o.crmModelYear !== undefined).length;
console.log({ events: statuses, fieldChanges: fields, crmModelYearRecorded: crmFieldsRecorded, summary: r.summary });
if (args.write) { const w = await store.writeState(next, etag); console.log('written, revision', w.revision); }
