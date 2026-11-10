import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFirebase } from '../server/firebase.mjs';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { foldSapUpload, createSapSource, encodeSap, decodeSap } from '../lib/sap-grgi.mjs';

const TOKEN = 'x'.repeat(40);
const upload = { source: 'SAP HANA', gr: [['SRC-264210', '20260901', '4500050872', '5000000001'], ['SRC264210', '20260915', '4500059973', '5000182179'], ['', '20261101', 'x', ''], ['SRT1', '00000000', '', ''], ['SRT9', '', '4500070001', '']], fg: [['SRC264210', '20261028', '5000189552']], gi: [['SRC264210', '2026-11-05', '4900012345'], ['SRH2', '20261103', '4900000001']] };

test('fold: chassis normalised, SAP yyyymmdd and ISO dates, latest GR/GI win, empty/zero rows dropped', () => {
  const { rows, gr, gi } = foldSapUpload(upload);
  assert.equal(gr, 2); assert.equal(gi, 2);
  assert.deepEqual(rows.get('SRC264210'), { grAt: '2026-09-15', po: '4500059973', grDoc: '5000182179', fgAt: '2026-10-28', fgDoc: '5000189552', giAt: '2026-11-05', giDoc: '4900012345' });
  assert.deepEqual(rows.get('SRH2'), { grAt: '', po: '', grDoc: '', fgAt: '', fgDoc: '', giAt: '2026-11-03', giDoc: '4900000001' });
  assert.equal(rows.has('SRT9'), false); assert.equal(rows.has('SRT1'), false);
  assert.deepEqual(decodeSap(encodeSap(rows)), rows);
  assert.deepEqual(decodeSap({ A1234: '2026-01-02|45|2025-12-01|2026-03-04|49' }).get('A1234'), { grAt: '2026-01-02', po: '45', grDoc: '', fgAt: '', fgDoc: '', giAt: '2026-03-04', giDoc: '49' });
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
  assert.equal(body.chassis, 2);
  const stored = await firebase.get('orderdesk/sap-grgi');
  assert.equal(stored.rows.SRC264210, '2026-09-15|4500059973|5000182179|2026-10-28|5000189552|2026-11-05|4900012345');
  assert.equal(await firebase.get('orderdesk/v2/sap-grgi'), null);
  const src = createSapSource(firebase); const cur = await src.current();
  assert.equal(cur.rows.get('SRH2').giAt, '2026-11-03');
  assert.equal((await post({ Authorization: 'Bearer ' + TOKEN }, '{"gr":[],"gi":[]}')).status, 400);
});
