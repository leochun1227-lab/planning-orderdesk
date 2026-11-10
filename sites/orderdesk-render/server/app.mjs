// HTTP API. Each route keeps the request validation and business calls of the
// original Next.js routes (sites/orderdesk/app/api/*); only the storage and
// sign-in layers differ.
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReport, dayInSydney, reportFingerprint, importProductionSources } from '../lib/order-engine.mjs';
import { buildOrderlist } from '../lib/orderlist-export.mjs';
import { forecastResolver } from '../lib/schedule.mjs';
import { createCampervanPlanSource } from '../lib/campervan-plan.mjs';
import { createProductionLineSource, buildProductionLine, STAGES, BOARD_GROUPS } from '../lib/production-line.mjs';
import { createPortalSource } from '../lib/portal-source.mjs';
import { createSapSource, SAP_MAX_BYTES } from '../lib/sap-grgi.mjs';
import { agentAuthorized } from '../lib/planning-agent.mjs';
import { handlePlanningAgent, planningAgentStatus } from '../lib/planning-agent.mjs';
import { syncMail, mailConfig, mailStatus } from '../lib/mail-sync.mjs';
import { MailSyncError } from '../lib/outlook-report.mjs';
import { loginPage } from './auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const noStore = { 'Cache-Control': 'private, no-store' };
const json = (body, status = 200, headers = noStore) => Response.json(body, { status, headers });
const message = (e, fallback) => (e instanceof Error ? e.message : fallback);

