import {getChatGPTUser} from '@/app/chatgpt-auth';
import {readState} from '@/lib/crypto-store.mjs';
import {mailConfig,mailStatus} from '@/lib/mail-sync.mjs';
import {MailSyncError} from '@/lib/outlook-report.mjs';
import {runConfiguredMailSync} from '@/lib/mail-sync-runtime';
import {runtimeValues,secret} from '@/lib/runtime';
import {planningAgentStatus} from '@/lib/planning-agent.mjs';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(){
  if(!await getChatGPTUser())return json({error:'请先登录'},401);
  try{const {state}=await readState(secret());const env=runtimeValues();return json(env.MAIL_SYNC_MODE==='graph'?mailStatus(mailConfig(env),state||{}):planningAgentStatus(env,state||{}));}
  catch{return json({error:'无法读取邮件同步状态'},503);}
}
export async function POST(request:Request){
  if(!await getChatGPTUser())return json({error:'请先登录'},401);
  if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'请求来源无效'},403);
  if(runtimeValues().MAIL_SYNC_MODE!=='graph')return json({error:'当前由 Planning 电脑读取邮件，请在该电脑运行同步程序'},409);
  try{
    const body=await request.text();if(body.length>1000)return json({error:'请求过大'},413);
    const {action}=JSON.parse(body);if(!['verify','sync'].includes(action))return json({error:'操作无效'},400);
    return json(await runConfiguredMailSync(action==='verify'));
  }catch(e){return json({error:e instanceof MailSyncError?e.message:'邮件同步未完成，请检查服务配置或稍后重试'},400);}
}
