import {parseProductionSources,createProductionResolver} from './production-rules.mjs';
export const FIELD_LABELS = {modelYear:'Model Year',model:'Model',dealer:'Dealer',customer:'Customer',requestDate:'Request date',specAt:'Plans Sent to Dealer',signedAt:'Signed Plans Received',purchaseAt:'Purchase Order Sent',status:'状态',productionStatus:'Regent Production',receivedAt:'Order Received Date',sentLongtreeAt:'Order Sent to Longtree'};
export const statusFromProduction = (productionStatus,status='active') => status==='cancelled'?'cancelled':String(productionStatus??'').trim().toLowerCase()==='finished'?'completed':status;
export const normalizeChassis = v => String(v ?? '').replace(/[-\s]/g,'').toUpperCase();
export const displayChassis = v => {const k=normalizeChassis(v);return k.length>3?k.slice(0,3)+'-'+k.slice(3):k;};
export const normalizedName = v => String(v??'').toLowerCase().replace(/[<>]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function dayInSydney(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
export function toDay(v){
  if(v===null||v===undefined||v==='')return null;
  if(v instanceof Date)return v.toISOString().slice(0,10);
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){const n=Number(v);if(n<=366&&n>=0)return 'ASAP';if(n>20000&&n<100000)return new Date(Date.UTC(1899,11,30)+Math.floor(n)*86400000).toISOString().slice(0,10);return null;}
  const s=String(v).trim();if(/^asap$/i.test(s)||/^1900[-/]/.test(s)||/\/1900$/.test(s))return 'ASAP';
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:null;
}
export function requestDay(v){const day=toDay(v);if(!day||day==='ASAP')return day;const d=new Date(day+'T12:00:00Z');return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-1,1)).toISOString().slice(0,10);}
export function waitingDays(o,today=dayInSydney()){if(!o.specAt||o.signedAt||['cancelled','completed'].includes(o.status))return null;const d=Math.floor((Date.parse(today+'T00:00:00Z')-Date.parse(o.specAt+'T00:00:00Z'))/86400000);return Number.isFinite(d)?d:null;}
export const isOverdue = (o,today) => {const days=waitingDays(o,today);return days!==null&&days>=5;};
export const REVIEWED_STOCK_CUSTOMERS = ['newcastle caravans rvs','the caravan hub townsville','vanari caravans marsden point','united rv pty ltd','regent rv traralgon','leisure lion pty ltd','snowy river wangaratta store','regent rv pty ltd','snowy river perth'];
// These records identify people as well as a company; retain the full customer text.
const PERSONAL_COMPANY_CUSTOMERS = new Set(['turnkey international pty ltd luke chant','kylie morley zaytype pty ltd','cali pty ltd damien hancock','jim selby dragonfly industries pty ltd','tjm building pty ltd tom mcinnes']);
export function customerName(raw,refs={}){
 const s=String(raw??'').trim();let normalized=normalizedName(s);
 const words=normalized.split(' ');if(words.length%2===0){const half=words.length/2;if(words.slice(0,half).join(' ')===words.slice(half).join(' '))normalized=words.slice(0,half).join(' ');}
 normalized=normalized.replace(/ stock$/,'');
 if(PERSONAL_COMPANY_CUSTOMERS.has(normalized)||/\bcustomer\b/.test(normalized))return s;
 const names=[...(refs.dealerNames||[]).map(normalizedName),...REVIEWED_STOCK_CUSTOMERS,'dway plant hire','regent rv factory','regentrv factory','leisure lion toowoomba','leisure lion newcastle','vanari caravans','snowy river townsville','green rv forest glen','green rv slacks creek','regent rv perth','regent rv frankston','abco caravan services pty ltd','leisure lion bundaberg','vanari caravans christchurch','vanari christchurch','destiny rv store'];
 const dealerBrand=/^(?:snowy\s?river|regent\s?rv|leisure lion|vanari|destiny rv|green rv)\b/.test(normalized);
 const caravanBusiness=/\b(?:caravans?|rvs?)\b/.test(normalized);
 // Personal names with parenthesized company details remain personal records.
 const company=/\bpty\b/.test(normalized)&&(!/[()]/.test(s)||/\((?:wa|nsw|vic|qld|sa|nt|tas|act|aust|australia)\)/i.test(s));
 return normalized==='stock'||names.includes(normalized)||dealerBrand||caravanBusiness||company?'Stock':s;
}
export function parseReportRows(rows){
  const header=rows.findIndex(r=>r.some(v=>String(v??'').trim()==='Car Frame Number')&&r.some(v=>String(v??'').trim()==='Quote Status'));
  if(header<0)throw new Error('未找到 CRM 报告表头');
  const columns=rows[header].map(v=>String(v??'').trim());const get=(r,key)=>r[columns.indexOf(key)];
  const records=rows.slice(header+1).map((r,i)=>({chassis:normalizeChassis(get(r,'Car Frame Number')),quoteStatus:String(get(r,'Quote Status')??'').trim().toUpperCase(),description:String(get(r,'Product Description')??''),dealerCode:String(get(r,'Quote Dealer Store')??'').replace(/[<>]/g,'').trim(),customer:String(get(r,'C Customer')??''),expectedDate:get(r,'Expected Delivery Date')??null,sourceRow:header+i+2,changedAt:get(r,'Quote Status Change Date')??null})).filter(r=>r.chassis&&r.chassis!=='#'&&r.quoteStatus);
  if(!records.length||records.length>30000)throw new Error('报告记录数量无效');return records;
}
export async function reportFingerprint(records,reportDate){const canonical=records.map(r=>({chassis:normalizeChassis(r.chassis),quoteStatus:r.quoteStatus,description:r.description,dealerCode:r.dealerCode,customer:r.customer,expectedDate:toDay(r.expectedDate),sourceRow:r.sourceRow,changedAt:toDay(r.changedAt)}));const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({reportDate,records:canonical})));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
export function applyReport(state,records,{batchId,fileName,businessDate,reportDate,now}){
  if(state.imports?.[batchId])return {state,duplicate:true,summary:state.imports[batchId]};
  const orders={...(state.orders||{})}, events={...(state.events||{})}, refs=state.refs||{};
  const production=state.productionSources?createProductionResolver(state.productionSources):null;
  const grouped=new Map();for(const r of records){const k=normalizeChassis(r.chassis);if(!k||!r.quoteStatus)continue;if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(r);}
  const excluded=new Set(refs.excluded||[]);let count=0;
  const summary={id:batchId,fileName,businessDate,reportDate:reportDate||businessDate,processedAt:now,rows:records.length,newCount:0,changedCount:0,cancelledCount:0,reviewCount:0};
  for(const [key,rs] of grouped){
    const old=orders[key];const isCancel=rs.length===1&&rs[0].quoteStatus==='CANCELLED';
    if(isCancel){if(old&&old.status!=='cancelled'){orders[key]={...old,status:'cancelled',cancelledAt:businessDate,updatedAt:now};const id=`${batchId}_${count++}`;events[id]={id,orderId:key,chassis:old.chassis,dealer:old.dealer,type:'cancelled',date:businessDate,at:now,batchId,changes:[{field:'status',before:old.status,after:'cancelled'}],snapshot:{...old},sourceRows:rs.map(r=>r.sourceRow)};summary.cancelledCount++;}continue;}
    if(excluded.has(key))continue;
    const active=rs.filter(r=>r.quoteStatus!=='CANCELLED');if(!active.length)continue;const r=active[0];
    if(old?.status==='cancelled'){summary.reviewCount++;continue;}
    const isNew=!old;const dealer=isNew?(refs.dealers?.[r.dealerCode]||''):(old.dealer||'');
    const o=old?{...old}:{id:key,chassis:displayChassis(key),modelYear:r.description.slice(0,4),model:r.description.slice(5),dealer:dealer||'待核对',customer:customerName(r.customer,refs),requestDate:null,receivedAt:businessDate,sentLongtreeAt:businessDate,specAt:null,signedAt:null,purchaseAt:null,forecastDate:null,status:'active',productionStatus:'',createdAt:now,updatedAt:now};
    if(!dealer)summary.reviewCount++;
    const changes=[];const update=(field,value)=>{if((o[field]??null)!==(value??null)){changes.push({field,before:o[field]??null,after:value??null});o[field]=value;}};
    if(production)update('productionStatus',production(key));
    update('status',statusFromProduction(o.productionStatus,o.status));
    if(!isNew){update('customer',customerName(r.customer,refs));if(r.description){update('modelYear',r.description.slice(0,4));update('model',r.description.slice(5));}}
    const req=requestDay(r.expectedDate),existingRequest=toDay(o.requestDate);
    if(req&&(req!=='ASAP'||!existingRequest||existingRequest==='ASAP'))update('requestDate',req);
    const hasSpec=active.some(r=>r.quoteStatus==='FACTORY DRAWN');const hasSigned=active.some(r=>r.quoteStatus==='BUYER ORDERED');
    if(hasSpec&&!o.specAt)update('specAt',businessDate);
    if(hasSigned&&!o.signedAt){if(!o.specAt)update('specAt',businessDate);update('signedAt',businessDate);}
    if(o.signedAt&&!o.purchaseAt)update('purchaseAt',o.signedAt);
    if(isNew||changes.length){o.updatedAt=now;orders[key]=o;const id=`${batchId}_${count++}`;events[id]={id,orderId:key,chassis:o.chassis,dealer:o.dealer,type:isNew?'new':'changed',date:businessDate,at:now,batchId,changes,sourceRows:rs.map(r=>r.sourceRow)};if(isNew)summary.newCount++;else summary.changedCount++;}
  }
  return {state:{...state,orders,events,imports:{...state.imports,[batchId]:summary},meta:{...state.meta,lastImport:summary,updatedAt:now}},summary,duplicate:false};
}

