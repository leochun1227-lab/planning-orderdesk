import {getChatGPTUser} from '@/app/chatgpt-auth';
import {readState} from '@/lib/crypto-store.mjs';
import {secret} from '@/lib/runtime';
import {buildOrderlist} from '@/lib/orderlist-export.mjs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  if(!await getChatGPTUser())return Response.json({error:'请先登录'},{status:401});
  if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
  try{
    const text=await request.text();if(text.length>1000000)throw new Error('导出请求过大');
    const {ids}=JSON.parse(text);if(!Array.isArray(ids)||ids.length>30000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('导出车辆列表无效');
    const {state}=await readState(secret());if(!state)throw new Error('订单数据尚未准备');
    const orders=ids.map(id=>state.orders[id]);if(orders.some(o=>!o))throw new Error('订单已变化，请刷新后再导出');
    const bytes=await buildOrderlist(orders,state.orderlistExport||{});
    return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="Planning-Orderlist.xlsx"','Cache-Control':'private, no-store'}});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'导出失败'},{status:400});}
}
