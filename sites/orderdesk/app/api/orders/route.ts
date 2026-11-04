import { getUser } from '@/lib/auth';
import { readState } from '@/lib/crypto-store.mjs';
import { secret } from '@/lib/runtime';
export const dynamic='force-dynamic';
export async function GET(){
  if(!await getUser())return Response.json({error:'请先登录'},{status:401});
  try{const {state}=await readState(secret());if(!state)return Response.json({error:'订单数据尚未导入'},{status:503});
    return Response.json({orders:Object.values(state.orders||{}),events:Object.values(state.events||{}),imports:Object.values(state.imports||{}),meta:state.meta},{headers:{'Cache-Control':'private, no-store'}});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'读取失败'},{status:502});}
}
