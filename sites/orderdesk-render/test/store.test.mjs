import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { createStore, encode, decode, STALE_MESSAGE } from '../server/store.mjs';

const sample = () => ({
  orders: { SRC001: { id: 'SRC001', chassis: 'SRC-001', specAt: null, signedAt: '2026-11-01', productionStatus: '', customer: '%%weird', tags: [] } },
  events: { 'b_0': { id: 'b_0', orderId: 'SRC001', type: 'new', changes: [], sourceRows: [14, 15], snapshot: { a: null } } },
  imports: { abc: { id: 'abc', rows: 2, newCount: 1 } },
  meta: { lastReportDate: '2026-11-04', planningAgent: { lastError: null }, mailSync: { processed: {} } },
  refs: { dealers: { '100': 'Dealer A', '101': 'Dealer B', '0': 'Zero' }, dealerNames: ['dealer a'], excluded: [] },
  productionSources: { PGI: [['SERNR'], ['SRC001']] },
});

test('codec survives Firebase storage semantics losslessly', async () => {
  const fb = createMemoryFirebase();
  const value = { a: null, b: [], c: {}, d: [1, null, 'x'], '100': 'n', 'x.y': 1, s: '%%null', n: 0, f: false, nested: { '0': 'a', '1': 'b' } };
  await fb.put('t', encode(value));
  assert.deepEqual(decode(await fb.get('t')), value);
});

test('round trip, incremental writes and revision guard', async () => {
  const fb = createMemoryFirebase();
  const store = createStore(fb);
  assert.equal((await store.readState()).state, null);
  const first = await store.writeState(sample(), '0');
  assert.equal(first.revision, 1);
  const fresh = createStore(fb); // a second server process, no cache
  const { state, etag } = await fresh.readState();
  assert.deepEqual(state, sample());
  assert.equal(etag, '1');
  // Change one order: only that order, meta and revision are written.
  let patched;
  const spy = { ...fb, patch: (p, v) => { patched = v; return fb.patch(p, v); } };
  const s2 = createStore(spy);
  const r = await s2.readState();
  r.state.orders.SRC001 = { ...r.state.orders.SRC001, signedAt: '2026-11-05' };
  r.state.meta = { ...r.state.meta, lastReportDate: '2026-11-05' };
  await s2.writeState(r.state, r.etag);
  assert.deepEqual(Object.keys(patched).sort(), ['meta', 'orders/SRC001', 'revision', 'savedAt']);
  // A writer holding the old revision is rejected, just like the old ETag check.
  await assert.rejects(() => fresh.writeState(state, etag), new RegExp(STALE_MESSAGE));
  // Deleting a record removes its node.
  const r3 = await fresh.readState();
  delete r3.state.events.b_0;
  await fresh.writeState(r3.state, r3.etag);
  assert.deepEqual((await createStore(fb).readState()).state.events, {});
});

test('cached payload follows revision', async () => {
  const fb = createMemoryFirebase(); const store = createStore(fb);
  await store.writeState(sample(), '0');
  const p1 = await store.ordersPayload();
  assert.equal(JSON.parse(p1.body).orders.length, 1);
  assert.equal(await store.ordersPayload(), p1);
});
