import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProductionSources,createProductionResolver} from '../lib/production-rules.mjs';
import {applyReport,importProductionSources} from '../lib/order-engine.mjs';
const sources=()=>({'PGI':[['SERNR'],['SRC001']],'Dispatch Special':[['Dispatch.id'],['SRC002']],'Production API':[['Production.id','Production.location'],['SRC001','qc'],['SRC003','qc'],['SRC004','unknown'],['SRC007',''],['SRC007','qc']],'Reference':[['Production Status','Schedule Status'],['qc','Ready for Dispatch']],'Longtree API':[['Chassis','Online Date'],['SRC003','','x','y'],['SRC004','','x','y'],['SRC005','','x'],['SRC006','','','','x']]});
test('production precedence matches the Excel formula, with first-match lookups and missing-source validation',()=>{
 const resolver=createProductionResolver(parseProductionSources(sources()));
 for(const [id,status] of Object.entries({SRC001:'Finished',SRC002:'Finished',SRC003:'Ready for Dispatch',SRC004:'Van on the sea',SRC005:'Production Commenced Longtree',SRC006:'Production Commenced Longtree',SRC007:'',SRC008:''}))assert.equal(resolver(id),status,id);
 assert.equal(resolver('src-001'),'Finished');
 assert.throws(()=>parseProductionSources({...sources(),PGI:undefined}),/PGI/);
 assert.throws(()=>parseProductionSources({...sources(),Reference:[['wrong']]}),/Reference/);
});
test('raw-source import recalculates existing orders, persists sources and runs for newly arriving CRM chassis',async()=>{
 const order={id:'SRC001',chassis:'SRC-001',status:'active',productionStatus:'Wrong copied value',customer:'Stock',dealer:'A',specAt:'2026-10-01',signedAt:'2026-10-02',purchaseAt:'2026-10-03'};
 const initial={orders:{SRC001:order,SRC002:{...order,id:'SRC002',chassis:'SRC-002',status:'cancelled'}},events:{},imports:{},refs:{},meta:{lastReportDate:'2026-11-04'}};
 const options={fileName:'planning.xlsm',reportDate:'2026-11-04',businessDate:'2026-11-04',now:'2026-11-04T00:00:00Z'};
 const imported=await importProductionSources(initial,sources(),options);
 assert.equal(imported.state.orders.SRC001.status,'completed');assert.equal(imported.state.orders.SRC002.status,'cancelled');
 assert.equal(imported.state.orders.SRC001.purchaseAt,order.purchaseAt);assert.equal(imported.state.meta.lastReportDate,initial.meta.lastReportDate);
 assert.equal((await importProductionSources(imported.state,sources(),options)).duplicate,true);
 const crm=applyReport(imported.state,[{chassis:'SRC004',quoteStatus:'BUYER ORDERED',customer:'Stock',description:'2026 Model',dealerCode:'',expectedDate:null}],{...options,batchId:'crm'});
 assert.equal(crm.state.orders.SRC004.productionStatus,'Van on the sea');
 assert.equal(crm.state.orders.SRC004.purchaseAt,options.businessDate);
});
test('signoff fills a missing purchase date from the existing signed date and preserves populated dates',()=>{
 for(const [signedAt,purchaseAt,expected] of [['2026-10-08',null,'2026-10-08'],['2026-10-08','2026-10-26','2026-10-26'],[null,'2026-10-01','2026-10-01']]){
  const s={orders:{SRC001:{id:'SRC001',status:'active',signedAt,purchaseAt,specAt:'2026-10-01'}},events:{},imports:{},refs:{}};
  const r=applyReport(s,[{chassis:'SRC001',quoteStatus:'BUYER ORDERED',description:'',customer:'Stock'}],{batchId:'crm',businessDate:'2026-11-04',now:'2026-11-04T00:00:00Z'});
  assert.equal(r.state.orders.SRC001.purchaseAt,expected);assert.ok(r.state.orders.SRC001.signedAt);
 }
});
