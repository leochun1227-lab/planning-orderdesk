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
import { createProductionLineSource, buildProductionLine, loadRollingPlan, STAGES, BOARD_GROUPS } from '../lib/production-line.mjs';
import { buildDealerLogistics } from '../lib/dealer-logistics.mjs';
import { buildStockForecast, forecastMultiplier, DISPLAY_MODELS, NOT_ON_YARD, validateStockModelLists } from '../lib/stock-forecast.mjs';
import { stockInputFingerprint, forecastPreviewToken, sourceBlockers, saveStockOpinion, recommendPoolStock, productionLineDisplay, dealerSettingsToken } from '../lib/stock-rolling.mjs';
import { configureDealers, validateDealerSettings } from '../lib/dealership.mjs';
import { stockPlanConfirmation, confirmStockAdjustments } from '../lib/stock-plan-confirmation.mjs';
import { runBalancedRolling } from './balanced-runner.mjs';
import { reviewStockWithAI } from '../lib/stock-rolling-ai.mjs';
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

export function createApp({ store, auth, env = process.env, firebase = null, productionSource = null }) {
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

  // Render's liveness check must not wait for a remote database. Dependency
  // failures are reported separately below, without restarting a healthy Node process.
  app.get('/api/health', () => json({ ok: true, service: 'regent-orderdesk' }));

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
  app.get('/login', c => auth.enabled === false ? c.redirect('/') : c.html(loginPage({ returnTo: c.req.query('return_to') || '/' })));
  app.post('/login', async c => {
    const form = await c.req.parseBody();
    const returnTo = String(form.return_to || '/');
    const target = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    if (!auth.checkPassword(form.password)) { await new Promise(r => setTimeout(r, 600)); return c.html(loginPage({ error: '密码不正确 / Incorrect password', returnTo: target }), 401); }
    return new Response(null, { status: 303, headers: { Location: target, 'Set-Cookie': auth.sessionCookie(form.name, secureCookie) } });
  });
  app.all('/logout', () => new Response(null, { status: 303, headers: { Location: auth.enabled === false ? '/' : '/login', 'Set-Cookie': auth.clearCookie(secureCookie) } }));

  // ---- everything below requires a session ----
  app.use('/api/*', async (c, next) => {
    if (!auth.user(c.req.raw)) return json({ error: '请先登录' }, 401);
    await next();
  });
  app.use('/api/*', compress());

  app.get('/api/session', c => json({ user: auth.user(c.req.raw), signIn: auth.enabled !== false, store: store.info() }));
  app.get('/api/readiness', async () => {
    let timer;
    try {
      const revision = await Promise.race([
        store.revision(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Database check timed out')), 2000); }),
      ]);
      return json({ ok: true, revision, store: store.info().backend });
    } catch { return json({ ok: false, error: 'Database is temporarily unavailable' }, 503); }
    finally { clearTimeout(timer); }
  });
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
  const productionLine = productionSource || createProductionLineSource(env, { portal, sap });
  const rollingPlan = loadRollingPlan();
  if (env.NODE_ENV === 'production') {
    productionLine.current({ today: dayInSydney(new Date()) }).catch(() => {}); // warm up at start
    // Keep the copies fresh without anyone opening the page or pressing refresh: every source is re-read when its own
    // interval has passed (Portal 2 h, plan 5 min, Longtree 30 min, production 15 min).
    setInterval(() => { productionLine.current({ today: dayInSydney(new Date()) }).catch(() => {}); }, 10 * 60 * 1000).unref?.();
  }
  async function currentLine(force = false) {
    const today = dayInSydney(new Date());
    const [rawSources, { state, etag }] = await Promise.all([productionLine.current({ force, today }), store.readState()]);
    const sources = { ...rawSources, dealers: configureDealers(rawSources.dealers, state?.stockDealerSettings, today), forecastDealers: configureDealers(rawSources.forecastDealers, state?.stockDealerSettings, today) };
    const args = { orders: state?.orders || {}, ...sources, today, plan: rollingPlan };
    args.displayModels = state?.stockDisplayModels ?? DISPLAY_MODELS;
    args.notOnYardModels = state?.stockNotOnYardModels ?? NOT_ON_YARD;
    const baseLine = buildProductionLine(args);
    const fingerprint = stockInputFingerprint({ line: baseLine, dealers: sources.forecastDealers, capacity: sources.auCapacity, settings: { ...sources.settings, displayModels: args.displayModels, notOnYardModels: args.notOnYardModels }, orders: args.orders });
    let rolling = recommendPoolStock({ plan: state?.stockForecastPlan, fingerprint, line: baseLine, dealers: sources.forecastDealers,
      capacity: sources.auCapacity, settings: sources.settings, orders: args.orders, blockers: sourceBlockers(sources) });
    const confirmation = stockPlanConfirmation(state?.stockForecastPlan, fingerprint);
    const saved = state?.rollingPlan, active = saved && saved.algorithmVersion === 5 && saved.fingerprint === fingerprint && saved.opinionId === state?.stockForecastPlan?.id && confirmation.status === 'confirmed' && saved.confirmationId === confirmation.id && !sourceBlockers(sources).length;
    if (active) rolling = { ...saved.stockResult, ai: state.stockForecastPlan.ai || null };
    rolling.confirmation = confirmation;
    rolling.balanced = Boolean(saved);
    rolling.balancedActive = Boolean(active);
    const balanced = { staleReason: saved && !active ? saved.algorithmVersion !== 5 ? 'algorithm' : 'inputs' : null, maxStockMonths: saved?.maxStockMonths ?? 3, confirmation, customerPercent: saved?.customerPercent ?? 35, status: !saved ? 'empty' : active ? 'ready' : 'stale', quantity: saved?.quantity || 180, inputToken: fingerprint, expectedId: saved?.id || null, opinionId: state?.stockForecastPlan?.id || null,
      canGenerate: Boolean(confirmation.status === 'confirmed' && !sourceBlockers(sources).length && sources.auCapacity?.size),
      proposal: saved ? { ...saved, stockResult: undefined } : null };
    const line = active ? buildProductionLine({ ...args, rollingSchedule: saved.schedule, rollingSize: saved.quantity, inventoryBasis: state.stockForecastPlan.confirmation.report })
      : !saved && rolling.admitted.length ? buildProductionLine({ ...args, rollingAdmissions: rolling.items.filter(a => a.admitted) }) : baseLine;
    const recommendations = new Map(rolling.items.map(a => [a.chassis, a]));
    for (const row of line.rows) { const a = recommendations.get(String(row.chassis).replace(/[-\s]/g, '').toUpperCase()); if (a) row.stockRecommendation = a; }
    return { sources, line, baseLine, state, etag, fingerprint, rolling, balanced };
  }
  app.get('/api/production-line', async c => {
    try {
      const { sources, line, rolling, balanced } = await currentLine(c.req.query('refresh') === '1');
      return json({ ...productionLineDisplay(line), balanced, stockRolling: { ...rolling, items: undefined, monthly: undefined }, groups: BOARD_GROUPS, stages: STAGES, sources: sources.status, refreshing: sources.refreshing });
    } catch (e) { return json({ error: message(e, '产线数据暂时读取不到') }, 502); }
  });
  // Dealer analysis (our five dealerships): the same computation, only the dealership part.
  app.get('/api/dealer-analysis', async c => {
    try {
      const { sources, line } = await currentLine(c.req.query('refresh') === '1');
      return json({ today: line.today, dealership: line.dealership, logistics: line.dealership ? buildDealerLogistics(line.rows, { dealers: sources.dealers, today: line.today }) : null, counts: line.counts, sources: { portal: sources.status.portal, dealers: sources.status.dealers, plan: sources.status.plan, longtree: sources.status.longtree, prod: sources.status.prod }, refreshing: sources.refreshing });
    } catch (e) { return json({ error: message(e, 'Dealer 分析暂时读取不到') }, 502); }
  });

  app.get('/api/stock-forecast', async c => {
    let multiplier, months;
    try {
      multiplier = forecastMultiplier(c.req.query('multiplier') ?? 1.3);
      months = Number(c.req.query('months') ?? 8);
      if (![8, 14].includes(months)) throw new Error('预测月份须为8或14 / Forecast months must be 8 or 14');
    } catch (e) { return json({ error: message(e, 'Invalid forecast settings') }, 400); }
    try {
      const { sources, baseLine, fingerprint, rolling, state, balanced } = await currentLine(c.req.query('refresh') === '1');
      if (!sources.forecastDealers) return json({ error: 'Dealer Portal 库存数据尚未读取，不能生成调整建议 / Dealer stock data is not available' }, 503);
      return json({ ...buildStockForecast({ dealers: sources.forecastDealers, rows: baseLine.rows, today: baseLine.today, multiplier, months, displayModels: state?.stockDisplayModels ?? DISPLAY_MODELS, notOnYardModels: state?.stockNotOnYardModels ?? NOT_ON_YARD }),
        dealerSettingsToken: dealerSettingsToken(sources.forecastDealers),
        lockedLast: baseLine.dealership?.lockedLast || '', adjustedLockedLast: balanced.status === 'ready' ? balanced.proposal?.basisReplay?.rollingBoundary || '' : '',
        balanced,
        previewToken: forecastPreviewToken(fingerprint, multiplier, months), expectedPlanId: state?.stockForecastPlan?.id || null,
        canSave: !sourceBlockers(sources).length && Boolean(sources.auCapacity?.size), rolling: { ...rolling, aiConfigured: Boolean(env.OPENAI_API?.trim()) },
        sources: sources.status, refreshing: sources.refreshing });
    } catch (e) { return json({ error: message(e, '库存预测暂时无法计算 / Stock forecast is unavailable') }, 502); }
  });

  let rollingBusy = false;
  let rollingJob = null;
  const generateRolling = async (c, suppliedBody) => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    if (rollingBusy) return json({ error: '正在生成排产，请稍后刷新查看。' }, 409);
    rollingBusy = true;
    try {
      const body = suppliedBody || await planningBody(c), ctx = await currentLine();
      if (!ctx.state || body.inputToken !== ctx.fingerprint || body.opinionId !== ctx.state.stockForecastPlan?.id || body.expectedId !== (ctx.state.rollingPlan?.id || null)) throw conflict('来源或排产意见已变化，请刷新后重试。');
      if (ctx.balanced.confirmation.status !== 'confirmed' || body.confirmationId !== ctx.balanced.confirmation.id) throw conflict('请先确认已保存的库存调整计划作为排产前提，再重新生成。');
      const proposal = await runBalancedRolling({ plan: ctx.state.stockForecastPlan, fingerprint: ctx.fingerprint, line: ctx.baseLine, dealers: ctx.sources.forecastDealers, capacity: ctx.sources.auCapacity,
        settings: ctx.sources.settings, orders: ctx.state.orders, quantity: body.quantity, customerPercent: body.customerPercent, maxStockMonths: body.maxStockMonths, blockers: sourceBlockers(ctx.sources), actor: auth.user(c.req.raw)?.name });
      const latest = await currentLine();
      if (latest.fingerprint !== ctx.fingerprint || latest.state?.stockForecastPlan?.id !== ctx.state.stockForecastPlan.id || latest.balanced.confirmation.status !== 'confirmed' || latest.balanced.confirmation.id !== proposal.confirmationId || sourceBlockers(latest.sources).length) throw conflict('计算期间来源或意见已变化，请刷新后重新生成。');
      ctx.state.rollingPlanHistory = [...(ctx.state.rollingPlanHistory || []), ...(ctx.state.rollingPlan ? [ctx.state.rollingPlan] : [])].slice(-5);
      ctx.state.rollingPlan = proposal;
      ctx.state.stockForecastPlan.admitted = [];
      await store.writeState(ctx.state, ctx.etag);
      return json({ ok: true, scheduled: proposal.scheduled, newOrders: proposal.newOrders, blocked: proposal.inventoryBlocked, capacityGap: proposal.capacityGap });
    } catch (e) { return json({ error: message(e, '平衡排产失败') }, e.status || 400); }
    finally { rollingBusy = false; }
  };
  app.post('/api/rolling-plan', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    let body; try { body = await planningBody(c); } catch { return json({ error: '请求无效' }, 400); }
    if (!body.background) return generateRolling(c, body);
    if (rollingBusy) return json({ error: '正在生成排产，请稍后刷新查看。' }, 409);
    const job = { id: crypto.randomUUID(), status: 'running', error: '' }; rollingJob = job;
    void generateRolling(c, body).then(async response => {
      const result = await response.json(); job.status = response.ok ? 'done' : 'failed'; job.error = result.error || '';
    }).catch(error => { job.status = 'failed'; job.error = error.message || '排产失败'; });
    return json({ jobId: job.id }, 202);
  });
  app.get('/api/rolling-plan/job', c => {
    if (!rollingJob || rollingJob.id !== c.req.query('id')) return json({ error: '任务已结束或服务已重启，请刷新查看排产结果。' }, 404);
    return json(rollingJob);
  });
  app.get('/api/rolling-plan/report.pdf', async c => {
    try {
      const { state } = await store.readState(), proposal = state?.rollingPlan;
      if (!proposal?.report) return json({ error: '请先生成新版排产报告 / Generate a new rolling report first' }, 409);
      if (c.req.query('id') !== proposal.id) return json({ error: '排产方案已变化，请刷新后下载 / Proposal changed; refresh before downloading' }, 409);
      const { buildRollingPdf } = await import('./rolling-pdf.mjs');
      const bytes = await buildRollingPdf(proposal);
      return new Response(bytes, { headers: { ...noStore, 'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Rolling_Production_Report_${proposal.createdAt.slice(0, 10)}.pdf"` } });
    } catch (e) { return json({ error: message(e, '排产报告导出失败 / Report export failed') }, 500); }
  });
  app.post('/api/rolling-plan/clear', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c), { state, etag } = await store.readState();
      if (!state?.rollingPlan || body.expectedId !== state.rollingPlan.id) throw conflict('排产已变化，请刷新');
      state.rollingPlanHistory = [...(state.rollingPlanHistory || []), state.rollingPlan].slice(-5); delete state.rollingPlan;
      await store.writeState(state, etag); return json({ ok: true });
    } catch (e) { return json({ error: message(e, '撤回失败') }, e.status || 400); }
  });
  app.post('/api/stock-forecast/dealers', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c), ctx = await currentLine();
      if (!ctx.state || body.previous !== dealerSettingsToken(ctx.sources.forecastDealers)) throw conflict('Dealer设置已变化，请刷新');
      const values = validateDealerSettings(body.dealers, ctx.sources.forecastDealers || []);
      ctx.state.stockDealerSettings = { ...ctx.state.stockDealerSettings, ...values };
      await store.writeState(ctx.state, ctx.etag); return json({ ok: true });
    } catch (e) { return json({ error: message(e, 'Dealer设置保存失败') }, e.status || 400); }
  });

  app.post('/api/stock-forecast/models', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const text = await c.req.text(); if (text.length > 40000) throw new Error('清单过大');
      const body = JSON.parse(text);
      const { state, etag } = await store.readState(); if (!state) throw new Error('订单尚未准备');
      if (JSON.stringify(body.previous) !== JSON.stringify(state.stockDisplayModels ?? DISPLAY_MODELS)) return json({ error: '清单已变化，请刷新后重试' }, 409);
      const editsNotOnYard = Object.hasOwn(body, 'notOnYardModels');
      if (editsNotOnYard && JSON.stringify(body.previousNotOnYardModels) !== JSON.stringify(state.stockNotOnYardModels ?? NOT_ON_YARD)) return json({ error: '不推荐清单已变化，请刷新后重试' }, 409);
      const lists = validateStockModelLists(body.models, editsNotOnYard ? body.notOnYardModels : state.stockNotOnYardModels ?? NOT_ON_YARD);
      state.stockDisplayModels = lists.displayModels;
      state.stockNotOnYardModels = lists.notOnYardModels;
      await store.writeState(state, etag);
      return json({ ok: true });
    } catch (e) { return json({ error: message(e, '保存失败') }, 400); }
  });

  async function planningBody(c) {
    const text = await c.req.text(); if (text.length > 20000) throw new Error('请求过大 / Request too large');
    return JSON.parse(text);
  }
  const conflict = text => Object.assign(new Error(text), { status: 409 });
  app.post('/api/stock-forecast/save', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c), multiplier = forecastMultiplier(body.multiplier), months = Number(body.months);
      if (![8, 14].includes(months)) throw new Error('预测月份须为8或14');
      const ctx = await currentLine();
      if (!ctx.state || !ctx.sources.forecastDealers || !ctx.sources.auCapacity?.size || sourceBlockers(ctx.sources).length) throw new Error('请等待库存、产线和产能数据更新成功后再保存意见。');
      const previous = ctx.state.stockForecastPlan;
      if (body.expectedPlanId !== (previous?.id || null) || body.previewToken !== forecastPreviewToken(ctx.fingerprint, multiplier, months)) throw conflict('数据或保存意见已变化，请重新计算后保存。');
      const report = buildStockForecast({ dealers: ctx.sources.forecastDealers, rows: ctx.baseLine.rows, today: ctx.baseLine.today, multiplier, months, displayModels: ctx.state.stockDisplayModels ?? DISPLAY_MODELS, notOnYardModels: ctx.state.stockNotOnYardModels ?? NOT_ON_YARD });
      const next = saveStockOpinion({ previous, report, fingerprint: ctx.fingerprint, actor: auth.user(c.req.raw)?.name });
      // Previously admitted vehicles are explicitly rechecked when saving a new opinion.
      next.admitted = previous?.admitted || [];
      const checked = recommendPoolStock({ plan: next, fingerprint: ctx.fingerprint, line: ctx.baseLine, dealers: ctx.sources.forecastDealers,
        capacity: ctx.sources.auCapacity, settings: ctx.sources.settings, orders: ctx.state.orders });
      next.admitted = checked.admitted;
      ctx.state.stockForecastHistory = [...(ctx.state.stockForecastHistory || []), ...(previous ? [previous] : [])].slice(-5);
      ctx.state.stockForecastPlan = next;
      await store.writeState(ctx.state, ctx.etag);
      return json({ ok: true, planId: next.id, retained: next.admitted.length, released: (previous?.admitted?.length || 0) - next.admitted.length });
    } catch (e) { return json({ error: message(e, '保存意见失败') }, e.status || 400); }
  });

  app.post('/api/stock-forecast/confirm', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c), ctx = await currentLine(), plan = ctx.state?.stockForecastPlan;
      if (!plan || plan.id !== body.planId || ctx.fingerprint !== body.inputToken || plan.fingerprint !== ctx.fingerprint
        || (body.multiplier !== undefined && Number(body.multiplier) !== plan.multiplier) || (body.months !== undefined && Number(body.months) !== plan.months)
        || body.reportToken !== ctx.balanced.confirmation.reportToken || (body.expectedConfirmationId ?? null) !== (plan.confirmation?.id || null))
        throw conflict('库存调整计划或来源已变化，请刷新、重新保存后确认。');
      if (sourceBlockers(ctx.sources).length || !ctx.sources.auCapacity?.size) throw conflict('请等待库存、产线和产能数据更新成功后再确认。');
      if (ctx.balanced.confirmation.status === 'confirmed') return json({ ok: true, confirmationId: plan.confirmation.id });
      plan.confirmation = confirmStockAdjustments({ plan, fingerprint: ctx.fingerprint, actor: auth.user(c.req.raw)?.name });
      plan.events = [...(plan.events || []), { type: 'confirm-adjustments', at: plan.confirmation.confirmedAt, by: plan.confirmation.confirmedBy,
        confirmationId: plan.confirmation.id, summary: plan.confirmation.summary }].slice(-1000);
      await store.writeState(ctx.state, ctx.etag);
      return json({ ok: true, confirmationId: plan.confirmation.id, summary: plan.confirmation.summary });
    } catch (e) { return json({ error: message(e, '库存调整确认失败') }, e.status || 400); }
  });

  app.post('/api/stock-forecast/admissions', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c);
      if (!['add', 'remove'].includes(body.mode) || !Array.isArray(body.chassis) || !body.chassis.length || body.chassis.length > 500 || body.chassis.some(id => typeof id !== 'string') || new Set(body.chassis).size !== body.chassis.length) throw new Error('请选择有效且不重复的车架号。');
      const ctx = await currentLine(), plan = ctx.state?.stockForecastPlan;
      if (ctx.state?.rollingPlan) throw conflict('已启用按数量平衡排产，请在滚动排产线重新生成或撤回安排。');
      if (!plan || body.planId !== plan.id) throw conflict('保存意见已变化，请刷新。');
      const eligible = new Set(ctx.rolling.items.filter(a => !a.admitted).map(a => a.chassis));
      if (body.mode === 'add' && (ctx.rolling.status !== 'ready' || body.token !== ctx.rolling.token || body.chassis.some(id => !eligible.has(id)))) throw conflict('推荐已过期或车辆已不满足入线条件，请重新保存意见并核对。');
      if (body.mode === 'remove' && body.chassis.some(id => !plan.admitted.includes(id))) throw conflict('入线列表已变化，请刷新。');
      plan.admitted = body.mode === 'add' ? [...new Set([...plan.admitted, ...body.chassis])] : plan.admitted.filter(id => !body.chassis.includes(id));
      plan.events = [...plan.events, { type: body.mode, chassis: body.chassis, at: new Date().toISOString(), by: auth.user(c.req.raw)?.name || 'Planning' }].slice(-1000);
      await store.writeState(ctx.state, ctx.etag);
      return json({ ok: true, changed: body.chassis.length });
    } catch (e) { return json({ error: message(e, '滚动排产线更新失败') }, e.status || 400); }
  });

  app.post('/api/stock-forecast/ai-review', async c => {
    if (!originOk(c)) return json({ error: '请求来源无效' }, 403);
    try {
      const body = await planningBody(c), ctx = await currentLine(), plan = ctx.state?.stockForecastPlan;
      if (!plan || body.planId !== plan.id || ctx.rolling.status !== 'ready' || body.token !== ctx.rolling.token) throw conflict('请先保存当前意见，再进行AI分析。');
      plan.ai = { ...(await reviewStockWithAI({ env, rolling: ctx.rolling, report: plan.report })), token: ctx.rolling.token, at: new Date().toISOString() };
      await store.writeState(ctx.state, ctx.etag);
      return json({ ok: true });
    } catch (e) { return json({ error: message(e, 'AI分析未完成') }, e.status || 400); }
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
