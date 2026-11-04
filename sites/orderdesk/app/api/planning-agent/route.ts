import {handlePlanningAgent} from '@/lib/planning-agent.mjs';
import {readState,writeState} from '@/lib/crypto-store.mjs';
import {runtimeValues,secret} from '@/lib/runtime';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  return handlePlanningAgent(request,{env:runtimeValues(),read:()=>readState(secret()),write:(state:unknown,etag:string)=>writeState(state,secret(),etag)});
}
