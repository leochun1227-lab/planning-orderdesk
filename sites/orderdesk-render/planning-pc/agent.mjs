import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isScheduledMinute,isFreshMail} from './schedule.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const verifyOnly=process.argv.includes('--verify');
if(process.argv.includes('--scheduled')&&!isScheduledMinute()){
  console.log('Missed the 00:20 Australia/Sydney run; no catch-up scan performed.');process.exit(0);
}
const token=process.env.PLANNING_AGENT_TOKEN,siteToken=process.env.PLANNING_SITE_ACCESS_TOKEN;
const settings=JSON.parse((await readFile(resolve(root,'agent-settings.json'),'utf8')).replace(/^\uFEFF/,''));
const site=new URL(settings.siteUrl);
if(site.protocol!=='https:'||site.username||site.password||site.search||site.hash)throw new Error('Configure the HTTPS website origin');
if(typeof token!=='string'||token.length<32)throw new Error('Website agent token is not configured');
const endpoint=new URL('/api/planning-agent',site);
const runRoot=resolve(root,'.runs');await mkdir(runRoot,{recursive:true});
const directory=resolve(runRoot,randomUUID());await mkdir(directory);
let windowEndUtc;
async function call(action,bytes,receivedAt){
  const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+token,'x-agent-action':action,'Content-Type':'application/octet-stream',...(windowEndUtc?{'x-scan-started-at':windowEndUtc}:{}),...(receivedAt?{'x-mail-received-at':receivedAt}:{}),...(siteToken?{'OAI-Sites-Authorization':'Bearer '+siteToken}:{})},body:bytes});
  if(!response.ok)throw new Error('Website '+action+' failed (HTTP '+response.status+')');
  const data=await response.json();if(data.error)throw new Error('Website rejected '+action);return data;
}
function collect(since,until){return new Promise((accept,reject)=>{
  const powershell=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const args=['-NoProfile','-NonInteractive','-STA','-WindowStyle','Hidden','-File',resolve(root,'Read-PlanningReports.ps1'),'-SinceUtc',since,'-UntilUtc',until,'-OutputDirectory',directory];
  if(settings.storeId)args.push('-StoreId',settings.storeId);
  // Collector does not need website credentials.
  const childEnv={...process.env};delete childEnv.PLANNING_AGENT_TOKEN;delete childEnv.PLANNING_SITE_ACCESS_TOKEN;
  const child=spawn(powershell,args,{windowsHide:true,env:childEnv,stdio:['ignore','ignore','pipe']});
  let details='';child.stderr.on('data',b=>{details=(details+b.toString()).slice(-3000);});
  const timeout=setTimeout(()=>child.kill(),180000);
  child.on('error',e=>{clearTimeout(timeout);reject(e);});child.on('exit',code=>{clearTimeout(timeout);code===0?accept():reject(new Error(details||'Outlook collection timed out or failed'));});
});}
try{
  const plan=await call('plan');
  if(!verifyOnly&&!plan.enabled)throw new Error('Website import is disabled. Run the read-only verification first.');
  if(!isFreshMail(plan.windowEndUtc,plan.windowStartUtc,plan.windowEndUtc))throw new Error('Website returned invalid 30-minute mail window');
  windowEndUtc=plan.windowEndUtc;
  await collect(plan.windowStartUtc,plan.windowEndUtc);
  const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
  if(manifest.mailbox!=='planning@regentrv.com.au'||manifest.folder!=='CRM Report'||!Array.isArray(manifest.reports)||manifest.reports.length>100)throw new Error('Collector manifest invalid');
  const reports=[];
  // Validate all files first, then import by embedded report date (not received order).
  for(const report of manifest.reports){
    if(!isFreshMail(report.receivedAt,plan.windowStartUtc,plan.windowEndUtc))throw new Error('Collector returned mail outside the last 30 minutes');
    if(!/^[a-f0-9]{64}\.xlsx$/.test(report.file))throw new Error('Invalid local report filename');
    const bytes=await readFile(resolve(directory,report.file));if(bytes.length>10485760)throw new Error('Report exceeds 10 MB');
    const preview=await call('verify',bytes,report.receivedAt);reports.push({...report,reportDate:preview.reportDate,outcome:preview.outcome});
  }
  reports.sort((a,b)=>a.reportDate.localeCompare(b.reportDate)||a.receivedAt.localeCompare(b.receivedAt));
  const results=[];
  for(const report of reports){const result=verifyOnly?report:await call('report',await readFile(resolve(directory,report.file)),report.receivedAt);results.push({reportDate:result.reportDate,outcome:result.outcome});}
  if(!verifyOnly)await call(reports.length?'heartbeat':'missing');
  const status={ok:reports.length>0,at:new Date().toISOString(),verifyOnly,matchedMessages:reports.length,reports:results,...(!reports.length?{message:'No matching report received within the last 30 minutes; older mail was not used.'}:{})};
  await writeFile(resolve(root,'last-run.json'),JSON.stringify(status,null,2));console.log(JSON.stringify(status));
}catch(error){
  if(!verifyOnly)try{await call('error');}catch{}
  await writeFile(resolve(root,'last-run.json'),JSON.stringify({ok:false,at:new Date().toISOString(),verifyOnly,error:String(error.message).slice(0,3000)},null,2));
  console.error('Planning sync failed; see last-run.json');process.exitCode=1;
}finally{
  // Only this execution's freshly created folder may be removed.
  if(dirname(directory)!==runRoot||!directory.startsWith(runRoot+sep))throw new Error('Cleanup path rejected');
  await rm(directory,{recursive:true,force:true});
}
