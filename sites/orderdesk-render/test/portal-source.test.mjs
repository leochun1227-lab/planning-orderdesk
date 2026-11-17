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

for (const failPlan of [false, true]) {
  test(`forced refresh keeps its plan promise while the larger board is pending (plan ${failPlan ? 'failure' : 'success'})`, async () => {
    let release;
    const boardGate = new Promise(r => { release = r; });
    const fetcher = async url => {
      if (PORTAL_PLAN_SOURCES.some(([, path]) => url.endsWith(`/${path}.json`))) {
        if (failPlan) throw new Error('plan unavailable');
        return { ok: true, json: async () => ({ total: 288 }) };
      }
      await boardGate;
      return { ok: true, json: async () => ({}) };
    };
    const src = createPortalSource({ url: 'https://x', fetcher });
    const pending = src.current({ force: true });
    await new Promise(r => setImmediate(r));
    release();
    const result = await pending;
    assert.ok(result.raw);
    if (failPlan) assert.match(result.planError, /plan unavailable/);
    else assert.equal(result.plan.raw.dispatchPlan.total, 288);
  });
}
