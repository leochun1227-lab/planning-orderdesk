import {isSameOrigin} from '@/lib/auth-session.mjs';
import { getUser } from '@/lib/auth';
import { readState,writeState } from '@/lib/crypto-store.mjs';
import { applyReport,dayInSydney,reportFingerprint } from '@/lib/order-engine.mjs';
import { secret } from '@/lib/runtime';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  if(!await getUser())return Response.json({error:'请先登录'},{status:401});
  if(!isSameOrigin(request))return Response.json({error:'请求来源无效'},{status:403});
  try{
    const text=await request.text();if(text.length>12_000_000)throw new Error('文件过大');const body=JSON.parse(text);
    if(!Array.isArray(body.records)||body.records.length<1||body.records.length>30000)throw new Error('报告无有效记录');
    if(body.records.some((r:any)=>typeof r.chassis!=='string'||typeof r.quoteStatus!=='string'||r.chassis.length>60||typeof r.description!=='string'||typeof r.customer!=='string'||typeof r.dealerCode!=='string'))throw new Error('报告字段无效');
    const {state,etag}=await readState(secret());if(!state)throw new Error('请先导入初始订单');
    const reportDate=/^\d{4}-\d{2}-\d{2}$/.test(body.reportDate||'')?body.reportDate:dayInSydney();if(state.meta.lastReportDate&&reportDate<state.meta.lastReportDate)throw new Error('报告日期早于已处理报告');
    if(reportDate>dayInSydney())throw new Error('报告日期不能晚于今天');
    const batchId=await reportFingerprint(body.records,reportDate);
    const result=applyReport(state,body.records,{batchId,fileName:String(body.fileName||'CRM Report').slice(0,160),businessDate:dayInSydney(),reportDate,now:new Date().toISOString()});
    if(!result.duplicate){result.state.meta.lastReportDate=reportDate;await writeState(result.state,secret(),etag);}return Response.json({summary:result.summary,duplicate:result.duplicate});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'导入失败'},{status:400});}
}
