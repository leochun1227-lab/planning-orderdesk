import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';

const appFor = (revision, user = { name: 'Test' }) => createApp({
  store: { revision, info: () => ({ backend: 'firebase' }) },
  auth: { user: () => user }, env: {},
});

test('Render liveness responds without consulting a stalled or failed database', async () => {
  for (const revision of [() => new Promise(() => {}), () => { throw new Error('offline'); }]) {
    let called = false;
    const app = appFor(() => { called = true; return revision(); }, null);
    const response = await app.request('/api/health');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(called, false);
  }
});

test('authenticated readiness reports database success and failure separately', async () => {
  const ready = await appFor(async () => 42).request('/api/readiness');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).revision, 42);
  const failed = await appFor(async () => { throw new Error('private database details'); }).request('/api/readiness');
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private database details/);
  assert.equal((await appFor(async () => 42, null).request('/api/readiness')).status, 401);
});

test('readiness bounds a stalled database check below the Render health timeout', async () => {
  const start = Date.now();
  const response = await appFor(() => new Promise(() => {})).request('/api/readiness');
  assert.equal(response.status, 503);
  assert.ok(Date.now() - start < 4500);
});
