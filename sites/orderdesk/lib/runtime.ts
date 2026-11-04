import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage<Record<string,unknown>>();
export const withRuntime=(env:Record<string,unknown>,fn:()=>unknown)=>context.run(env,fn);
export function runtimeValues(){return {...process.env,...context.getStore()};}
export function secret(){const key=context.getStore()?.ORDERDESK_KEY || process.env.ORDERDESK_KEY;if(typeof key!=='string')throw new Error('服务配置未完成');return key;}
