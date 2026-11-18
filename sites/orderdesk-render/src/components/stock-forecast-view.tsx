import { readApiResponse } from '../../lib/api-response.mjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, AlertTriangle, RefreshCw, Save, Search, RotateCcw } from 'lucide-react';
import StockModelEditor from './stock-model-editor';
import StockSimulationCard from './stock-simulation-card';
import '../stock-simulation.css';
import type { Simulation, SimulationAssumptions, SimulationDealerInput } from './stock-simulation-types';

const groupLabel = (group: string, zh: boolean) => group === 'own' ? (zh ? '直营' : 'Self-owned') : group === 'jv' ? 'JV' : 'Independent';
const phaseLabel = (group: string, zh: boolean) => ({ au: zh ? '澳洲生产' : 'AU production', sea: zh ? '海运' : 'Shipping', cn: zh ? '国内生产' : 'China production', locked: zh ? '排产锁定线' : 'Locked', rolling: zh ? '滚动排产线' : 'Rolling', pgi: zh ? 'PGI在途' : 'PGI transit', transport: 'Transport', customers: zh ? '库存订单池' : 'Stock pool', processing: zh ? '处理中' : 'Processing', later: zh ? '日期待补' : 'Unscheduled' } as Record<string, string>)[group] || group;
const reasonLabel = (reason: string, zh: boolean) => ({ coverage: zh ? '补齐MY2027型号覆盖' : 'Fill MY2027 model coverage', balance: zh ? '平衡预计月底 Stock / Ideal' : 'Balance projected closing stock / Ideal', ceiling: zh ? '正常车型保留；无合适上限空间' : 'Retained model; no route below ceiling', deleted: zh ? 'MY2027删除车型，锁定线允许取消' : 'Deleted MY2027 model; locked cancellation', notOnYard: zh ? '不推荐展车型号，锁定线允许取消' : 'Not-on-yard model; locked cancellation', fixed: zh ? '现有固定到店计划' : 'Existing fixed arrival', pool: zh ? '未安排生产，保留库存订单池' : 'Unscheduled stock pool', date: zh ? '到店或下线日期待核对' : 'AU finish or arrival date needed', horizon: zh ? '超出36个月模拟范围' : 'Beyond 36-month horizon', settings: zh ? '接收参数或适用型号待核对，保留原供应' : 'Review receiving settings or applicable models; retain supply' } as Record<string, string>)[reason] || reason;
const actionLabel = (action: string, zh: boolean) => ({ keep: zh ? '保留' : 'Keep', cancel: 'Cancellation', reallocate: 'Reallocation', pending: zh ? '待核对' : 'Review', pool: zh ? '库存订单池' : 'Stock pool' } as Record<string, string>)[action] || action;
const signature = (a: SimulationAssumptions | null, months: number) => JSON.stringify([a, months]);
const shiftedDate = (day: string, shift: number) => day ? new Date(Date.parse(`${day}T00:00:00Z`) + shift * 86400000).toISOString().slice(0, 10) : '';
const groups = ['own', 'jv', 'independent'] as const;

