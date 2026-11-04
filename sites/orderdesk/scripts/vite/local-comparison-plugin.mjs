import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import ExcelJS from 'exceljs';
import {makeReport,seedHistory} from '../../lib/comparison-session.mjs';
import {applyReport,dayInSydney,reportFingerprint,importProductionSources} from '../../lib/order-engine.mjs';
import {MAIL_TARGET} from '../../lib/outlook-report.mjs';
import {planningAgentStatus} from '../../lib/planning-agent.mjs';
import {buildOrderlist} from '../../lib/orderlist-export.mjs';

// Checkout-local test database. Imports use the application's production engine.
// No source data or test state is included in a published build.
export function localComparison(){
 return {name:'orderdesk-local-test',apply:'serve',async configureServer(server){
  const runtime=resolve(server.config.root,'.sites-runtime');
  let config;try{config=JSON.parse(await readFile(resolve(runtime,'local-test-config.json'),'utf8'));}catch{return;}
  if(!config.enabled)return;
  const readReport=async(fileName,displayName)=>{
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(await readFile(resolve(runtime,fileName)));
   const cell=v=>v instanceof Date?v.toISOString().slice(0,10):v&&typeof v==='object'?'result'in v?cell(v.result):v.richText?v.richText.map(x=>x.text).join(''):v.text??null:v;
   for(const sheet of wb.worksheets){const rows=[];sheet.eachRow({includeEmpty:true},row=>{rows[row.number-1]=Array.from({length:sheet.columnCount},(_,i)=>cell(row.getCell(i+1).value));});if(rows.some(r=>r?.includes('Car Frame Number')&&r?.includes('Quote Status')))return makeReport(rows,displayName,sheet.name,'');}
   throw new Error('CRM report headers missing');
  };
  if(!config.historyFile||!config.historyName||!config.seedId)throw new Error('Local test history is not configured');
  let state;
  try{const saved=JSON.parse(await readFile(resolve(runtime,'local-test-state.json'),'utf8'));if(saved.meta?.localTest&&saved.meta?.seedId===config.seedId)state=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!state){
   const [previous,refs]=await Promise.all([readReport(config.historyFile,config.historyName),readFile(resolve(runtime,'comparison-refs.json'),'utf8').then(JSON.parse)]);
   state=seedHistory(previous,refs);
   const batchId=await reportFingerprint(previous.records,previous.reportDate);
   const initial={id:batchId,fileName:previous.fileName,businessDate:previous.reportDate,reportDate:previous.reportDate,processedAt:new Date().toISOString(),rows:previous.records.length,newCount:0,changedCount:0,cancelledCount:0,reviewCount:0,migration:true};
   state.imports[batchId]=initial;
   state.meta={...state.meta,localTest:true,seedId:config.seedId,lastImport:initial,lastReportDate:previous.reportDate,mailbox:'planning@regentv.com.au'};
  }
  const persist=()=>writeFile(resolve(runtime,'local-test-state.json'),JSON.stringify(state));await persist();
  let importing=false;
  server.middlewares.use(async(req,res,next)=>{
   const path=req.url?.split('?')[0];if(!['/api/orders','/api/import','/api/production','/api/mail-sync','/api/export'].includes(path))return next();
   const send=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Origin rejected'});
   if(path==='/api/export'){
    if(req.method!=='POST')return send(405,{error:'POST required'});
    if(!req.headers.origin||new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Origin rejected'});
    try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new Error('Export request too large');chunks.push(chunk);}const {ids}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!Array.isArray(ids)||ids.length>30000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!state.orders[id]))throw new Error('Invalid export selection');
     const bytes=await buildOrderlist(ids.map(id=>state.orders[id]),state.orderlistExport||{});res.statusCode=200;res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Cache-Control','no-store');res.end(Buffer.from(bytes));
    }catch(e){send(400,{error:e.message});}return;
   }
   if(path==='/api/mail-sync')return req.method==='GET'?send(200,{...planningAgentStatus({},state),localPreview:true}):send(409,{error:'等待 Planning 电脑接入；本地对账模式没有连接邮箱'});
   if(path==='/api/orders'&&req.method==='GET')return send(200,{orders:Object.values(state.orders),events:Object.values(state.events),imports:Object.values(state.imports),meta:state.meta});
   if(!['/api/import','/api/production'].includes(path)||req.method!=='POST')return send(405,{error:'Method not allowed'});
   if(importing)return send(409,{error:'正在导入，请稍后重试'});
   importing=true;
   try{
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024)throw new Error('文件过大');chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(path==='/api/production'){
     const result=await importProductionSources(state,input.productionSources,{fileName:String(input.fileName||'Production sources').slice(0,160),reportDate:input.reportDate,businessDate:dayInSydney(),now:new Date().toISOString()});
     state=result.state;if(!result.duplicate)await persist();return send(200,{summary:result.summary,duplicate:result.duplicate});
    }
    if(!Array.isArray(input.records)||input.records.length<1||input.records.length>30000)throw new Error('报告记录数量无效');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(input.reportDate)||input.reportDate<state.meta.lastReportDate||input.reportDate>dayInSydney())throw new Error('报告日期无效');
    const batchId=await reportFingerprint(input.records,input.reportDate);
    const result=applyReport(state,input.records,{batchId,fileName:input.fileName,businessDate:dayInSydney(),reportDate:input.reportDate,now:new Date().toISOString()});
    state={...result.state,meta:{...result.state.meta,lastReportDate:input.reportDate,localTest:true}};await persist();send(200,{summary:result.summary,duplicate:result.duplicate});
   }catch(e){send(400,{error:e.message});}finally{importing=false;}
  });
 }};
}
