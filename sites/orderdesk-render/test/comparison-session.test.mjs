import test from 'node:test';
import assert from 'node:assert/strict';
import {seedHistory,importLatest} from '../lib/comparison-session.mjs';
const refs={dealers:{A:'Dealer A'},dealerNames:['dealer a'],excluded:[]};
const record=(chassis,status='QUOTED',extra={})=>({chassis,quoteStatus:status,description:'2026 SRH16',dealerCode:'A',customer:'Dealer A',expectedDate:'2026-12-20',sourceRow:14,...extra});
const report=(records,date='2026-10-28')=>({records,fileName:'crm.xlsx',reportDate:date});
test('browser workflow seeds history then imports using shared business engine',()=>{
 const history=seedHistory(report([record('SRC001','FACTORY DRAWN'),record('SRC002'),record('SRC003'),record('SRC005')],'2026-10-27'),refs);
 assert.equal(Object.keys(history.events).length,0);
 const before=JSON.stringify(history);
 const result=importLatest(history,report([record('SRC001','BUYER ORDERED'),record('SRC002','CANCELLED'),record('SRC003','CANCELLED'),record('SRC003'),record('SRC004','BUYER ORDERED')]));
 assert.deepEqual([result.summary.newCount,result.summary.changedCount,result.summary.cancelledCount],[1,1,1]);
 assert.equal(result.state.orders.SRC001.specAt,'2026-10-27');assert.equal(result.state.orders.SRC001.signedAt,'2026-10-28');
 assert.equal(result.state.orders.SRC004.requestDate,'2026-11-01');assert.equal(result.state.orders.SRC004.customer,'Stock');
 assert.equal(result.state.orders.SRC003.status,'active');assert.equal(result.state.orders.SRC005.status,'active');
 assert.equal(JSON.stringify(history),before);
 assert.ok(Object.values(result.state.events).find(e=>e.type==='cancelled').snapshot);
});
test('identical files are actually imported and yield zero business changes',()=>{
 const input=report([record('SRC001','BUYER ORDERED'),record('SRC002','FACTORY DRAWN')]);
 const result=importLatest(seedHistory(input,refs),input);
 assert.equal(result.duplicate,false);assert.equal(result.summary.rows,2);
 assert.deepEqual([result.summary.newCount,result.summary.changedCount,result.summary.cancelledCount],[0,0,0]);
 assert.equal(Object.keys(result.state.imports).length,1);
});
test('date order is validated; unknown dates cannot become invented dates',()=>{
 const history=seedHistory(report([record('SRC001')]),refs);
 assert.throws(()=>importLatest(history,report([record('SRC001')],'2026-10-27')),/LATEST_BEFORE_HISTORY/);
 assert.throws(()=>seedHistory(report([record('SRC001')],''),refs),/REPORT_DATE_REQUIRED/);
});
