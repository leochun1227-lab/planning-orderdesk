import {readState,writeState} from './crypto-store.mjs';
import {syncMail,mailConfig} from './mail-sync.mjs';
import {runtimeValues,secret} from './runtime';
export async function runConfiguredMailSync(dryRun=false,trigger='manual'){
  if(runtimeValues().MAIL_SYNC_MODE!=='graph')throw new Error('当前使用 Planning 电脑同步');
  const config=mailConfig(runtimeValues());
  if(!dryRun&&!config.enabled)throw new Error('自动导入尚未启用；请先验证邮箱只读访问');
  const key=secret();
  return syncMail({config,dryRun,trigger,read:()=>readState(key),write:(state:unknown,etag:string)=>writeState(state,key,etag)});
}
