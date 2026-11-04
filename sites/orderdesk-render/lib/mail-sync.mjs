import {applyReport,dayInSydney,reportFingerprint} from './order-engine.mjs';
import {connectOutlook,mailConfig,mailStatus,MailSyncError} from './outlook-report.mjs';
import {parseCrmWorkbook} from './crm-workbook.mjs';
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export async function syncMail({config,read,write,connect=connectOutlook,parse=parseCrmWorkbook,now=new Date(),dryRun=false,trigger='manual'}){
  const {state,etag}=await read();if(!state)throw new MailSyncError('state','请先导入初始订单');
  const started=now.toISOString(),today=dayInSydney(now);
  // Re-read a rolling overlap to pick up delayed/moved messages, deduplicate by content.
  // A long outage starts at the last successfully imported report; never silently skip days.
  const baseline=state.meta?.lastReportDate||today;
  const since=new Date(Date.parse(baseline+'T00:00:00Z')-2*86400000).toISOString();
  try {
    const mailbox=await connect(config);const messages=await mailbox.messages(since);
    if(messages.length>100)throw new MailSyncError('limit','待处理报告超过 100 封，请分批补录后重试');
    const known={...state.meta?.mailSync?.processed};const reports=[];
    for(const message of messages){
      const id=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(message.id)));
      if(known[id])continue;
      const file=await mailbox.reportAttachment(message);const report=await parse(file.bytes);
      if(report.reportDate>today)throw new MailSyncError('date','邮件中的报告日期晚于今天，已停止自动导入');
      reports.push({...report,id,fileName:file.name,receivedAt:message.receivedDateTime,batchId:await reportFingerprint(report.records,report.reportDate)});
    }
    reports.sort((a,b)=>a.reportDate.localeCompare(b.reportDate)||a.receivedAt.localeCompare(b.receivedAt));
    let next=state;const results=[];
    for(const report of reports){
      const old=report.reportDate<(next.meta?.lastReportDate||'');
      if(old){results.push({reportDate:report.reportDate,fileName:report.fileName,outcome:'older_report_skipped'});}
      else {
        const result=applyReport(next,report.records,{batchId:report.batchId,fileName:report.fileName,businessDate:today,reportDate:report.reportDate,now:started});
        next=result.state;
        if(!result.duplicate){next={...next,imports:{...next.imports,[report.batchId]:{...result.summary,source:'outlook',receivedAt:report.receivedAt}},meta:{...next.meta,lastReportDate:report.reportDate}};}
        results.push({reportDate:report.reportDate,fileName:report.fileName,outcome:result.duplicate?'duplicate':'imported',summary:result.summary});
      }
      known[report.id]=report.receivedAt;
    }
    const run={checkedAt:started,matchedMessages:messages.length,reports:results,imported:results.filter(x=>x.outcome==='imported').length,duplicates:results.filter(x=>x.outcome==='duplicate').length,dryRun,trigger};
    if(!dryRun){
      const processed=Object.fromEntries(Object.entries(known).sort((a,b)=>String(b[1]).localeCompare(String(a[1]))).slice(0,500));
      next={...next,meta:{...next.meta,mailbox:'planning@regentrv.com.au',mailSync:{...next.meta?.mailSync,lastCheckedAt:started,lastSuccessAt:started,...(trigger==='scheduled'?{lastScheduledSuccessAt:started}:{}),lastError:null,lastRun:run,processed}}};
      // A single compare-and-swap saves order changes and checkpoint together.
      // A manual import/concurrent poll winning the ETag leaves this entire run uncommitted.
      await write(next,etag);
    }
    return {run,status:mailStatus(config,next)};
  }catch(error){
    if(!dryRun){
      // Do not save partially applied reports or clobber concurrent writes with an error marker.
      try{await write({...state,meta:{...state.meta,mailSync:{...state.meta?.mailSync,lastCheckedAt:started,lastError:error instanceof MailSyncError?error.message:'同步未完成，请重试；原订单数据保留'}}},etag);}catch{}
    }
    throw error;
  }
}
export {mailConfig,mailStatus};
