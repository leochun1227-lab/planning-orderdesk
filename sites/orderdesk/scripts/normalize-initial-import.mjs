import fs from 'node:fs/promises';
import {readSecret} from './secure-input.mjs';
import {readState,writeState} from '../lib/crypto-store.mjs';
import {parseReportRows,reportFingerprint} from '../lib/order-engine.mjs';
const {key}=await readSecret();const {state,etag}=await readState(key);
const records=parseReportRows(JSON.parse(await fs.readFile('.sites-runtime/report.json','utf8')));const id=await reportFingerprint(records,'2026-10-28');
const prior=Object.values(state.imports).find(x=>x.migration&&x.reportDate==='2026-10-28');
if(prior&&prior.id!==id){const old=prior.id;state.imports[id]={...prior,id,previousId:old};delete state.imports[old];if(state.meta.lastImport?.id===old)state.meta.lastImport=state.imports[id];for(const event of Object.values(state.events))if(event.batchId===old)event.batchId=id;await writeState(state,key,etag);}
console.log(JSON.stringify({verified:!!(await readState(key)).state.imports[id]}));
