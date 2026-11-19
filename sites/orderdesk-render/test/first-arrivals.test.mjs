import test from 'node:test';
import assert from 'node:assert/strict';
import { planFirstArrivals } from '../lib/first-arrivals.mjs';

test('reserve both original ranges before lending a duplicate to a store missing its SRP', () => {
  const models = ['SRC22','SRP19'];
  const dealers = ['geelong','other'].map(slug => ({slug,lead:3,target:10,cap:12,weeklyStock:1,my2027Yard:[],
    assumptions:{receiving:true,models,currentStock:slug==='geelong'?20:0}}));
  const locked = [
    ['SRC-A','SRC22','geelong','other','2027-03-19'],
    ['SRP-A','SRP19','geelong','other','2027-03-19'],
    ['SRC-B','SRC22','other','other','2027-03-22'],
    ['SRP-B','SRP19','geelong','geelong','2027-05-03']
  ].map(([chassis,model,from,to,day],slotOrder) => ({chassis,model,from,to,modelYear:'2027',policy:'display',group:'locked',
    kind:'stock',action:'keep',receive:true,slotOrder,originalAu:day,plannedAu:day,plannedArrival:day}));
  const input={today:'2026-11-19',end:'2027-12-31',dealers,locked,following:[],actions:locked,assumptions:{exchangeSlots:true,finishDates:{}},signed:()=>true};
  const result=planFirstArrivals(input);
  assert.equal(new Set(result.map(r=>r[0])).size,4);
  for (const id of ['SRC-A','SRP-A']) {
    const [slot,,store]=result.find(r=>r[1]===id);
    assert.equal(store,'geelong');
    assert.equal(locked[slot].plannedAu,'2027-03-19');
  }
  assert.equal(result.find(r=>r[1]==='SRP-B')[2],'other');
});
