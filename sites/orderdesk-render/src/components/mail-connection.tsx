import {useCallback,useEffect,useState} from 'react';
import {Mail,RefreshCw,Upload} from 'lucide-react';
import {Button} from '@/components/ui/button';
export type MailStatus={mode?:string;stale?:boolean;target?:{mailbox:string;folder:string};configured:boolean;enabled:boolean;localPreview?:boolean;lastSuccessAt?:string;lastScheduledSuccessAt?:string;lastCheckedAt?:string;lastError?:string;lastRun?:{imported:number;duplicates:number;matchedMessages:number}};
export function mailLabel(status:MailStatus|null,zh:boolean){
  if(!status)return zh?'邮件状态待读取':'Email status unavailable';
  if(status.mode==='planning-pc'){
    if(!status.configured)return zh?'等待连接 Planning 电脑':'Awaiting Planning computer setup';
    if(!status.enabled)return zh?'电脑同步待启用':'Computer sync disabled';
    if(status.lastError)return zh?'Planning 电脑同步失败':'Planning computer sync failed';
    if(!status.lastSuccessAt)return zh?'等待电脑首次同步':'Awaiting first computer sync';
    if(status.stale)return zh?'Planning 电脑未按时同步':'Planning computer sync overdue';
    return zh?'Planning 电脑同步正常':'Planning computer sync healthy';
  }
  if(!status.configured)return zh?'等待邮箱授权配置':'Awaiting mailbox configuration';
  if(status.lastError)return zh?'邮件同步需检查':'Email sync needs attention';
  if(!status.lastSuccessAt)return zh?'等待云端验证':'Awaiting cloud verification';
  if(status.enabled&&!status.lastScheduledSuccessAt)return zh?'等待首次定时运行':'Awaiting first scheduled run';
  return status.enabled?(zh?'自动同步已启用':'Automatic sync enabled'):(zh?'自动同步未启用':'Automatic sync disabled');
}
export default function MailConnection({zh,status,onStatus,onImported,onUpload}:{zh:boolean;status:MailStatus|null;onStatus:(s:MailStatus)=>void;onImported:()=>Promise<void>;onUpload:()=>void}){
  const pc=status?.mode==='planning-pc';
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const refresh=useCallback(async()=>{try{const r=await fetch('/api/mail-sync',{cache:'no-store'});const data=await r.json() as MailStatus & {error?:string};if(!r.ok)throw new Error(data.error);onStatus(data);}catch(e){setError(e instanceof Error?e.message:'Unable to read sync status');}},[onStatus]);
  useEffect(()=>{void refresh();},[refresh]);
  const time=(value?:string)=>value?new Intl.DateTimeFormat(zh?'zh-CN':'en-AU',{timeZone:'Australia/Sydney',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
  async function run(action:'verify'|'sync'){
    setBusy(true);setError('');setMessage('');
    try{const response=await fetch('/api/mail-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});const result=await response.json() as {error?:string;run:{matchedMessages:number;imported:number;duplicates:number}};if(!response.ok)throw new Error(result.error);
      const r=result.run;
      setMessage(action==='verify'?(zh?`试读成功：匹配 ${r.matchedMessages} 封报告，预计导入 ${r.imported} 份，重复 ${r.duplicates} 份。订单未更改。`:`Read test passed: ${r.matchedMessages} matching messages, ${r.imported} reports to import, ${r.duplicates} duplicates. Orders unchanged.`):(zh?`本次导入 ${r.imported} 份，跳过重复报告 ${r.duplicates} 份。`:`Imported ${r.imported} reports; skipped ${r.duplicates} duplicates.`));
      if(action==='sync')await onImported();await refresh();
    }catch(e){setError(e instanceof Error?e.message:'Sync failed');await refresh();}finally{setBusy(false);}
  }
  return <section className="connection-card"><div className="connection-icon amber"><Mail size={26}/></div><h2>{pc?(zh?'Planning 电脑同步':'Planning computer sync'):(zh?'Outlook 报告':'Outlook reports')}</h2><span className={`pill ${status?.enabled&&status?.lastSuccessAt&&!status?.lastError&&!status?.stale?'success':'warning'}`}>{mailLabel(status,zh)}</span>
    <dl><div><dt>{zh?'邮箱':'Mailbox'}</dt><dd>{status?.target?.mailbox||'planning@regentrv.com.au'}</dd></div><div><dt>{zh?'文件夹':'Folder'}</dt><dd>{status?.target?.folder||'CRM Report'}</dd></div><div><dt>{zh?'读取方式':'Access'}</dt><dd>{pc?(zh?'Planning 电脑 · 经典版 Outlook':'Planning computer · Classic Outlook'):(zh?'云端只读 · 无需电脑开机':'Cloud read-only · works while PC is off')}</dd></div><div><dt>{zh?'最近检查':'Last checked'}</dt><dd>{time(status?.lastCheckedAt)}</dd></div><div><dt>{zh?'最近成功':'Last successful check'}</dt><dd>{time(status?.lastSuccessAt)}</dd></div></dl>
    {pc&&<p>{zh?'每天悉尼时间 00:20 检查一次，在收件箱和 CRM Report 文件夹里找当天 00:00 之后收到的报告（同一封只算一次）。未收到则提示，不读取旧邮件；错过时间不补抓。Planning 电脑需保持开机、联网和 Windows 用户登录。':'Checks once daily at 00:20 Sydney time, looking in the Inbox and the CRM Report folder for the report received since 00:00 (each email counted once). Missing reports are flagged; older mail and missed-run catch-ups are excluded. Keep the Planning computer online and signed in.'}</p>}
    {!status?.configured&&<p>{pc?(zh?'等待在 Planning 电脑安装同步程序并连接此网页。':'Awaiting installation and connection of the Planning computer.'):(zh?'后台读取功能已准备，等待 Microsoft 365 应用授权及服务器密钥配置。':'Backend reader is ready. Microsoft 365 app authorization and server credentials are required.')}</p>}
    {status?.configured&&!status.enabled&&<p>{pc?(zh?'先在 Planning 电脑完成试读，再启用定时上传。':'Verify report access on the Planning computer before enabling uploads.'):(zh?'请先试读报告，核对后再由管理员启用云端定时任务。':'Test report access first, then have the administrator enable the cloud schedule.')}</p>}
    {(error||status?.lastError)&&<p role="alert" className="text-danger">{error||status?.lastError}</p>}
    {message&&<p role="status">{message}</p>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:16}}>{!pc&&<><Button variant="outline" disabled={busy||!status?.configured} onClick={()=>void run('verify')}><Mail size={16}/>{zh?'试读报告':'Test report access'}</Button><Button variant="outline" disabled={busy||!status?.configured||!status?.enabled} onClick={()=>void run('sync')}><RefreshCw size={16}/>{busy?(zh?'检查中…':'Checking…'):(zh?'立即检查并导入':'Check and import')}</Button></>}<Button variant="outline" disabled={busy} onClick={()=>void refresh()}>{zh?'刷新状态':'Refresh status'}</Button></div>
    <Button className="action primary" onClick={onUpload}><Upload size={17}/>{zh?'手动导入报告':'Import report manually'}</Button>
  </section>;
}
