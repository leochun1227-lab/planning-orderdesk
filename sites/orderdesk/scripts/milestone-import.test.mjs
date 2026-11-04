import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, basename} from 'node:path';
import {localComparison} from './vite/local-comparison-plugin.mjs';
import {dayInSydney} from '../lib/order-engine.mjs';

test('website import API fills milestone dates, persists them, and preserves history on replay', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'orderdesk-milestone-test-'));
  const runtime = resolve(root, '.sites-runtime');
  let server;
  try {
    await mkdir(runtime);
    const today = dayInSydney();
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    const order = (id, dates = {}) => ({id, chassis: id, modelYear: '2026', model: 'SRH16', dealer: 'Dealer A', customer: 'Stock', status: 'active', requestDate: '2026-11-01', receivedAt: '2026-10-26', sentLongtreeAt: '2026-10-26', specAt: null, signedAt: null, purchaseAt: null, ...dates});
    const initial = {orders: {
      SRC001: order('SRC001'),
      SRC002: order('SRC002', {specAt: '2026-10-29'}),
      SRC003: order('SRC003', {specAt: '2026-01-05', signedAt: '2026-01-12', purchaseAt: '2026-02-12'}),
    }, events: {}, imports: {}, refs: {dealers: {'100': 'Dealer A'}, dealerNames: ['dealer a'], excluded: []}, meta: {localTest: true, seedId: 'milestone-test', lastReportDate: '2026-10-26'}};
    await writeFile(resolve(runtime, 'local-test-config.json'), JSON.stringify({enabled: true, historyFile: 'unused.xlsx', historyName: 'unused.xlsx', seedId: 'milestone-test'}));
    await writeFile(resolve(runtime, 'local-test-state.json'), JSON.stringify(initial));
    let middleware;
    await localComparison().configureServer({config: {root}, middlewares: {use(fn) {middleware = fn;}}});
    server = createServer((req, res) => middleware(req, res, () => {res.statusCode = 404; res.end();}));
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${server.address().port}`;
    const record = (chassis, quoteStatus) => ({chassis, quoteStatus, description: '2026 SRH16', dealerCode: '100', customer: 'Dealer A', expectedDate: '2026-12-20', changedAt: '2020-01-01', sourceRow: 14});
    const records = [record('SRC001', 'FACTORY DRAWN'), record('SRC002', 'BUYER ORDERED'), record('SRC003', 'BUYER ORDERED'), record('SRC004', 'FACTORY DRAWN'), record('SRC005', 'BUYER ORDERED'), record('SRC006', 'FACTORY DRAWN'), record('SRC006', 'BUYER ORDERED'), record('SRC007', 'FACTORY TO BE DRAWN')];
    const post = async reportDate => {
      const response = await fetch(url + '/api/import', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: url}, body: JSON.stringify({records, reportDate, fileName: 'milestone-fixture.xlsx'})});
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    const first = await post(yesterday);
    assert.equal(first.summary.businessDate, today);
    assert.equal(first.summary.reportDate, yesterday);
    assert.equal(first.summary.changedCount, 2);
    assert.equal(first.summary.newCount, 4);
    const data = await (await fetch(url + '/api/orders')).json();
    const orders = Object.fromEntries(data.orders.map(o => [o.id, o]));
    const dates = o => [o.specAt, o.signedAt, o.purchaseAt];
    assert.deepEqual(dates(orders.SRC001), [today, null, null]);
    assert.deepEqual(dates(orders.SRC002), ['2026-10-29', today, today]);
    assert.deepEqual(dates(orders.SRC003), ['2026-01-05', '2026-01-12', '2026-02-12']);
    assert.deepEqual(dates(orders.SRC004), [today, null, null]);
    assert.deepEqual(dates(orders.SRC005), [today, today, today]);
    assert.deepEqual(dates(orders.SRC006), [today, today, today]);
    assert.deepEqual(dates(orders.SRC007), [null, null, null]);
    assert.equal(orders.SRC002.receivedAt, '2026-10-26');
    assert.equal(orders.SRC002.sentLongtreeAt, '2026-10-26');
    assert.equal(orders.SRC004.receivedAt, today);
    assert.equal(orders.SRC004.sentLongtreeAt, today);
    const signedEvent = data.events.find(e => e.orderId === 'SRC002');
    assert.equal(signedEvent.date, today);
    assert.deepEqual(signedEvent.changes.map(c => c.field).sort(), ['purchaseAt', 'signedAt']);
    const duplicate = await post(yesterday);
    assert.equal(duplicate.duplicate, true);
    const freshReport = await post(today);
    assert.equal(freshReport.duplicate, false);
    assert.equal(freshReport.summary.changedCount, 0);
    assert.equal(freshReport.summary.newCount, 0);
    const persisted = JSON.parse(await readFile(resolve(runtime, 'local-test-state.json'), 'utf8'));
    assert.deepEqual(persisted.orders, orders);
    assert.equal(Object.keys(persisted.events).length, data.events.length);
  } finally {
    if (server) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('orderdesk-milestone-test-'));
    await rm(root, {recursive: true, force: true});
  }
});
