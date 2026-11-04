import fs from 'node:fs/promises';
import { readSecret } from './secure-input.mjs';
import {readState,writeState} from '../lib/crypto-store.mjs';
import {parseReportRows,applyReport,dayInSydney,customerName,reportFingerprint} from '../lib/order-engine.mjs';
const {key}=await readSecret();
const current=await readState(key);if(current.state){console.log(JSON.stringify({alreadyInitialized:true,orders:Object.keys(current.state.orders).length}));process.exit(0);}
const state=JSON.parse(await fs.readFile('.sites-runtime/baseline.json','utf8'));
for(const o of Object.values(state.orders))o.customer=customerName(o.customer,state.refs);
const rows=JSON.parse(await fs.readFile('.sites-runtime/report.json','utf8'));const records=parseReportRows(rows);
const batchId=await reportFingerprint(records,'2026-10-28');
const result=applyReport(state,records,{batchId,fileName:'CRM Report · 28 Oct 2026.xlsx',businessDate:dayInSydney(),reportDate:'2026-10-28',now:new Date().toISOString()});
result.state.baselineOrders=state.orders;
result.summary.migration=true;
for(const event of Object.values(result.state.events))event.migration=true;
result.state.meta.lastReportDate='2026-10-28';await writeState(result.state,key,current.etag);
const check=await readState(key);if(Object.keys(check.state.orders).length!==Object.keys(result.state.orders).length)throw new Error('Readback failed');
console.log(JSON.stringify({verified:true,orders:Object.keys(check.state.orders).length,events:Object.keys(check.state.events).length,summary:result.summary}));
