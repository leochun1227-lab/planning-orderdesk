// First-time setup from Excel, identical to the original sites/orderdesk/scripts/initialize.mjs:
// baseline.json (from scripts/prepare-baseline.py, Planning Schedule Orderlist) plus the
// CRM report rows (report.json, a 2-D array of the report sheet) dated REPORT_DATE.
//   REPORT_DATE=2026-10-28 node --env-file=.env scripts/initialize-baseline.mjs baseline.json report.json [--force]
import fs from 'node:fs/promises';
import { parseReportRows, applyReport, dayInSydney, customerName, reportFingerprint } from '../lib/order-engine.mjs';
import { store, ensureEmpty, counts } from './_store.mjs';
const [baselineFile, reportFile] = process.argv.filter(a => !a.startsWith('--')).slice(2);
const reportDate = process.env.REPORT_DATE || '';
if (!baselineFile || !reportFile || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) { console.error('Usage: REPORT_DATE=YYYY-MM-DD initialize-baseline.mjs baseline.json report.json'); process.exit(1); }
const etag = await ensureEmpty();
const state = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
for (const o of Object.values(state.orders)) o.customer = customerName(o.customer, state.refs);
const records = parseReportRows(JSON.parse(await fs.readFile(reportFile, 'utf8')));
const batchId = await reportFingerprint(records, reportDate);
const result = applyReport(state, records, { batchId, fileName: `CRM Report · ${reportDate}.xlsx`, businessDate: dayInSydney(), reportDate, now: new Date().toISOString() });
result.state.baselineOrders = state.orders;
result.summary.migration = true;
for (const event of Object.values(result.state.events)) event.migration = true;
result.state.meta.lastReportDate = reportDate;
await store.writeState(result.state, etag);
console.log('Initialized:', counts(result.state), result.summary);
