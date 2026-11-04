// Server-owned target. Microsoft Graph is used only with GET requests.
export const MAIL_TARGET = Object.freeze({mailbox:'planning@regentrv.com.au',folder:'CRM Report',subject:'Sales Order Report (Customer)',sender:'donotreply@my300375.mail.c4c.saphybriscloud.cn'});
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const enc = encodeURIComponent;
export class MailSyncError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function mailConfig(env={}) {
  return {tenant:env.MS_GRAPH_TENANT_ID,clientId:env.MS_GRAPH_CLIENT_ID,clientSecret:env.MS_GRAPH_CLIENT_SECRET,enabled:env.MAIL_SYNC_ENABLED==='true',folderId:env.MS_GRAPH_CRM_FOLDER_ID||''};
}
export function hasMailCredentials(config){return !!(config.tenant&&config.clientId&&config.clientSecret);}
export function mailStatus(config,state={}) {
  const saved=state.meta?.mailSync||{};
  return {target:MAIL_TARGET,configured:hasMailCredentials(config),enabled:config.enabled,lastCheckedAt:saved.lastCheckedAt||null,lastSuccessAt:saved.lastSuccessAt||null,lastScheduledSuccessAt:saved.lastScheduledSuccessAt||null,lastError:saved.lastError||null,lastRun:saved.lastRun||null};
}
async function boundedBody(response,limit){
  if(Number(response.headers.get('content-length'))>limit)throw new MailSyncError('size','邮件附件超过大小限制');
  const reader=response.body?.getReader();if(!reader)throw new MailSyncError('empty','邮件附件为空');
  const chunks=[];let length=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new MailSyncError('size','邮件附件超过大小限制');chunks.push(value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function connectOutlook(config,fetcher=fetch){
  if(!hasMailCredentials(config))throw new MailSyncError('configuration','等待 Microsoft 365 应用只读授权配置');
  if(!/^[a-zA-Z0-9.-]+$/.test(config.tenant))throw new MailSyncError('configuration','Microsoft 租户配置无效');
  const response=await fetcher(`https://login.microsoftonline.com/${enc(config.tenant)}/oauth2/v2.0/token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:config.clientId,client_secret:config.clientSecret,scope:'https://graph.microsoft.com/.default'})});
  if(!response.ok)throw new MailSyncError('authorization','Microsoft 应用授权失败，请检查租户、应用及密钥');
  const token=(await response.json()).access_token;
  if(typeof token!=='string'||!token)throw new MailSyncError('authorization','Microsoft 未返回访问令牌');
  const root=`${GRAPH}/users/${enc(MAIL_TARGET.mailbox)}/`;
  async function get(url,raw=false){
    // Validate pagination URLs as well; never forward a bearer token to another host/mailbox.
    if(!url.startsWith(root)||new URL(url).origin!=='https://graph.microsoft.com')throw new MailSyncError('pagination','邮件分页地址无效');
    const r=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,Prefer:'IdType="ImmutableId"'}});
    if(!r.ok)throw new MailSyncError(r.status===429?'throttled':'graph',r.status===403?'此应用没有 Planning 邮箱的只读权限':r.status===429?'Microsoft 暂时限流，下次检查时重试':`Microsoft 邮件读取失败 (${r.status})`);
    return raw?boundedBody(r,MAX_ATTACHMENT_BYTES):r.json();
  }
  async function list(url,maxPages=20){
    const values=[];for(let page=0;url&&page<maxPages;page++){const result=await get(url);if(!Array.isArray(result.value))throw new MailSyncError('format','邮件列表格式无效');values.push(...result.value);url=result['@odata.nextLink'];}
    if(url)throw new MailSyncError('limit','邮件数量超过单次检查上限，请缩小处理范围后重试');return values;
  }
  async function folder(){
    if(config.folderId){const f=await get(root+`mailFolders/${enc(config.folderId)}?$select=id,displayName`);if(f.displayName?.toLowerCase()!==MAIL_TARGET.folder.toLowerCase())throw new MailSyncError('folder','配置的文件夹不是 CRM Report');return f.id;}
    const queue=[root+'mailFolders?$select=id,displayName,childFolderCount&$top=100'];const found=[];let visited=0;
    while(queue.length){if(++visited>100)throw new MailSyncError('folder','文件夹过多，请配置 CRM Report 文件夹 ID');for(const f of await list(queue.shift())){if(f.displayName?.toLowerCase()===MAIL_TARGET.folder.toLowerCase())found.push(f.id);if(f.childFolderCount>0)queue.push(root+`mailFolders/${enc(f.id)}/childFolders?$select=id,displayName,childFolderCount&$top=100`);}}
    if(found.length!==1)throw new MailSyncError('folder',found.length?'找到多个 CRM Report 文件夹，请配置准确的文件夹 ID':'未找到 CRM Report 文件夹');return found[0];
  }
  return {
    async messages(since){
      const id=await folder();const q=new URLSearchParams({'$filter':`receivedDateTime ge ${since}`,'$orderby':'receivedDateTime asc','$select':'id,subject,from,receivedDateTime,hasAttachments','$top':'100'});
      const messages=await list(root+`mailFolders/${enc(id)}/messages?${q}`);
      return messages.filter(m=>m.subject?.trim()===MAIL_TARGET.subject&&m.from?.emailAddress?.address?.toLowerCase()===MAIL_TARGET.sender&&m.hasAttachments).sort((a,b)=>a.receivedDateTime.localeCompare(b.receivedDateTime)||a.id.localeCompare(b.id));
    },
    async reportAttachment(message){
      const path=root+`messages/${enc(message.id)}/attachments`;
      const files=(await list(path+'?$select=id,name,size,isInline,contentType')).filter(a=>!a.isInline&&/\.xlsx$/i.test(a.name||'')&&a['@odata.type']==='#microsoft.graph.fileAttachment');
      if(files.length!==1)throw new MailSyncError('attachment','报告邮件必须包含一个明确的 .xlsx 附件');
      const file=files[0];if(file.size>MAX_ATTACHMENT_BYTES)throw new MailSyncError('size','邮件附件超过 10 MB');
      return {name:file.name,bytes:await get(path+`/${enc(file.id)}/$value`,true)};
    },
  };
}