export default function StockForecastView({ zh }: { zh: boolean }) {
  const [data, setData] = useState<Simulation | null>(null), [scenario, setScenario] = useState<SimulationAssumptions | null>(null), [months, setMonths] = useState(8);
  const [busy, setBusy] = useState(false), [mutating, setMutating] = useState(false), [saving, setSaving] = useState(false), [exporting, setExporting] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [dealerQuery, setDealerQuery] = useState(''), [scope, setScope] = useState('all'), [finishQuery, setFinishQuery] = useState(''), [finishPage, setFinishPage] = useState(0);
  const [actionQuery, setActionQuery] = useState(''), [actionFilter, setActionFilter] = useState('changes'), [actionPage, setActionPage] = useState(0);
  const sequence = useRef(0), request = useRef<AbortController | null>(null);
  const invalidate = () => { sequence.current++; request.current?.abort(); setBusy(false); setMessage(''); };
  const load = useCallback(async (assumptions: SimulationAssumptions | null, count: number, refresh = false) => {
    const seq = ++sequence.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const response = assumptions === null
        ? await fetch(`/api/stock-forecast?months=${count}${refresh ? '&refresh=1' : ''}`, { cache: 'no-store', signal: controller.signal })
        : await fetch('/api/stock-forecast/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assumptions, months: count, multiplier: 1.3, refresh }), signal: controller.signal });
      const body = await readApiResponse(response);
      if (!response.ok) throw new Error(body.error || 'Could not calculate simulation');
      if (seq !== sequence.current) return;
      setData(body); setScenario(body.assumptions); setActionPage(0);
    } catch (e) { if (!controller.signal.aborted && seq === sequence.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (seq === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => { void load(null, 8); return () => { sequence.current++; request.current?.abort(); }; }, [load]);
  const dirty = Boolean(data && signature(scenario, months) !== signature(data.assumptions, data.months));
  useEffect(() => {
    if (!scenario || !dirty || mutating || saving) return;
    const timer = setTimeout(() => { void load(scenario, months); }, 450);
    return () => clearTimeout(timer);
  }, [scenario, months, dirty, load, mutating, saving]);
  function editDealer(slug: string, field: keyof SimulationDealerInput, value: number | string[] | boolean | null) {
    invalidate(); setScenario(s => s && ({ ...s, dealers: s.dealers.map(d => d.slug === slug ? { ...d, [field]: value } : d) }));
  }
  function editDate(chassis: string, value: string) {
    invalidate(); setScenario(s => { if (!s) return s; const finishDates = { ...s.finishDates }; if (value) finishDates[chassis] = value; else delete finishDates[chassis]; return { ...s, finishDates }; });
  }
  async function reloadModelLists() {
    if (!scenario || !data) return load(null, months);
    const next = structuredClone(scenario);
    for (const d of next.dealers) {
      const previous = data.defaults.find(old => old.slug === d.slug);
      if (JSON.stringify(d.models) === JSON.stringify(previous?.models)) delete (d as Partial<SimulationDealerInput>).models;
    }
    // Omitted model lists follow the newly saved recommendations; bespoke lists and numeric edits remain intact.
    return load(next, months);
  }
  const dealers = data ? groups.flatMap(g => data[g].dealers.map(d => ({ ...d, group: g }))) : [];
  const bySlug = new Map(dealers.map(d => [d.slug, d]));
  const visible = dealers.filter(d => (scope === 'all' || d.group === scope) && `${d.name} ${d.slug}`.toLowerCase().includes(dealerQuery.trim().toLowerCase()));
  const actions = useMemo(() => data ? groups.flatMap(g => data[g].actions).filter(a => (actionFilter === 'all' || actionFilter === 'changes' && ['cancel', 'reallocate', 'pending'].includes(a.action) || a.action === actionFilter)
    && `${a.chassis} ${a.model} ${a.originalDealer} ${a.proposedDealer}`.toLowerCase().includes(actionQuery.trim().toLowerCase())).sort((a, b) => (a.simulatedAu || '9999').localeCompare(b.simulatedAu || '9999') || a.chassis.localeCompare(b.chassis)) : [], [data, actionFilter, actionQuery]);
  const finishRows = data?.finishRows.filter(r => `${r.chassis} ${r.model} ${r.dealer}`.toLowerCase().includes(finishQuery.trim().toLowerCase())) || [];
  const locked = busy || dirty || saving || mutating;
  async function save() {
    if (!data || locked) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/stock-forecast/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ multiplier: data.multiplier, months: data.months, assumptions: data.assumptions, previewToken: data.previewToken, expectedPlanId: data.expectedPlanId }) });
      const body = await readApiResponse(response); if (!response.ok) throw new Error(body.error || 'Could not save simulation');
      await load(data.assumptions, data.months);
      setMessage(zh ? '模拟参数和全部Dealer调整方案已保存。可到产线勾选应用 Cancellation / Reallocation。虚拟库存与交付量仍作为模拟假设。' : 'Simulation assumptions and all dealer adjustments saved. Apply Cancellation / Reallocation on the production-line page. Virtual stock and handovers remain simulation assumptions.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  }
  async function download() {
    if (!data || locked) return;
    setExporting(true);
    try {
      const { buildSimulationWorkbook } = await import('@/lib/stock-simulation-export.mjs'), wb = await buildSimulationWorkbook(data, zh), buffer = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), a = document.createElement('a');
      a.href = url; a.download = `Dealer-Stock-Simulation-${data.today}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setExporting(false); }
  }
  return <section className="table-panel da-panel sf-panel sim-panel" aria-busy={busy}>
    <div className="da-head"><div><h2><Activity size={20} />{zh ? 'Dealer 库存平衡模拟器' : 'Dealer inventory balancing simulator'}</h2><p>{zh ? '修改假设后自动重算 · MY2027型号先覆盖，再平衡月底 Stock / Ideal · Towable Stock' : 'Recalculates as you edit · MY2027 model coverage first, then month-end Stock / Ideal · Towable Stock'}</p></div>
      <button className="icon-button" aria-label={zh ? '刷新来源并保留假设' : 'Refresh sources and retain assumptions'} disabled={saving || mutating} onClick={() => void load(scenario, months, true)}><RefreshCw size={16} /></button></div>
    {error && <p className="message error compact-msg" role="alert"><AlertTriangle size={16} />{error}{data && (zh ? ' · 下方保留上次成功结果' : ' · Last successful results remain below')}</p>}
    {message && <p className="message success compact-msg" role="status">{message}</p>}
    {!data && !error && <div className="pl-loading">{zh ? '正在读取所有Dealer、库存和产线…' : 'Loading all dealers, stock and production…'}</div>}
    {data && scenario && <>
      <div className="sim-toolbar"><label>{zh ? '图表月份' : 'Chart months'}<select value={months} onChange={e => { invalidate(); setMonths(Number(e.target.value)); }}><option value={8}>8 {zh ? '个月' : 'months'}</option><option value={14}>14 {zh ? '个月' : 'months'}</option></select></label>
        <span role="status" className={busy || dirty ? 'sim-status pending' : 'sim-status'}>{error && dirty && !busy ? (zh ? '参数待修正' : 'Check assumptions') : busy || dirty ? (zh ? '正在自动平衡…' : 'Balancing…') : (zh ? `已计算 · ${data.today}` : `Calculated · ${data.today}`)}</span>
        <button className="pl-export" disabled={saving || mutating} onClick={() => { invalidate(); setScenario({ dealers: data.defaults, shiftDays: 0, finishDates: {} }); }}><RotateCcw size={14} />{zh ? '恢复现有数据' : 'Reset to source data'}</button>
        <button className="pl-export" disabled={locked || exporting} onClick={() => void download()}><ArrowDownToLine size={14} />{zh ? '下载模拟明细' : 'Download simulation'}</button>
        <button className="sf-calculate" disabled={locked || !data.canSave} onClick={() => void save()}><Save size={14} />{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存模拟与调整方案' : 'Save simulation and adjustments')}</button>
      </div>
      <div className="sim-assumptions"><h3>{zh ? '所有 Dealer · 虚拟参数' : 'All dealers · editable assumptions'}</h3>
        <p className="da-note">{zh ? '默认使用现有数据。每周交付 = 近三个完整月 Stock 交付总数 ÷ 该期间天数 × 7；+ N 天包含出车与运输。适用型号默认常态Towable清单，可逐店勾选。' : 'Defaults use source data. Weekly handovers = total Stock handovers in the last three full months ÷ days in that period × 7. Days to dealer include dispatch and transit. Edit applicable routine Towable models per dealer.'}</p>
        <div className="da-table sim-input-table"><table><thead><tr><th>Dealer</th><th>{zh ? '当前 Stock' : 'Current Stock'}</th><th>{zh ? '每周 Stock 交付' : 'Stock handovers / week'}</th><th>Ideal</th><th>{zh ? '库存上限' : 'Stock ceiling'}</th><th>{zh ? 'AU下线 + N 天到店' : 'AU finish + N days'}</th><th>{zh ? '接收新分配' : 'Receive allocations'}</th><th>{zh ? 'MY2027适用型号' : 'Applicable MY2027 models'}</th></tr></thead><tbody>
          {scenario.dealers.map(s => { const d = bySlug.get(s.slug); if (!d) return null; const original = data.defaults.find(x => x.slug === s.slug); return <tr key={s.slug}><td><b>{d.name}</b><small>{groupLabel(d.group, zh)}</small></td>
            {(['currentStock', 'weeklyStock', 'ideal', 'cap', 'leadDays'] as const).map(field => <td key={field}><input type="number" aria-label={`${d.name} ${field}`} min={field === 'ideal' ? 1 : 0} max={field === 'leadDays' ? 365 : 100000} step={field === 'weeklyStock' ? '0.01' : 1} value={s[field] ?? ''} placeholder={zh ? '待补' : 'Needed'} disabled={saving || mutating} onChange={e => editDealer(s.slug, field, e.target.value === '' && ['ideal', 'cap', 'leadDays'].includes(field) ? null : Number(e.target.value))} /><small>{zh ? '现有' : 'Source'} {original?.[field] ?? '—'}</small></td>)}
            <td><input type="checkbox" aria-label={`${d.name} ${zh ? '接收新分配' : 'Receive allocations'}`} checked={s.receiving} disabled={saving || mutating} onChange={e => editDealer(s.slug, 'receiving', e.target.checked)} /></td>
            <td><details className="sim-model-select"><summary>{s.models.length} {zh ? '款 · 修改' : 'models · edit'}</summary><div><button type="button" disabled={saving || mutating} onClick={() => editDealer(s.slug, 'models', data.displayModels.filter(m => !['SRT18', 'SRP18F 2 BUNKS'].includes(m.toUpperCase())))}>{zh ? '全选' : 'All'}</button><button type="button" disabled={saving || mutating} onClick={() => editDealer(s.slug, 'models', [])}>{zh ? '清空' : 'Clear'}</button>{data.displayModels.filter(m => !['SRT18', 'SRP18F 2 BUNKS'].includes(m.toUpperCase())).map(model => <label key={model}><input type="checkbox" checked={s.models.includes(model.toUpperCase())} disabled={saving || mutating} onChange={e => editDealer(s.slug, 'models', e.target.checked ? [...s.models, model.toUpperCase()] : s.models.filter(m => m !== model.toUpperCase()))} />{model}</label>)}</div></details></td>
          </tr>; })}
        </tbody></table></div>
      </div>
      <details className="sim-finish-editor"><summary>{zh ? `澳洲下线日期 · ${data.finishRows.length} 台 Stock 可设置虚拟日期` : `AU finish dates · ${data.finishRows.length} Stock vehicles with editable dates`}</summary>
        <div className="sim-toolbar"><label>{zh ? '整体下线日期偏移（天）' : 'Shift all AU finish dates (days)'}<input type="number" min={-365} max={365} step={1} value={scenario.shiftDays} disabled={saving || mutating} onChange={e => { invalidate(); setScenario(s => s && ({ ...s, shiftDays: Number(e.target.value) })); }} /></label><span className="da-note">{zh ? '单车日期优先于整体偏移；清空单车日期恢复默认。' : 'A vehicle override takes precedence over the overall shift. Clear it to restore the default.'}</span><label className="sf-search"><Search size={14} /><input aria-label={zh ? '搜索下线日期' : 'Search AU finish dates'} value={finishQuery} onChange={e => { setFinishQuery(e.target.value); setFinishPage(0); }} placeholder="Chassis / Model / Dealer" /></label></div>
        <div className="da-table"><table><thead><tr><th>Chassis</th><th>Model / MY</th><th>Dealer</th><th>{zh ? '阶段' : 'Stage'}</th><th>{zh ? '现有AU下线' : 'Source AU finish'}</th><th>{zh ? '虚拟AU下线' : 'Virtual AU finish'}</th></tr></thead><tbody>{finishRows.slice(finishPage * 50, finishPage * 50 + 50).map(r => <tr key={r.chassis}><td><b>{r.chassis}</b></td><td>{r.model} · {r.modelYear}</td><td>{r.dealer}</td><td>{phaseLabel(r.group, zh)}</td><td>{r.originalAu || '—'}</td><td><input type="date" aria-label={`${r.chassis} ${zh ? '虚拟AU下线' : 'Virtual AU finish'}`} value={scenario.finishDates[r.chassis] || shiftedDate(r.originalAu, scenario.shiftDays)} disabled={saving || mutating} onChange={e => editDate(r.chassis, e.target.value)} />{scenario.finishDates[r.chassis] && <button className="sim-text-button" disabled={saving || mutating} onClick={() => editDate(r.chassis, '')}>{zh ? '恢复' : 'Reset'}</button>}</td></tr>)}</tbody></table></div>
        <div className="sf-pager"><span>{finishRows.length} {zh ? '台' : 'vehicles'}</span><button disabled={!finishPage} onClick={() => setFinishPage(n => n - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{finishPage + 1} / {Math.max(1, Math.ceil(finishRows.length / 50))}</span><button disabled={(finishPage + 1) * 50 >= finishRows.length} onClick={() => setFinishPage(n => n + 1)}>{zh ? '下一页' : 'Next'}</button></div>
      </details>
      <StockModelEditor zh={zh} displayModels={data.displayModels} notOnYardModels={data.notOnYardModels} disabled={locked} reload={reloadModelLists} onBusy={setMutating} />
      <div className="da-kpis sim-kpis"><div><span>{zh ? '全部 Dealer' : 'All dealers'}</span><strong>{dealers.length}</strong><small>{zh ? '直营 / JV / Independent' : 'Self-owned / JV / Independent'}</small></div><div><span>{zh ? 'MY2027型号覆盖' : 'MY2027 model coverage'}</span><strong>{data.coverage.covered} <small>/ {data.coverage.target}</small></strong><small>{zh ? `还缺 ${data.coverage.missing} 个店 / 型号组合` : `${data.coverage.missing} dealer / model gaps`}</small></div><div><span>Reallocation</span><strong>{data.totals.reallocated}</strong><small>{zh ? '所有Dealer之间分配' : 'Allocations across all dealers'}</small></div><div><span>Cancellation</span><strong>{data.totals.canceled}</strong><small>{zh ? '仅锁定线不推荐 / 删除车型' : 'Locked not-on-yard / deleted models only'}</small></div><div><span>{zh ? '超上限 / 待核对车辆' : 'Ceiling conflicts / review'}</span><strong>{data.totals.limitConflicts} / {data.totals.pending}</strong><small>{zh ? '正常车型保留并显示冲突' : 'Retained models remain in the simulation'}</small></div></div>
      <p className="da-note sim-explanation">{zh ? `首辆锁定线 Stock 下线：${data.startLocked || '待补'}。已有库存、固定在途先预留；澳洲 / 海运 / 国内 / 锁定线按虚拟下线日期逐辆分配。上限有空间时先补缺少的MY2027适用型号，再比较到店月份月底 Stock / Ideal；同款覆盖累计一次，后续按消耗补货。` : `First locked Stock finish: ${data.startLocked || 'pending'}. Reserve yard stock and fixed inbound first, then allocate AU / sea / China / locked Stock in virtual finish-date order. Within available ceilings, fill missing applicable MY2027 models first, then balance Stock / Ideal at the receiving month end. Coverage is cumulative; subsequent supply replaces consumption.`}</p>
      <p className="da-note">{zh ? '调整前和调整后使用同一组虚拟假设，分别表示原Dealer分配与自动平衡后的结果。销量按每天每周交付量 / 7消耗，不足时缺货单列。虚拟新增库存不虚构型号或年款；未标年款库存不计MY2027覆盖。' : 'Before and after use the same assumptions and compare original dealer assignments with automatic balancing. Stock is consumed daily at weekly handovers / 7; unmet demand is separate. Added virtual yard stock has no invented model or model year. Unknown years do not satisfy MY2027 coverage.'}</p>
      {Object.entries(data.sources || {}).some(([, s]) => s.error && s.configured !== false) && <p className="sf-warning" role="status">{zh ? '部分来源未更新，当前使用现有副本。' : 'Some sources could not refresh; using available copies.'}</p>}
      {data.warnings.some(w => w.code === 'dealer') && <p className="sf-warning">{zh ? '部分车架号未匹配Dealer，请核对：' : 'Unmatched dealer assignments: '}{data.warnings.filter(w => w.code === 'dealer').map(w => `${w.chassis} (${w.dealer})`).join(' · ')}</p>}
      <div className="sim-toolbar sim-results-toolbar"><h3>{zh ? 'Dealer 月度库存与型号覆盖' : 'Dealer monthly inventory and model coverage'}</h3><select aria-label={zh ? 'Dealer分组' : 'Dealer group'} value={scope} onChange={e => setScope(e.target.value)}><option value="all">{zh ? '所有Dealer' : 'All dealers'}</option>{groups.map(g => <option key={g} value={g}>{groupLabel(g, zh)}</option>)}</select><label className="sf-search"><Search size={14} /><input aria-label={zh ? '搜索Dealer' : 'Search dealers'} value={dealerQuery} onChange={e => setDealerQuery(e.target.value)} placeholder="Dealer" /></label></div>
      <div className={`sim-cards ${dirty || busy ? 'sim-calculating' : ''}`}>{visible.map(d => <StockSimulationCard key={d.slug} d={d} zh={zh} />)}</div>
      {!visible.length && <p className="sf-empty">{zh ? '没有符合条件的Dealer' : 'No matching dealers'}</p>}
      <section className="sim-actions"><h3>{zh ? '逐车分配和调整明细' : 'Vehicle allocations and adjustments'}</h3><div className="sim-toolbar"><select aria-label={zh ? '调整类型' : 'Adjustment type'} value={actionFilter} onChange={e => { setActionFilter(e.target.value); setActionPage(0); }}>{[['changes', zh ? '全部变动 / 待核对' : 'Changes / review'], ['all', zh ? '全部车辆' : 'All vehicles'], ['reallocate', 'Reallocation'], ['cancel', 'Cancellation'], ['pending', zh ? '待核对' : 'Review'], ['pool', zh ? '库存订单池' : 'Stock pool']].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select><label className="sf-search"><Search size={14} /><input aria-label={zh ? '搜索分配明细' : 'Search allocations'} value={actionQuery} onChange={e => { setActionQuery(e.target.value); setActionPage(0); }} placeholder="Chassis / Model / Dealer" /></label></div>
        <div className="da-table sim-action-table"><table><thead><tr>{['Chassis', 'Model / MY', zh ? '阶段' : 'Stage', zh ? '处理' : 'Action', zh ? '原Dealer' : 'Original dealer', zh ? '接收Dealer' : 'Receiving dealer', zh ? '现有AU下线' : 'Source AU finish', zh ? '虚拟AU下线' : 'Virtual AU finish', zh ? '原到店' : 'Original arrival', zh ? '预测到店' : 'Simulated arrival', zh ? '依据' : 'Reason'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{actions.slice(actionPage * 50, actionPage * 50 + 50).map(a => <tr key={a.chassis}><td><b>{a.chassis}</b></td><td>{a.model} · {a.modelYear || '—'}</td><td>{phaseLabel(a.group, zh)}</td><td><span className={`sf-act ${a.action}`}>{actionLabel(a.action, zh)}</span></td><td>{a.originalDealer}</td><td>{a.proposedDealer || '—'}</td><td>{a.originalAu || '—'}</td><td>{a.simulatedAu || '—'}</td><td>{a.originalArrival || '—'}</td><td>{a.plannedArrival || '—'}</td><td>{reasonLabel(a.reason, zh)}</td></tr>)}{!actions.length && <tr><td colSpan={11} className="sf-empty">{zh ? '没有符合条件的车辆' : 'No matching vehicles'}</td></tr>}</tbody></table></div>
        <div className="sf-pager"><span>{actions.length} {zh ? '台' : 'vehicles'}</span><button disabled={!actionPage} onClick={() => setActionPage(n => n - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{actionPage + 1} / {Math.max(1, Math.ceil(actions.length / 50))}</span><button disabled={(actionPage + 1) * 50 >= actions.length} onClick={() => setActionPage(n => n + 1)}>{zh ? '下一页' : 'Next'}</button></div>
      </section>
      <p className="da-note">{data.savedAt ? `${zh ? '上次保存' : 'Last saved'} ${new Date(data.savedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} · ${data.savedCurrent && !dirty ? (zh ? '当前假设已保存' : 'Current assumptions saved') : (zh ? '当前结果需重新保存' : 'Save the current results')}` : (zh ? '当前模拟尚未保存' : 'Simulation not yet saved')}{!data.canSave && (zh ? ' · 来源和产能更新成功后可保存调整方案。' : ' · Saving adjustments requires current sources and AU capacity.')}</p>
    </>}
  </section>;
}
