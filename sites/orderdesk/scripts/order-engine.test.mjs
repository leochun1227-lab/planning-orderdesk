import test from 'node:test';
import assert from 'node:assert/strict';
import {applyReport,isOverdue,waitingDays,requestDay,customerName,dayInSydney,parseReportRows,reportFingerprint} from '../lib/order-engine.mjs';
const base=()=>({orders:{SRC001:{id:'SRC001',chassis:'SRC-001',modelYear:'2026',model:'SRH16',dealer:'Dealer A',customer:'Stock',status:'active',specAt:null,signedAt:null,purchaseAt:null,requestDate:'2026-11-01'}},events:{},imports:{},refs:{dealers:{'100':'Dealer A'},dealerNames:['dealer a'],excluded:[]},meta:{}});
const rec=(status='FACTORY DRAWN',chassis='SRC001')=>({chassis,quoteStatus:status,description:'2026 SRH16',dealerCode:'100',customer:'Dealer A',expectedDate:'2026-12-20',sourceRow:14});
const run=(s,rs,id='batch',date='2026-10-29')=>applyReport(s,rs,{batchId:id,fileName:'test.xlsx',businessDate:date,reportDate:date,now:date+'T00:05:00Z'});

test('reviewed company and dealer customers become Stock while personal names stay intact',()=>{
 const companyNames=['NEWCASTLE CARAVANS & RVS','The CARAVAN HUB - TOWNSVILLE','VANARI CARAVANS - MARSDEN POINT','UNITED RV PTY LTD','REGENT RV - TRARALGON','LEISURE LION PTY LTD','Snowy River Wangaratta Store','REGENT RV PTY LTD','Snowy River Perth'];
 for(const name of companyNames){
  for(const value of [name,`${name} ${name}`,`${name} Stock`])assert.equal(customerName(value,{}),'Stock',value);
  const result=run(base(),[{...rec('QUOTED'),customer:name}]);
  assert.equal(result.state.orders.SRC001.customer,'Stock');assert.equal(result.state.orders.SRC001.dealer,'Dealer A');
 }
 for(const name of ['Adam Chambers','TONY KEYMEL','david carroll','Paul Faulks','Stephen May','David Dunshea','Angela Etheridge','Tai-ling Hams','Wayne and MArie BOWDEN','geoffrey / melinda bentley/ larsen'])assert.equal(customerName(name,{}),name);
});

test('merchant recognition handles dealer brands, locations and businesses without treating personal names as shops',()=>{
 for(const name of ['SnowyRiver - New Branch','Snowy River New Branch','REGENT RV - TOWNSVILLE','DARIO CARAVANS - POORAKA','NEWCASTLE RV SUPER CENTRE - BERESFIELD','AUSWIDE CARAVAN & RV\'S','BENDIGO CARAVAN GROUP - BENDIGO','ABCO CARAVANS - BOAMBEE VALLEY','RUBBIE DUCKIE PTY LTD','Secure Roofing Pty Ltd','Destiny RV Att Brett March','Dway Plant Hire'])assert.equal(customerName(name),'Stock',name);
 for(const name of ['Peter Storey','Neil & Joanne Shires','CLINTON WILTSHIRE','Michael Storey','Kylie Morley (Zaytype Pty Ltd)','Jim Selby Dragonfly Industries Pty Ltd','TJM Building Pty Ltd Tom McInnes','Cali Pty Ltd (Damien Hancock)'])assert.equal(customerName(name),name,name);
});
test('spec then signoff preserves spec date across daily reports',()=>{let s=run(base(),[rec()]).state;assert.equal(s.orders.SRC001.specAt,'2026-10-29');s=run(s,[rec('BUYER ORDERED')],'next','2026-10-31').state;assert.equal(s.orders.SRC001.specAt,'2026-10-29');assert.equal(s.orders.SRC001.signedAt,'2026-10-31');assert.equal(s.orders.SRC001.purchaseAt,'2026-10-31');const r=run(s,[rec('BUYER ORDERED')],'third','2026-11-01');assert.equal(r.summary.changedCount,0);});
test('signoff without spec fills all three dates',()=>{const o=run(base(),[rec('BUYER ORDERED')]).state.orders.SRC001;assert.deepEqual([o.specAt,o.signedAt,o.purchaseAt],['2026-10-29','2026-10-29','2026-10-29']);});
test('cancellation is duplicate aware, archived, and replay safe',()=>{let s=base();assert.equal(run(s,[rec('CANCELLED'),rec('BUYER ORDERED')]).summary.cancelledCount,0);let r=run(s,[rec('CANCELLED')]);assert.equal(r.state.orders.SRC001.status,'cancelled');assert.equal(Object.values(r.state.events)[0].snapshot.status,'active');assert.equal(run(r.state,[rec('CANCELLED')]).duplicate,true);assert.equal(run(r.state,[rec('BUYER ORDERED')],'next').state.orders.SRC001.status,'cancelled');});
test('new chassis normalization, exclusions, and stock aliases',()=>{const s=base();s.refs.excluded=['SRC003'];const r=run(s,[rec('BUYER ORDERED','SRC-002'),rec('BUYER ORDERED','SRC003')]);assert.equal(r.summary.newCount,1);assert.equal(r.state.orders.SRC002.customer,'Stock');assert.equal(customerName('Dealer A Dealer A',s.refs),'Stock');assert.equal(customerName('REGENT RV-FACTORY REGENT RV-FACTORY',s.refs),'Stock');assert.equal(customerName('Alex Example',s.refs),'Alex Example');});
test('request date preserves prior-month-first-day and ASAP and blank',()=>{assert.equal(requestDay('2026-12-20'),'2026-11-01');assert.equal(requestDay('2026-01-05'),'2025-12-01');assert.equal(requestDay(2),'ASAP');assert.equal(requestDay('1900-01-02'),'ASAP');assert.equal(run(base(),[{...rec(),expectedDate:null}]).state.orders.SRC001.requestDate,'2026-11-01');});
test('five calendar days across a weekend and DST, excluding signed and cancelled',()=>{const o={status:'active',specAt:'2026-10-01',signedAt:null};assert.equal(waitingDays(o,'2026-10-06'),5);assert.equal(isOverdue(o,'2026-10-05'),false);assert.equal(isOverdue(o,'2026-10-06'),true);assert.equal(isOverdue({...o,signedAt:'2026-10-03'},'2026-10-06'),false);assert.equal(isOverdue({...o,status:'cancelled'},'2026-10-06'),false);assert.equal(dayInSydney(new Date('2026-10-28T13:05:00Z')),'2026-10-29');});
test('report parsing requires actual CRM headers',()=>{assert.throws(()=>parseReportRows([['not a CRM report']]),/表头/);});
test('fingerprint normalizes Excel serial and ISO dates while recording a fresh report day',async()=>{const a={...rec(),expectedDate:2};assert.equal(await reportFingerprint([a],'2026-10-29'),await reportFingerprint([{...a,expectedDate:'1900-01-02'}],'2026-10-29'));assert.notEqual(await reportFingerprint([a],'2026-10-29'),await reportFingerprint([a],'2026-10-30'));});

