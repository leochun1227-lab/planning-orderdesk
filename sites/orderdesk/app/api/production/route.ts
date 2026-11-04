import {getChatGPTUser} from '@/app/chatgpt-auth';
import {readState,writeState} from '@/lib/crypto-store.mjs';
import {dayInSydney,importProductionSources} from '@/lib/order-engine.mjs';
import {secret} from '@/lib/runtime';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 if(!await getChatGPTUser())return Response.json({error:'请先登录'},{status:401});
 const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 try{
  const text=await request.text();if(text.length>10*1024*1024)throw new Error('文件过大');const input=JSON.parse(text);
  const {state,etag}=await readState(secret());if(!state)throw new Error('请先导入初始订单');
  const result=await importProductionSources(state,input.productionSources,{fileName:String(input.fileName||'Production sources').slice(0,160),reportDate:input.reportDate,businessDate:dayInSydney(),now:new Date().toISOString()});
  if(!result.duplicate)await writeState(result.state,secret(),etag);
  return Response.json({summary:result.summary,duplicate:result.duplicate});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'导入失败'},{status:400});}
}
