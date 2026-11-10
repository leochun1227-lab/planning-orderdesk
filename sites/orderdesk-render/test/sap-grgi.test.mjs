import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { foldSapUpload, createSapSource, encodeSap, decodeSap } from '../lib/sap-grgi.mjs';

const TOKEN = 'x'.repeat(40);
const upload = { source: 'SAP HANA', gr: [['SRC-264210', '20261020', '4500050872', '20260501'], ['SRC264210', '20261101', '4500050999', '20260601'], ['', '20261101', 'x', ''], ['SRT1', '00000000', '', ''], ['SRT9', '', '4500070001', '20261001']], gi: [['SRC264210', '2026-11-05', '4900012345'], ['SRH2', '20261103', '4900000001']] };

test('fold: chassis normalised, SAP yyyymmdd and ISO dates, latest GR/GI win, empty/zero rows dropped', () => {
  const { rows, gr, gi } = foldSapUpload(upload);
  assert.equal(gr, 2); assert.equal(gi, 2);
  assert.deepEqual(rows.get('SRC264210'), { grAt: '2026-11-01', po: '4500050999', poAt: '2026-06-01', giAt: '2026-11-05', giDoc: '4900012345' });
  assert.deepEqual(rows.get('SRH2'), { grAt: '', po: '', poAt: '', giAt: '2026-11-03', giDoc: '4900000001' });
  assert.deepEqual(rows.get('SRT9'), { grAt: '', po: '4500070001', poAt: '2026-10-01', giAt: '', giDoc: '' });
  assert.equal(rows.has('SRT1'), false);
  assert.deepEqual(decodeSap(encodeSap(rows)), rows);
  assert.throws(() => foldSapUpload({ gr: [] }), /arrays/);
});

test('endpoint: token and enable flag required; upload stored outside the order state and read back', async () => {
  const firebase = createMemoryFirebase();
  const store = createStore(firebase);
  const app = createApp({ store, auth: { enabled: false, middleware: () => async (_c, next) => next() }, env: { PLANNING_AGENT_TOKEN: TOKEN, PLANNING_AGENT_ENABLED: 'true' }, firebase });
  const post = (headers, body = JSON.stringify(upload)) => app.request('/api/sap-grgi', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'Bearer ' + 'y'.repeat(40) })).status, 401);
  const ok = await post({ Authorization: 'Bearer ' + TOKEN });
  assert.equal(ok.status, 200); const body = await ok.json();
  assert.equal(body.chassis, 3);
  const stored = await firebase.get('orderdesk/sap-grgi');
  assert.equal(stored.rows.SRC264210, '2026-11-01|4500050999|2026-06-01|2026-11-05|4900012345');
  assert.equal(await firebase.get('orderdesk/v2/sap-grgi'), null);
  const src = createSapSource(firebase); const cur = await src.current();
  assert.equal(cur.rows.get('SRH2').giAt, '2026-11-03');
  assert.equal((await post({ Authorization: 'Bearer ' + TOKEN }, '{"gr":[],"gi":[]}')).status, 400);
});