test('daily CRM updates customer while preserving an existing dealer',()=>{
 const s=base();s.refs.dealers['200']='Different dealer';
 const record={...rec('QUOTED'),dealerCode:'200',customer:'Alex Example'};
 const result=run(s,[record]);
 assert.equal(result.state.orders.SRC001.dealer,'Dealer A');
 assert.equal(result.state.orders.SRC001.customer,'Alex Example');
 assert.equal(Object.values(result.state.events).some(e=>e.changes.some(c=>c.field==='dealer')),false);
 assert.equal(run(s,[{...record,chassis:'SRC002'}]).state.orders.SRC002.dealer,'Different dealer');
 s.orders.SRC001.dealer='';
 assert.equal(run(s,[record]).state.orders.SRC001.dealer,'');
});

test('confirmed Stock customer aliases normalize punctuation, case and duplicated names',()=>{
 for(const raw of ['REGENT RV - PERTH','regent rv - frankston','ABCO CARAVAN SERVICES PTY LTD','REGENT RV - PERTH REGENT RV - PERTH','ABCO CARAVAN SERVICES PTY LTD Stock'])assert.equal(customerName(raw,{}),'Stock');
 assert.equal(customerName('Alex Regent',{}),'Alex Regent');
 assert.equal(customerName('ABCO Caravan Services Customer',{}),'ABCO Caravan Services Customer');
});

test('concrete CRM request dates update; ASAP and blank preserve existing concrete dates',()=>{
 for(const expectedDate of [null,'',2,'ASAP','1900-01-02']){
  const result=run(base(),[{...rec('QUOTED'),expectedDate}]);
  assert.equal(result.state.orders.SRC001.requestDate,'2026-11-01');
  assert.equal(result.summary.changedCount,0);
 }
 assert.equal(run(base(),[{...rec('QUOTED'),expectedDate:'2027-03-20'}]).state.orders.SRC001.requestDate,'2027-02-01');
 for(const old of [null,'','ASAP']){
  const s=base();s.orders.SRC001.requestDate=old;
  assert.equal(run(s,[{...rec('QUOTED'),expectedDate:'2027-03-20'}]).state.orders.SRC001.requestDate,'2027-02-01');
  assert.equal(run(s,[{...rec('QUOTED'),expectedDate:2}]).state.orders.SRC001.requestDate,'ASAP');
 }
});

test('confirmed Bundaberg, Christchurch and Destiny customers become Stock without changing dealer',()=>{
 for(const customer of ['LEISURE LION - BUNDABERG','Leisure Lion Bundaberg','VANARI CARAVANS - CHRISTCHURCH','Vanari Christchurch','Destiny RV Store','Destiny RV Store Destiny RV Store']){
  const s=base();s.orders.SRC001.dealer='Preserved Dealer';
  const result=run(s,[{...rec('QUOTED'),customer}]);
  assert.equal(customerName(customer,{}),'Stock');
  assert.equal(result.state.orders.SRC001.customer,'Stock');
  assert.equal(result.state.orders.SRC001.dealer,'Preserved Dealer');
 }
 assert.equal(customerName('Destiny Smith',{}),'Destiny Smith');
});
