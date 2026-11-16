import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalSource, PORTAL_PLAN_SOURCES } from '../lib/portal-source.mjs';

test('the small Production & dispatch plan refreshes on its own short interval', async () => {
  const calls = [];
  let total = 324;
  const fetcher = async url => { calls.push(url); return { ok: true, json: async () => (url.includes('productionDispatchPlanning') ? { 2026: { totalProduction: [total] } } : {}) }; };
  const src = createPortalSource({ url: 'https://x', ttlMs: 60 * 60 * 1000, planTtlMs: -1, fetcher });
  const a = await src.current();
  assert.equal(a.plan.raw.dispatchPlan[2026].totalProduction[0], 324);
  const big = calls.length - PORTAL_PLAN_SOURCES.length;
  total = 288; calls.length = 0;
  await src.current(); await new Promise(r => setTimeout(r, 5));
  const b = await src.current();
  assert.equal(calls.filter(u => !PORTAL_PLAN_SOURCES.some(([, p]) => u.includes(p.split('/')[0]))).length, 0, 'the big board copy is not re-read');
  assert.equal(b.plan.raw.dispatchPlan[2026].totalProduction[0], 288);
  assert.ok(big > 0);
});
