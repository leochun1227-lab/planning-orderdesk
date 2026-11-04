export const PRODUCTION_SHEETS=['PGI','Dispatch Special','Production API','Reference','Longtree API'];
const headers={'PGI':['SERNR'],'Dispatch Special':['Dispatch.id'],'Production API':['Production.id','Production.location'],'Reference':['Production Status','Schedule Status'],'Longtree API':['Chassis','Online Date']};
const widths={'PGI':1,'Dispatch Special':1,'Production API':3,'Reference':2,'Longtree API':5};
const chassis=value=>String(value??'').replace(/[-\s]/g,'').toUpperCase();
const lookupKey=value=>String(value??'').trim().toLowerCase();
const present=value=>value!==null&&value!==undefined&&value!=='';
export function parseProductionSources(sheets){
 const result={};
 for(const name of PRODUCTION_SHEETS){
  const rows=sheets?.[name];
  if(!Array.isArray(rows)||!rows.length||rows.length>50000)throw new Error(`生产数据缺少或无效: ${name}`);
  if(headers[name].some((header,i)=>String(rows[0]?.[i]??'').trim()!==header))throw new Error(`生产数据表头无效: ${name}`);
  result[name]=rows.map(row=>{
   if(!Array.isArray(row))throw new Error(`生产数据行无效: ${name}`);
   return Array.from({length:widths[name]},(_,i)=>{
    const value=row[i]??'';
    if(!['string','number'].includes(typeof value)||String(value).length>1000)throw new Error(`生产数据字段无效: ${name}`);
    return value;
   });
  });
 }
 return result;
}
// Same precedence as Orderlist's LET formula, using source records, never its D result.
export function createProductionResolver(sources){
 const finished=new Set([...sources.PGI.slice(1),...sources['Dispatch Special'].slice(1)].map(row=>chassis(row[0])).filter(Boolean));
 const index=(rows,key)=>{const map=new Map();for(const row of rows.slice(1)){const id=key(row[0]);if(id&&!map.has(id))map.set(id,row);}return map;};
 const production=index(sources['Production API'],chassis),reference=index(sources.Reference,lookupKey),longtree=index(sources['Longtree API'],chassis);
 return value=>{
  const id=chassis(value);if(!id)return '';
  if(finished.has(id))return 'Finished';
  const location=production.get(id)?.[1],mapped=present(location)?reference.get(lookupKey(location))?.[1]:'';
  if(present(mapped))return String(mapped);
  const row=longtree.get(id);
  if(present(row?.[3]))return 'Van on the sea';
  if(present(row?.[2])||present(row?.[4]))return 'Production Commenced Longtree';
  return '';
 };
}
