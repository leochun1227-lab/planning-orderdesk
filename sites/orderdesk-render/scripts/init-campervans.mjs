// One-time: start tracking SRV/SRM (campervan) orders in Orderdesk (agreed 2026-11-05, option A:
// Orderdesk only, the Dealer Portal is read, never written).
//
//   node --env-file=.env scripts/init-campervans.mjs --crm=<CRM report.xlsx> [--enable-new] [--write]
//
// - Every SRV/SRM chassis in the Portal (motorhome order queue + campervanSchedule) becomes an
//   Orderdesk order with group "campervan"; milestones come from the Portal (signed-off date) and
//   the CRM report's quote status, using the same date rules as caravans.
// - CRM-cancelled SRV/SRM chassis that the Portal does not have are not created (Updating never did).
// - SRV/SRM chassis are removed from refs.excluded so daily CRM reports update them.
// - --enable-new also clears refs.excludedPrefixes, so brand-new SRV/SRM chassis in later CRM
//   reports are created as new campervan orders. Run it only after the code that keeps campervans
//   out of Orderlist slots is deployed.
import { readFile } from 'node:fs/promises';
import { normalizeChassis, displayChassis, customerName, requestDay } from '../lib/order-engine.mjs';
import { parseCrmWorkbook } from '../lib/crm-workbook.mjs';
import { createCampervanPlanSource, CAMPERVAN } from '../lib/campervan-plan.mjs';
import { store } from './_store.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
if (!args.crm) { console.error('Usage: init-campervans.mjs --crm=report.xlsx [--enable-new] [--write]'); process.exit(1); }
const report = await parseCrmWorkbook(new Uint8Array(await readFile(args.crm)));
const { plan, portalUpdatedAt } = await createCampervanPlanSource().current();
const { state, etag } = await store.readState();
const now = new Date().toISOString();

const crm = new Map();
for (const r of report.records) { const k = normalizeChassis(r.chassis); if (CAMPERVAN.test(k)) (crm.get(k) ?? crm.set(k, []).get(k)).push(r); }

const orders = { ...state.orders }, events = { ...state.events };
const stats = { created: 0, existing: 0, completed: 0, signed: 0, specOnly: 0, cancelledInCrm: 0 };
for (const [id, p] of Object.entries(plan)) {
  if (orders[id]) { stats.existing++; continue; }
  const rs = crm.get(id) || [];
  const active = rs.filter(r => r.quoteStatus !== 'CANCELLED');
  const r = active[0] || rs[0];
  const cancelled = rs.length === 1 && rs[0].quoteStatus === 'CANCELLED';
  const signed = active.some(x => x.quoteStatus === 'BUYER ORDERED') || !!p.signedOffDate;
  const spec = active.some(x => x.quoteStatus === 'FACTORY DRAWN');
  const signedAt = signed ? (p.signedOffDate || p.signedAt || report.reportDate) : null;
  const specAt = signedAt || (spec ? report.reportDate : null);        // signed without spec: spec = signed date
  const received = p.receivedAt || signedAt || report.reportDate;
  const finished = p.productionStatus === 'Finished';
  const o = {
    id, chassis: displayChassis(id), group: 'campervan',
    modelYear: r?.description?.slice(0, 4) || '', model: r?.description?.slice(5) || p.model || '',
    dealer: p.dealer || state.refs?.dealers?.[r?.dealerCode] || '待核对',
    customer: r ? customerName(r.customer, state.refs) : (p.customer || ''), crmCustomer: r ? String(r.customer ?? '').trim() : null,
    requestDate: r ? requestDay(r.expectedDate) : null,
    receivedAt: received, sentLongtreeAt: received, specAt, signedAt, purchaseAt: signedAt,
    forecastDate: p.forecastDate, productionStatus: p.productionStatus || '', vinNumber: p.vinNumber || null,
    status: cancelled ? 'cancelled' : finished ? 'completed' : 'active', cancelledAt: cancelled ? report.reportDate : null,
    createdAt: now, updatedAt: now,
  };
  orders[id] = o;
  if (cancelled) stats.cancelledInCrm++; else if (finished) stats.completed++; else if (signedAt) stats.signed++; else if (specAt) stats.specOnly++;
  stats.created++;
  const eid = `campervan-init_${id}`;
  events[eid] = { id: eid, orderId: id, chassis: o.chassis, dealer: o.dealer, type: 'new', date: report.reportDate, at: now, batchId: 'campervan-init', migration: true, changes: [{ field: 'status', before: null, after: o.status }], note: `Campervan tracking started from Dealer Portal (${portalUpdatedAt || 'n/a'})` };
}

const excluded = (state.refs?.excluded || []).filter(k => !CAMPERVAN.test(k));
const refs = { ...state.refs, excluded, excludedPrefixes: args['enable-new'] ? [] : (state.refs?.excludedPrefixes ?? ['SRV', 'SRM']) };
const summary = { id: 'campervan-init', kind: 'baseline', fileName: 'Dealer Portal SRV/SRM', businessDate: report.reportDate, reportDate: report.reportDate, processedAt: now, rows: Object.keys(plan).length, newCount: 0, changedCount: stats.created, cancelledCount: 0, reviewCount: 0, migration: true };
const next = { ...state, orders, events, refs, imports: { ...state.imports, ...(stats.created ? { 'campervan-init': summary } : {}) } };
console.log({ portalChassis: Object.keys(plan).length, crmCampervanChassis: crm.size, ...stats, removedFromExcluded: (state.refs?.excluded || []).length - excluded.length, excludedPrefixes: refs.excludedPrefixes });
if (args.out) await (await import('node:fs/promises')).writeFile(args.out, JSON.stringify(next));
if (args.write) { const r = await store.writeState(next, etag); console.log('written, revision', r.revision); }