export async function importProductionSources(state,input,{fileName,reportDate,businessDate,now,migration=false}){
 const sources=parseProductionSources(input);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(reportDate||'')||reportDate>businessDate||reportDate<(state.meta?.lastProductionReportDate||''))throw new Error('生产数据日期无效');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({kind:'production',sources,reportDate})));
 const batchId='production-'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 if(state.imports?.[batchId])return {state,duplicate:true,summary:state.imports[batchId]};
 const resolve=createProductionResolver(sources),orders={...state.orders},events={...state.events};
 const summary={id:batchId,kind:'production',fileName,businessDate,reportDate,processedAt:now,rows:Object.values(sources).reduce((n,rows)=>n+rows.length-1,0),newCount:0,changedCount:0,cancelledCount:0,reviewCount:0,migration};
 for(const [key,old] of Object.entries(orders)){
  const productionStatus=resolve(key),status=statusFromProduction(productionStatus,old.status),changes=[];
  for(const [field,value] of Object.entries({productionStatus,status}))if(old[field]!==value)changes.push({field,before:old[field]??null,after:value});
  if(!changes.length)continue;
  orders[key]={...old,productionStatus,status,updatedAt:now};
  const id=`${batchId}_${key}`;events[id]={id,orderId:key,chassis:old.chassis,dealer:old.dealer,type:'changed',date:businessDate,at:now,batchId,changes,migration,sourceFile:fileName,sourceKind:'production-sources'};
  summary.changedCount++;
 }
 return {duplicate:false,summary,state:{...state,orders,events,productionSources:sources,imports:{...state.imports,[batchId]:summary},meta:{...state.meta,updatedAt:now,lastProductionReportDate:reportDate,lastProductionImport:summary}}};
}

