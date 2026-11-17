import { parentPort, workerData } from 'node:worker_threads';
import { buildBalancedRolling } from '../lib/balanced-rolling.mjs';
try { parentPort.postMessage({ result: buildBalancedRolling(workerData) }); }
catch (e) { parentPort.postMessage({ error: e instanceof Error ? e.message : '排产计算失败' }); }
