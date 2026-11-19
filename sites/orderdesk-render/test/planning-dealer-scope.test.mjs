import test from 'node:test';
import assert from 'node:assert/strict';
import { excludedPlanningDealer, configureDealers } from '../lib/dealership.mjs';
import { buildStockSimulation } from '../lib/stock-simulator.mjs';
test('excluded dealer names and portal slugs cannot donate, receive or appear in a simulation, including stale saved inputs', () => {
 const names=['Newcastle Caravans & RV','Auswide','Caravan and Camper WA','Green Show','Coast To Country','MotorHub'];
 for(const name of [...names,'newcastle-caravans-rv','caravan-and-camper-wa']) assert.equal(excludedPlanningDealer(name),true);
 assert.equal(excludedPlanningDealer('Frankston'),false);
 const ds=names.concat('Frankston').map(name=>({name,slug:name==='Frankston'?'frankston':name.toLowerCase().replace(/[^a-z]+/g,'-'),own:false,target:20,travelDays:3,yard:{stock:0},transit:{stock:0},vehicles:[],handover:{months:[],avgStock:0,thisMonth:{stock:0}}}));
 assert.equal(configureDealers(ds,{},'2026-11-19').length,1);
 const report=buildStockSimulation({dealers:ds,today:'2026-11-19',rows:[{chassis:'SRC000001',dealer:'MotorHub',customer:'Stock',model:'SRC21',modelYear:'2027',group:'locked',auEnd:'2027-01-01'}],assumptions:{dealers:ds.map(d=>({slug:d.slug})),finishDates:{SRC000001:'2027-02-01'}}});
 assert.equal(report.independent.dealers.length,1);assert.equal(report.independent.actions.length,0);assert.equal(report.finishRows.length,0);assert.equal(report.warnings.length,0);
 for(const name of names) assert.ok(!JSON.stringify(report).includes(name));
});
