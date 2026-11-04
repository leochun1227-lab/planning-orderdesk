// Integration test: a built production server talks ONLY to an isolated in-memory Firebase fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { seal, unseal } from '../lib/crypto-store.mjs';
import { dayInSydney } from '../lib/order-engine.mjs';

const key = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const agentToken = randomBytes(32).toString('hex');
const today = dayInSydney();
let state = { orders: { SRC001: { id: 'SRC001', chassis: 'SRC-001', dealer: 'Test Dealer', customer: 'Stock',
  modelYear: '2026', model: 'SRH16', status: 'active', specAt: null, signedAt: null, purchaseAt: null, requestDate: '2027-01-01' } },
  events: {}, imports: {}, refs: { dealers: { '100': 'Test Dealer' }, dealerNames: ['test dealer'], excluded: [] }, meta: { lastReportDate: today } };
let encrypted = await seal(state, key), version = 1, reads = 0, writes = 0;
const database = createServer(async (req, res) => {
  if (req.url !== '/state.json') { res.writeHead(404).end(); return; }
  if (req.method === 'GET') { reads++; res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${version}"` }).end(JSON.stringify(encrypted)); return; }
  if (req.method === 'PUT') {
    if (req.headers['if-match'] !== `"${version}"`) { res.writeHead(412).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    encrypted = JSON.parse(body); state = await unseal(encrypted, key); version++; writes++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(encrypted)); return;
  }
  res.writeHead(405).end();
});
database.listen(0, '127.0.0.1'); await once(database, 'listening');
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
  APP_ORIGIN: origin, RENDER: '', RENDER_EXTERNAL_URL: '', ORDERDESK_KEY: key, ORDERDESK_LOGIN_PASSWORD: password,
  ORDERDESK_SESSION_SECRET: randomBytes(32).toString('hex'), PLANNING_AGENT_TOKEN: agentToken, PLANNING_AGENT_ENABLED: 'true',
  MAIL_SYNC_MODE: 'planning-pc', ORDERDESK_DATABASE_URL: `http://127.0.0.1:${database.address().port}/state.json` };
const child = spawn(process.execPath, ['scripts/start-render.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
  env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...options });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('Production server exited: ' + logs);
    try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Production server should become healthy: ' + logs);
  assert.match(logs, /0\.0\.0\.0/);
  assert.equal((await request('/')).status, 307);
  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200); assert.match(await loginPage.text(), /Team password/);
  assert.equal((await request('/api/orders')).status, 401);
  assert.equal((await request('/api/orders', { headers: { 'oai-authenticated-user-id': 'forged', 'oai-authenticated-user-email': 'forged@example.org' } })).status, 401);
  assert.equal(reads, 0, 'Anonymous requests must not access the database');
  const form = new URLSearchParams({ password, returnTo: '/' });
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: form })).status, 403);
  const loggedIn = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin }, body: form });
  assert.equal(loggedIn.status, 303);
  const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  const dashboard = await request('/', { headers });
  assert.equal(dashboard.status, 200); assert.match(await dashboard.text(), /api\/auth\/logout/);
  const orders = await request('/api/orders', { headers });
  assert.equal(orders.status, 200); assert.equal((await orders.json()).orders[0].chassis, 'SRC-001');
  assert.match(orders.headers.get('cache-control'), /no-store/);
  assert.equal((await request('/api/import', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const report = { records: [{ chassis: 'SRC001', quoteStatus: 'FACTORY DRAWN', description: '2026 SRH16', dealerCode: '100', customer: 'Test Customer', expectedDate: 'ASAP', sourceRow: 14 }], reportDate: today, fileName: 'isolated-test.xlsx' };
  const imported = await request('/api/import', { method: 'POST', headers, body: JSON.stringify(report) });
  assert.equal(imported.status, 200, await imported.text());
  assert.equal(writes, 1); assert.equal(state.orders.SRC001.customer, 'Test Customer');
  assert.equal(state.orders.SRC001.dealer, 'Test Dealer'); assert.equal(state.orders.SRC001.requestDate, '2027-01-01');
  const exported = await request('/api/export', { method: 'POST', headers, body: JSON.stringify({ ids: ['SRC001'] }) });
  assert.equal(exported.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
  assert.equal(workbook.getWorksheet('Orderlist').getCell('G2').value, 'SRC-001');
  assert.equal(workbook.getWorksheet('Orderlist').getCell('J2').value, 'Test Customer');
  const connection = await request('/api/mail-sync', { headers });
  assert.equal((await connection.json()).mode, 'planning-pc');
  assert.equal((await request('/api/planning-agent', { method: 'POST', headers })).status, 401, 'Browser cookie is not an agent credential');
  const agentHeaders = { Authorization: 'Bearer ' + agentToken, 'x-agent-action': 'plan' };
  const plan = await request('/api/planning-agent', { method: 'POST', headers: agentHeaders });
  assert.equal(plan.status, 200); assert.equal((await plan.json()).enabled, true);
  const crm = new ExcelJS.Workbook(), sheet = crm.addWorksheet('Report');
  sheet.getCell('A1').value = today + ' 00:05:00 AUSVIC';
  sheet.getRow(13).values = ['Car Frame Number', 'Quote Status', 'Product Description', 'Quote Dealer Store', 'C Customer', 'Expected Delivery Date', 'Quote Status Change Date'];
  sheet.getRow(14).values = ['SRC-001', 'BUYER ORDERED', '2026 SRH16', '100', 'Agent Test Customer', 'ASAP'];
  const bytes = await crm.xlsx.writeBuffer();
  Object.assign(agentHeaders, { 'x-scan-started-at': new Date().toISOString(), 'x-mail-received-at': new Date(Date.now() - 60000).toISOString(), 'Content-Type': 'application/octet-stream' });
  const verify = await request('/api/planning-agent', { method: 'POST', headers: { ...agentHeaders, 'x-agent-action': 'verify' }, body: bytes });
  assert.equal(verify.status, 200, await verify.text()); assert.equal(writes, 1, 'Verification must not write orders');
  const uploaded = await request('/api/planning-agent', { method: 'POST', headers: { ...agentHeaders, 'x-agent-action': 'report' }, body: bytes });
  assert.equal(uploaded.status, 200, await uploaded.text());
  assert.equal(state.orders.SRC001.customer, 'Agent Test Customer'); assert.equal(state.orders.SRC001.signedAt, today);
  assert.equal(state.orders.SRC001.requestDate, '2027-01-01');
  const duplicate = await request('/api/planning-agent', { method: 'POST', headers: { ...agentHeaders, 'x-agent-action': 'report' }, body: bytes });
  assert.equal((await duplicate.json()).outcome, 'duplicate');
  const signedOut = await request('/api/auth/logout', { method: 'POST', headers });
  assert.equal(signedOut.status, 303); assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/orders')).status, 401);
  console.log('PASS: production binding, health, login, forged headers, CSRF, orders, manual import, XLSX export, Planning-agent verification/upload/deduplication, logout.');
  console.log('All database reads and writes used an isolated local fixture. No production Firebase access.');
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  database.closeAllConnections(); await new Promise(resolve => database.close(resolve));
}