// Orderlist production state is independent of CRM drawing/signoff milestones.
// Only existing chassis are reconciled; blank cells do not erase known state.
export function applyProductionStatuses(state,records,{batchId,fileName,businessDate,now}){
  const grouped=new Map();
  for(const record of records){
    const key=normalizeChassis(record.chassis);if(!key)continue;
    if(grouped.has(key))throw new Error(`Duplicate Orderlist chassis: ${key}`);
    grouped.set(key,record);
  }
  const orders={...state.orders},events={...state.events};
  const summary={batchId,fileName,sourceSheet:'Orderlist',matched:0,missing:0,changed:0,completed:0,processedAt:now};
  for(const [key,record] of grouped){
    const old=orders[key];if(!old){summary.missing++;continue;}summary.matched++;
    const productionStatus=String(record.productionStatus??'').trim();if(!productionStatus)continue;
    const status=statusFromProduction(productionStatus,old.status);
    const changes=[];
    for(const [field,value] of Object.entries({productionStatus,status}))if(old[field]!==value)changes.push({field,before:old[field]??null,after:value});
    if(!changes.length)continue;
    if(old.status!=='completed'&&status==='completed')summary.completed++;
    orders[key]={...old,productionStatus,status,updatedAt:now};
    const id=`${batchId}_${key}`;
    if(events[id])throw new Error(`Production migration event already exists: ${id}`);
    events[id]={id,orderId:key,chassis:old.chassis,dealer:old.dealer,type:'changed',migration:true,date:businessDate,at:now,batchId,changes,sourceFile:fileName,sourceSheet:'Orderlist',sourceRows:[record.sourceRow]};
    summary.changed++;
  }
  if(!summary.changed)return {state,summary};
  return {state:{...state,orders,events,meta:{...state.meta,updatedAt:now,lastProductionSync:summary}},summary};
}
