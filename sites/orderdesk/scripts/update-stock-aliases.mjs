import {readSecret} from './secure-input.mjs';
import {readState,writeState} from '../lib/crypto-store.mjs';
import {customerName,dayInSydney} from '../lib/order-engine.mjs';
const {key}=await readSecret();const {state,etag}=await readState(key);let changed=0;const now=new Date().toISOString();
for(const o of Object.values(state.orders)){const c=customerName(o.customer,state.refs);if(c===o.customer)continue;const before=o.customer;o.customer=c;const id='stock_alias_v1_'+o.id;state.events[id]={id,orderId:o.id,chassis:o.chassis,dealer:o.dealer,type:'changed',date:dayInSydney(),at:now,migration:true,changes:[{field:'customer',before,after:c}]};changed++;}
if(changed)await writeState(state,key,etag);const check=await readState(key);console.log(JSON.stringify({changed,verified:!!check.state,orders:Object.keys(check.state.orders).length}));