export function createApp({ store, auth, env = process.env, firebase = null }) {
  const app = new Hono();
  const secureCookie = env.NODE_ENV === 'production';
  const sameOrigin = c => { const origin = c.req.header('origin'); return !!origin && origin === new URL(c.req.url).origin; };
  const forwardedOrigin = c => {
    // Render terminates TLS in front of Node; trust its forwarded proto/host for the origin check.
    const proto = c.req.header('x-forwarded-proto'), host = c.req.header('x-forwarded-host') || c.req.header('host');
    return proto && host ? `${proto.split(',')[0]}://${host}` : new URL(c.req.url).origin;
  };
  const originOk = c => sameOrigin(c) || c.req.header('origin') === forwardedOrigin(c);

  // Mail sync (Microsoft Graph mode) shares the store's read/write contract.
  async function runMailSync(dryRun = false, trigger = 'manual') {
    if (env.MAIL_SYNC_MODE !== 'graph') throw new Error('当前使用 Planning 电脑同步');
    const config = mailConfig(env);
    if (!dryRun && !config.enabled) throw new Error('自动导入尚未启用；请先验证邮箱只读访问');
    return syncMail({ config, dryRun, trigger, read: () => store.readState(), write: (state, etag) => store.writeState(state, etag) });
  }
  app.runMailSync = runMailSync;

  app.get('/api/health', async c => {
    try { return json({ ok: true, revision: await store.revision(), store: store.info().backend }); }
    catch (e) { return json({ ok: false, error: message(e, 'Firebase 不可用') }, 503); }
  });

  // ---- Planning computer endpoint: bearer token, no browser session ----
  app.post('/api/planning-agent', c => handlePlanningAgent(c.req.raw, { env, read: () => store.readState(), write: (state, etag) => store.writeState(state, etag) }));
  const sap = createSapSource(firebase);
  // SAP GR / GI pushed by the in-network computer (same token as the Planning-PC mail import).
  app.post('/api/sap-grgi', async c => {
    if (!await agentAuthorized(c.req.raw, env.PLANNING_AGENT_TOKEN)) return json({ error: 'Agent authorization required' }, 401);
    if (env.PLANNING_AGENT_ENABLED !== 'true') return json({ error: 'Planning computer import is not enabled' }, 409);
    if (Number(c.req.header('content-length')) > SAP_MAX_BYTES) return json({ error: 'Upload too large' }, 413);
    try {
      const text = await c.req.text();
      if (text.length > SAP_MAX_BYTES) return json({ error: 'Upload too large' }, 413);
      return json({ ok: true, ...(await sap.save(JSON.parse(text))) });
    } catch (e) { return json({ error: message(e, 'SAP 数据保存失败') }, 400); }
  });


  // ---- sign in ----
  app.get('/login', c => c.html(loginPage({ returnTo: c.req.query('return_to') || '/' })));
  app.post('/login', async c => {
    const form = await c.req.parseBody();
    const returnTo = String(form.return_to || '/');
    const target = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    if (!auth.checkPassword(form.password)) { await new Promise(r => setTimeout(r, 600)); return c.html(loginPage({ error: '密码不正确 / Incorrect password', returnTo: target }), 401); }
    return new Response(null, { status: 303, headers: { Location: target, 'Set-Cookie': auth.sessionCookie(form.name, secureCookie) } });
  });
  app.all('/logout', () => new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': auth.clearCookie(secureCookie) } }));

  // ---- everything below requires a session ----
  app.use('/api/*', async (c, next) => {
    if (!auth.user(c.req.raw)) return json({ error: '请先登录' }, 401);
    await next();
  });
  app.use('/api/*', compress());

  app.get('/api/session', c => json({ user: auth.user(c.req.raw), store: store.info() }));
  app.get('/api/revision', async c => json({ revision: await store.revision() }));
  // SRV/SRM planned dates, read-only from the Dealer Portal (cached 15 minutes).
  // One shared copy of the Dealer Portal (read every 2 hours at most) for the SRV/SRM plan and 产线.
  const portal = createPortalSource({ url: env.PORTAL_DATABASE_URL || undefined });
  const campervanPlan = createCampervanPlanSource({ url: env.PORTAL_DATABASE_URL || undefined, portal });
  app.get('/api/campervan-plan', async () => {
    try { return json(await campervanPlan.current()); }
    catch (e) { return json({ error: message(e, 'Dealer Portal 排产暂时读取不到'), plan: {} }, 502); }
  });

  // Production line (产线): Longtree + AU production API + Portal GR/GI, read-only, cached 15 minutes.
  const productionLine = createProductionLineSource(env, { portal, sap });
  if (env.NODE_ENV === 'production') productionLine.current({ today: dayInSydney(new Date()) }).catch(() => {}); // warm up at start
  app.get('/api/production-line', async c => {
    try {
      const today = dayInSydney(new Date());
      const sources = await productionLine.current({ force: c.req.query('refresh') === '1', today });
      const { state } = await store.readState();
      const line = buildProductionLine({ orders: state?.orders || {}, ...sources, today });
      return json({ ...line, groups: BOARD_GROUPS, stages: STAGES, sources: sources.status, refreshing: sources.refreshing });
    } catch (e) { return json({ error: message(e, '产线数据暂时读取不到') }, 502); }
  });

  app.get('/api/orders', async c => {
    try {
      const payload = await store.ordersPayload();
      if (!payload) return json({ error: '订单数据尚未导入' }, 503);
      const etag = `W/"r${payload.revision}"`;
      const headers = { 'Cache-Control': 'private, no-cache', ETag: etag, 'Content-Type': 'application/json; charset=utf-8' };
      if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
      return new Response(payload.body, { headers });
    } catch (e) { return json({ error: message(e, '读取失败') }, 502); }
  });

  app.post('/api/import', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const text = await c.req.text(); if (text.length > 12_000_000) throw new Error('文件过大'); const body = JSON.parse(text);
      if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 30000) throw new Error('报告无有效记录');
      if (body.records.some(r => typeof r.chassis !== 'string' || typeof r.quoteStatus !== 'string' || r.chassis.length > 60 || typeof r.description !== 'string' || typeof r.customer !== 'string' || typeof r.dealerCode !== 'string')) throw new Error('报告字段无效');
      const { state, etag } = await store.readState(); if (!state) throw new Error('请先导入初始订单');
      const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(body.reportDate || '') ? body.reportDate : dayInSydney();
      if (state.meta.lastReportDate && reportDate < state.meta.lastReportDate) throw new Error('报告日期早于已处理报告');
      if (reportDate > dayInSydney()) throw new Error('报告日期不能晚于今天');
      const batchId = await reportFingerprint(body.records, reportDate);
      // The business date is the report's own day: a report imported late (missed night) is dated the day it covers,
      // exactly as the 00:20 run would have done; today's report gives today.
      const result = applyReport(state, body.records, { batchId, fileName: String(body.fileName || 'CRM Report').slice(0, 160), businessDate: reportDate, reportDate, now: new Date().toISOString() });
      if (!result.duplicate) { result.state.meta.lastReportDate = reportDate; await store.writeState(result.state, etag); }
      return json({ summary: result.summary, duplicate: result.duplicate });
    } catch (e) { return json({ error: message(e, '导入失败') }, 400); }
  });

  app.post('/api/production', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const text = await c.req.text(); if (text.length > 10 * 1024 * 1024) throw new Error('文件过大'); const input = JSON.parse(text);
      const { state, etag } = await store.readState(); if (!state) throw new Error('请先导入初始订单');
      const result = await importProductionSources(state, input.productionSources, { fileName: String(input.fileName || 'Production sources').slice(0, 160), reportDate: input.reportDate, businessDate: dayInSydney(), now: new Date().toISOString() });
      if (!result.duplicate) await store.writeState(result.state, etag);
      return json({ summary: result.summary, duplicate: result.duplicate });
    } catch (e) { return json({ error: message(e, '导入失败') }, 400); }
  });

  app.post('/api/export', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const text = await c.req.text(); if (text.length > 1000000) throw new Error('导出请求过大');
      const { ids } = JSON.parse(text); if (!Array.isArray(ids) || ids.length > 30000 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('导出车辆列表无效');
      const { state } = await store.readState(); if (!state) throw new Error('订单数据尚未准备');
      // 'slot:<excel row>' exports a reserved empty Orderlist row (dealer + forecast date only).
      const forecast = forecastResolver(state.calendar);
      const orders = ids.map(id => {
        const slot = /^slot:(\d+)$/.exec(id);
        if (slot) { const row = state.schedule?.rows?.[Number(slot[1]) - 2]; return row && !row.chassis ? { slot: true, chassis: '', dealer: row.dealer, forecastDate: forecast(Number(slot[1])) } : null; }
        return state.orders[id];
      });
      if (orders.some(o => !o)) throw new Error('订单已变化，请刷新后再导出');
      const bytes = await buildOrderlist(orders, state.orderlistExport || {});
      return new Response(Uint8Array.from(bytes).buffer, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Planning-Orderlist.xlsx"', ...noStore } });
    } catch (e) { return json({ error: message(e, '导出失败') }, 400); }
  });

  app.get('/api/mail-sync', async () => {
    try { const { state } = await store.readState(); return json(env.MAIL_SYNC_MODE === 'graph' ? mailStatus(mailConfig(env), state || {}) : planningAgentStatus(env, state || {})); }
    catch { return json({ error: '无法读取邮件同步状态' }, 503); }
  });
  app.post('/api/mail-sync', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    if (env.MAIL_SYNC_MODE !== 'graph') return json({ error: '当前由 Planning 电脑读取邮件，请在该电脑运行同步程序' }, 409);
    try {
      const body = await c.req.text(); if (body.length > 1000) return json({ error: '请求过大' }, 413);
      const { action } = JSON.parse(body); if (!['verify', 'sync'].includes(action)) return json({ error: '操作无效' }, 400);
      return json(await runMailSync(action === 'verify'));
    } catch (e) { return json({ error: e instanceof MailSyncError ? e.message : '邮件同步未完成，请检查服务配置或稍后重试' }, 400); }
  });

  app.all('/api/*', () => json({ error: 'Not found' }, 404));

  // ---- the single-page app ----
  const page = async c => {
    if (!auth.user(c.req.raw)) return c.redirect('/login?return_to=' + encodeURIComponent(new URL(c.req.url).pathname));
    if (!existsSync(resolve(dist, 'index.html'))) return c.text('Frontend not built. Run `npm run build`.', 503);
    return c.html(await readFile(resolve(dist, 'index.html'), 'utf8'), 200, noStore);
  };
  app.get('/', page);
  app.get('/assets/*', serveStatic({ root: dist, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.get('/favicon.svg', serveStatic({ path: resolve(dist, 'favicon.svg') }));
  app.get('*', page);
  return app;
}
