import {applyReport,dayInSydney,reportFingerprint} from './order-engine.mjs';
import {parseCrmWorkbook} from './crm-workbook.mjs';
import {MAIL_TARGET,MAX_ATTACHMENT_BYTES} from './outlook-report.mjs';
import {isFreshMail,mailWindow} from '../planning-pc/schedule.mjs';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export function planningAgentStatus(env={},state={},now=new Date()){
  const saved=state.meta?.planningAgent||{};
  const expectedDay=dayInSydney(new Date(now.getTime()-30*60*1000));
  return {mode:'planning-pc',target:MAIL_TARGET,schedule:'00:20 Australia/Sydney',window:'Inbox + CRM Report, 00:00 to the scan',windowMinutes:20,configured:typeof env.PLANNING_AGENT_TOKEN==='string'&&env.PLANNING_AGENT_TOKEN.length>=32,enabled:env.PLANNING_AGENT_ENABLED==='true',lastCheckedAt:saved.lastCheckedAt||null,lastSuccessAt:saved.lastSuccessAt||null,lastError:saved.lastError||null,lastRun:saved.lastRun||null,stale:!!saved.lastSuccessAt&&dayInSydney(new Date(saved.lastSuccessAt))<expectedDay};
}
export const agentAuthorized=(request,token)=>authorized(request,token);
async function authorized(request,token){
  if(typeof token!=='string'||token.length<32)return false;
  const supplied=request.headers.get('authorization')||'';
  if(supplied.length>1024)return false;
  const digest=s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  const [a,b]=await Promise.all([digest(supplied),digest('Bearer '+token)]);
  const av=new Uint8Array(a),bv=new Uint8Array(b);let mismatch=0;for(let i=0;i<av.length;i++)mismatch|=av[i]^bv[i];return mismatch===0;
}
async function readBytes(request){
  if(Number(request.headers.get('content-length'))>MAX_ATTACHMENT_BYTES)throw new Error('size');
  const reader=request.body?.getReader();if(!reader)throw new Error('empty');const parts=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_ATTACHMENT_BYTES)throw new Error('size');parts.push(value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;
}
export async function handlePlanningAgent(request,{env={},read,write,parse=parseCrmWorkbook,now=new Date()}){
  if(!await authorized(request,env.PLANNING_AGENT_TOKEN))return json({error:'Agent authorization required'},401);
  if(request.method!=='POST')return json({error:'POST required'},405);
  const action=request.headers.get('x-agent-action');
  if(!['plan','verify','report','heartbeat','missing','error'].includes(action))return json({error:'Invalid action'},400);
  if(!['plan','verify'].includes(action)&&env.PLANNING_AGENT_ENABLED!=='true')return json({error:'Planning computer import is not enabled'},409);
  try{
    const {state,etag}=await read();if(!state)return json({error:'Initial order data required'},409);
    if(action==='plan')return json({lastReportDate:state.meta?.lastReportDate||dayInSydney(now),...mailWindow(now),target:MAIL_TARGET,enabled:env.PLANNING_AGENT_ENABLED==='true'});
    const at=now.toISOString(),prior=state.meta?.planningAgent||{};
    if(action==='heartbeat'||action==='error'||action==='missing'){
      const marker=action==='heartbeat'?{lastCheckedAt:at,lastSuccessAt:at,lastError:null}:{lastCheckedAt:at,lastError:action==='missing'?'00:20 检查未收到当天 00:00 之后的 CRM 报告（Inbox 和 CRM Report 都找过），未使用旧邮件':'Planning 电脑读取或上传失败，请检查电脑端日志'};
      await write({...state,meta:{...state.meta,planningAgent:{...prior,...marker}}},etag);return json({ok:true});
    }
    const scan=request.headers.get('x-scan-started-at'),received=request.headers.get('x-mail-received-at');
    const scanMs=Date.parse(scan||'');
    if(!Number.isFinite(scanMs)||scanMs>now.getTime()||now.getTime()-scanMs>12*60*1000||!isFreshMail(received,mailWindow(new Date(scanMs)).windowStartUtc,new Date(scanMs).toISOString()))return json({error:'Only mail received between 00:00 and the scan (at most 30 minutes) is accepted'},400);
    const report=await parse(await readBytes(request));
    if(report.reportDate>dayInSydney(now))return json({error:'Future report rejected'},400);
    const id=await reportFingerprint(report.records,report.reportDate);
    const old=report.reportDate<(state.meta?.lastReportDate||'');
    const result=old?{state,duplicate:false,summary:null}:applyReport(state,report.records,{batchId:id,fileName:'Planning Outlook CRM Report.xlsx',businessDate:dayInSydney(now),reportDate:report.reportDate,now:at});
    const outcome=old?'older_report_skipped':result.duplicate?'duplicate':'imported';
    const run={reportDate:report.reportDate,rows:report.records.length,outcome,summary:result.summary};
    if(action==='verify')return json({ok:true,dryRun:true,...run});
    let next=result.state;
    if(outcome==='imported')next={...next,imports:{...next.imports,[id]:{...result.summary,source:'planning-pc'}},meta:{...next.meta,lastReportDate:report.reportDate}};
    // A report receipt is not a heartbeat: only a completed mailbox scan marks success.
    next={...next,meta:{...next.meta,planningAgent:{...prior,lastReportAt:at,lastRun:run}}};
    await write(next,etag);return json({ok:true,...run});
  }catch{return json({error:'Report was not committed; retry after checking the file and connection'},409);}
}
