import { Worker } from 'node:worker_threads';

// Large pool searches must not block Render liveness checks or other page reads.
export function runBalancedRolling(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./balanced-worker.mjs', import.meta.url), { workerData: input });
    let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('排产计算超时，请缩小本期数量后重试。')), 60000);
    worker.once('message', m => finish(m.error ? new Error(m.error) : null, m.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`排产计算未完成（${code}）`)); });
  });
}
