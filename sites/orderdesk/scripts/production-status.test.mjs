import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProductionStatuses,applyReport,isOverdue} from '../lib/order-engine.mjs';
const order={id:'SRC001',chassis:'SRC-001',status:'active',productionStatus:'',dealer:'Original Dealer',customer:'Stock',requestDate:'2027-01-01',specAt:'2026-10-01',signedAt:null,purchaseAt:null};
const state=()=>({orders:{SRC001:{...order}},events:{},imports:{},meta:{},refs:{}});
const options={batchId:'production',fileName:'planning.xlsm',businessDate:'2026-11-04',now:'2026-11-04T00:00:00Z'};
const records=[{chassis:'src-001',productionStatus:' Finished ',sourceRow:62}];
test('Orderlist Finished completes matched chassis without changing business fields, and is repeatable',()=>{
 const before=state(),result=applyProductionStatuses(before,records,options),o=result.state.orders.SRC001;
 assert.deepEqual(o,{...order,status:'completed',productionStatus:'Finished',updatedAt:options.now});
 assert.deepEqual(before,state());assert.equal(isOverdue(o,'2026-11-04'),false);
 assert.equal(result.summary.completed,1);
 assert.equal(Object.values(result.state.events)[0].sourceRows[0],62);
 assert.equal(applyProductionStatuses(result.state,records,options).state,result.state);
});
test('production import retains cancellation, ignores blanks and missing orders, rejects duplicate chassis',()=>{
 const s=state();s.orders.SRC001.status='cancelled';
 assert.equal(applyProductionStatuses(s,records,options).state.orders.SRC001.status,'cancelled');
 assert.equal(applyProductionStatuses(s,[{...records[0],productionStatus:''}],options).state,s);
 assert.equal(applyProductionStatuses(s,[{...records[0],chassis:'SRC002'}],options).summary.missing,1);
 assert.throws(()=>applyProductionStatuses(s,[...records,...records],options),/Duplicate/);
 assert.equal(applyProductionStatuses(state(),[{...records[0],productionStatus:'In Production'}],options).state.orders.SRC001.status,'active');
});
test('future CRM imports preserve completion and repair Finished/active inconsistency without replacing dates',()=>{
 for(const priorStatus of ['active','completed']){
  const s=state();s.orders.SRC001={...order,status:priorStatus,productionStatus:'Finished',signedAt:'2026-10-02',purchaseAt:'2026-10-03'};
  const r=applyReport(s,[{chassis:'SRC001',quoteStatus:'BUYER ORDERED',customer:'Stock',expectedDate:null,sourceRow:2}],{...options,batchId:'crm'});
  assert.equal(r.state.orders.SRC001.status,'completed');
  for(const field of ['productionStatus','specAt','signedAt','purchaseAt','requestDate','dealer'])assert.equal(r.state.orders.SRC001[field],s.orders.SRC001[field]);
 }
});
