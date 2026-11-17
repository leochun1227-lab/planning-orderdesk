import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { DealerCard, type DealerCardData } from './dealer-analysis-view';
import { actionLabel, reasonLabel, DISPLAY_MODELS, NOT_ON_YARD } from '@/lib/stock-forecast.mjs';
import StockRollingPanel, { type StockRolling } from './stock-rolling-panel';

type Summary = { cnDelayed: number; cnCompletionDelayed: number; canceled: number; lockedCanceled: number; rollingCanceled: number; delayed: number; poolNotBuilt: number; reallocated: number; pending: number; changes: number };
type Action = { chassis: string; model: string; range: string; phase: string; group: string; from: string; to: string; originalDealer: string; proposedDealer: string; originalAu: string; plannedAu: string; originalArrival: string; plannedArrival: string; depart: string; delayDays: number | null; arrivalDelayDays: number | null; action: string; reason: string; policy: string; delayed: boolean; reallocated: boolean };
type ForecastDealer = DealerCardData & { stats: Summary; cap: number; overCapMonths: number; shortageMonths: number };
type Section = { dealers: ForecastDealer[]; summary: Summary; actions: Action[] };
type Report = { today: string; multiplier: number; months: number; own: Section; jv: Section; totals: Summary; sources: Record<string, { at?: string; error?: string; configured?: boolean }>; warnings: { code: string; chassis: string }[]; refreshing?: boolean;
  previewToken: string; expectedPlanId: string | null; canSave: boolean; rolling: StockRolling };
type Config = { multiplier: number; months: number };
type Filter = 'cancel' | 'delay' | 'pool' | 'reallocate' | 'pending';
const fmt = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—';
const initial = () => { try { const c = JSON.parse(localStorage.getItem('orderdesk-stock-forecast') || '{}'); if (Number(c.multiplier) > 0 && Number(c.multiplier) <= 10 && [8, 14].includes(Number(c.months))) return { multiplier: Number(c.multiplier), months: Number(c.months) }; } catch {} return { multiplier: 1.3, months: 8 }; };
const matches = (a: Action, filter: Filter) => filter === 'delay' ? a.delayed : filter === 'reallocate' ? a.reallocated : filter === 'pending' ? ['pending', 'blocked'].includes(a.action) : a.action === filter;

export default function StockForecastView({ zh }: { zh: boolean }) {
  const config = useRef(initial()), [draft, setDraft] = useState(String(config.current.multiplier)), [months, setMonths] = useState(config.current.months);
  const [data, setData] = useState<Report | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mutating, setMutating] = useState(false), mutation = useRef(false);
  const [chartMode, setChartMode] = useState<'adjustments' | 'confirmed' | 'recommended'>('adjustments');
  const [exporting, setExporting] = useState(''), [scope, setScope] = useState<'own' | 'jv'>('own'), [filter, setFilter] = useState<Filter>('cancel'), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const request = useRef<AbortController | null>(null), sequence = useRef(0);
  const load = useCallback(async (next: Config, refresh = false) => {
    const id = ++sequence.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    config.current = next; setBusy(true); setError('');
    try {
      const q = new URLSearchParams({ multiplier: String(next.multiplier), months: String(next.months), ...(refresh ? { refresh: '1' } : {}) });
      const r = await fetch(`/api/stock-forecast?${q}`, { cache: 'no-store', signal: controller.signal }), body = await r.json();
      if (!r.ok) throw new Error(body.error || '无法读取预测 / Could not load forecast');
      if (id !== sequence.current) return;
      setData(body); setPage(0);
      try { localStorage.setItem('orderdesk-stock-forecast', JSON.stringify(next)); } catch {}
    } catch (e) { if (!controller.signal.aborted && id === sequence.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (id === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => { void load(config.current); const timer = setInterval(() => { if (!document.hidden && !mutation.current) void load(config.current); }, 30 * 60 * 1000); return () => { clearInterval(timer); request.current?.abort(); }; }, [load]);
  function calculate() {
    const multiplier = Number(draft);
    if (!draft.trim() || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10) { setError(zh ? '请输入大于0且不超过10的库存倍数。' : 'Enter a stock multiplier greater than 0 and at most 10.'); return; }
    void load({ multiplier, months });
  }
  async function download(which: 'own' | 'jv' | 'all') {
    if (!data) return;
    setExporting(which);
    try {
      const { buildForecastWorkbook } = await import('@/lib/stock-forecast-export.mjs');
      const wb = await buildForecastWorkbook(data, which, zh), buf = await wb.xlsx.writeBuffer(), url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = `Stock-forecast-${which}-${data.today}-x${data.multiplier}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '下载失败' : 'Download failed')); } finally { setExporting(''); }
  }
  const selected = data?.[scope];
  const listed = useMemo(() => { const query = search.trim().toLowerCase(); return (selected?.actions || []).filter(a => matches(a, filter) && (!query || [a.chassis, a.model, a.originalDealer, a.proposedDealer].some(v => v.toLowerCase().includes(query)))); }, [selected, filter, search]);
  const filters: [Filter, string, string][] = [['cancel', zh ? '取消' : 'Cancel', 'canceled'], ['delay', zh ? '延期' : 'Delay', 'delayed'], ['pool', zh ? '库存池不生产' : 'Pool not built', 'poolNotBuilt'], ...(scope === 'own' ? [['reallocate', 'Reallocation', 'reallocated'] as [Filter, string, string]] : []), ['pending', zh ? '待分流/核对' : 'Review', 'pending']];
  const sourceErrors = Object.entries(data?.sources || {}).filter(([, s]) => s.error && s.configured !== false);
  const dirty = data && (Number(draft) !== data.multiplier || months !== data.months);
  const canCompare = data?.rolling.status === 'ready' && data.multiplier === data.rolling.multiplier && data.months === data.rolling.months;
  const shownMode = canCompare ? chartMode : 'adjustments';
  function chartDealer(d: ForecastDealer): ForecastDealer {
    if (!data || shownMode === 'adjustments') return d;
    const comparison = data.rolling.monthly.find(x => x.slug === d.slug);
    const monthly = d.monthly.map(m => {
      const p = comparison?.months.find(x => x.month === m.month); if (!p) return m;
      return { ...m, baselineEndStock: p.before ?? undefined, endStock: shownMode === 'confirmed' ? p.confirmed : p.after,
        stockIn: (m.stockIn || 0) + (shownMode === 'confirmed' ? p.confirmedIn : p.stockIn), stockOut: shownMode === 'confirmed' ? p.confirmedSold : p.sold, unmet: shownMode === 'confirmed' ? p.confirmedUnmet : p.unmet };
    });
    return { ...d, monthly, need: Math.max(0, Math.ceil(d.target - (monthly.at(-1)?.endStock || 0))), overCapMonths: monthly.filter(m => (m.endStock || 0) > d.cap).length, shortageMonths: monthly.filter(m => (m.unmet || 0) > 0).length };
  }
  return <section className="table-panel da-panel sf-panel" aria-busy={busy}>
    <div className="da-head"><div><h2><Activity size={18} />{zh ? '取消、延期后的库存预测' : 'Stock after cancellations and delays'}</h2><p>{zh ? '只看Towable Stock · 不含SRV/SRM、客户车、二手车 · 预测不改实际订单' : 'Towable stock only · excludes SRV/SRM, customer and used vans · no live order changes'}</p></div>
      <button aria-label={zh ? '刷新预测数据' : 'Refresh forecast data'} className={busy ? 'icon-button spinning' : 'icon-button'} disabled={busy || mutating} onClick={() => void load(config.current, true)}><RefreshCw size={15} /></button></div>
    <form className="sf-controls" onSubmit={e => { e.preventDefault(); calculate(); }}>
      <label>{zh ? 'Ideal库存倍数' : 'Ideal stock multiplier'}<div className="sf-number"><span>×</span><input aria-label={zh ? '理想库存倍数' : 'Ideal stock multiplier'} type="number" step="any" min="0.01" max="10" value={draft} onChange={e => setDraft(e.target.value)} required /></div></label>
      <div className="sf-presets">{[1.3, 1.5].map(n => <button type="button" key={n} className={Number(draft) === n ? 'active' : ''} onClick={() => setDraft(String(n))}>×{n}</button>)}</div>
      <label>{zh ? '图表月份' : 'Chart months'}<select aria-label={zh ? '预测月份' : 'Forecast months'} value={months} onChange={e => setMonths(Number(e.target.value))}><option value={8}>{zh ? '8个月' : '8 months'}</option><option value={14}>{zh ? '14个月' : '14 months'}</option></select></label>
      <button className="sf-calculate" type="submit" disabled={busy || mutating}>{busy ? (zh ? '正在测算…' : 'Calculating…') : (zh ? '重新计算' : 'Recalculate')}</button>
      {data && <span className="sf-applied">{zh ? `当前结果 ×${data.multiplier} · ${data.today}` : `Results ×${data.multiplier} · ${data.today}`}{dirty ? (zh ? ' · 参数已改，待计算' : ' · inputs changed; recalculate') : ''}</span>}
      <button type="button" className="pl-export sf-download" disabled={!data || busy || Boolean(dirty) || Boolean(exporting)} onClick={() => void download('all')}><ArrowDownToLine size={13} />{zh ? '下载全部清单' : 'Download all lists'}</button>
    </form>
    {error && <div role="alert" className="message error compact-msg"><AlertTriangle size={16} />{error}{data && <span>{zh ? '（下方仍是上次成功结果）' : ' (last successful results remain below)'}</span>}</div>}
    {!data && !error && <div className="pl-loading">{zh ? '正在读取库存和产线…首次可能需要30–40秒' : 'Loading stock and production… first load may take 30–40 seconds'}</div>}
    {sourceErrors.length > 0 && <div className="message compact-msg sf-warning"><AlertTriangle size={15} />{zh ? '部分来源暂未更新，按现有副本测算：' : 'Some sources could not refresh; results use the available copy: '}{sourceErrors.map(([k, s]) => `${k}: ${s.error}`).join(' · ')}</div>}
    {data && <>
      <StockRollingPanel zh={zh} report={data} disabled={busy || Boolean(dirty)} reload={() => load(config.current)} onBusy={value => { mutation.current = value; setMutating(value); }} />
      <div className="da-kpis sf-kpis">
        <div><span>{zh ? '国内生产车辆延期' : 'China-stage vehicles delayed'}</span><strong>{data.totals.cnDelayed}</strong><small>{zh ? `其中AU完工后移 ${data.totals.cnCompletionDelayed} 台` : `${data.totals.cnCompletionDelayed} with AU completion postponed`}</small></div>
        <div><span>{zh ? '取消建议（不含库存池）' : 'Cancellations (pool excluded)'}</span><strong>{data.totals.canceled}</strong><small>{zh ? `锁定线 ${data.totals.lockedCanceled} · 滚动线 ${data.totals.rollingCanceled}` : `Locked ${data.totals.lockedCanceled} · rolling ${data.totals.rollingCanceled}`}</small></div>
        <div><span>{zh ? '库存订单池暂不生产' : 'Stock pool not built'}</span><strong>{data.totals.poolNotBuilt}</strong><small>{zh ? '不计到货，不计取消' : 'Excluded from arrivals and cancellations'}</small></div>
        <div><span>{zh ? '直营Reallocation候选' : 'Self-owned reallocation candidates'}</span><strong>{data.own.summary.reallocated}</strong><small>{zh ? 'JV不做Reallocation' : 'No JV reallocation'}</small></div>
        <div><span>{zh ? '待分流 / 日期用途待核对' : 'Receiving demand / dates unresolved'}</span><strong>{data.totals.pending}</strong><small>{zh ? '已开工车辆不直接取消' : 'Started vehicles are not cancelled automatically'}</small></div>
      </div>
      <p className="da-note">{zh ? '上限 = floor(Ideal × 倍数)。国内/锁定/滚动车辆最多延期1个自然月，同时检查AU完工和到店日期；原已在途及下游车辆可能仍导致超限。调整台数按原Dealer统计，到货图按接收Dealer。库存不足时按可用库存交付，缺货量单列。' : 'Ceiling = floor(Ideal × multiplier). Delay ≤ one calendar month for both AU completion and delivery. Existing downstream supply may still exceed the ceiling. Adjustment counts use the original dealer; arrival charts use the receiving dealer. Handovers are capped to available stock; unmet sales are shown separately.'}</p>
      {canCompare && <div className="sf-rolling-toolbar"><b>{zh ? '到货与库存图：' : 'Arrivals and inventory:'}</b>{(['adjustments', 'confirmed', 'recommended'] as const).map(mode => <button className={`pl-export ${shownMode === mode ? 'active' : ''}`} aria-pressed={shownMode === mode} key={mode} onClick={() => setChartMode(mode)}>{mode === 'adjustments' ? (zh ? '取消延期后' : 'After adjustments') : mode === 'confirmed' ? (zh ? '加已确认补货' : 'With confirmed stock') : (zh ? '加全部推荐补货' : 'With all recommended stock')}</button>)}<span>{zh ? '补货图以取消、延期和调拨意见已落实为前提；灰线为补货前库存。' : 'Replenishment assumes saved adjustments are implemented; grey shows stock before replenishment.'}</span></div>}
      {(['own', 'jv'] as const).map(which => { const group = data[which]; return <section key={which} aria-label={which === 'own' ? 'Self-owned forecast' : 'JV forecast'}>
        <div className="da-subhead"><h3 className="da-sub">{which === 'own' ? (zh ? '五家直营店 · 调整后预测' : 'Five self-owned dealers · after changes') : (zh ? 'JV Dealers · 不做Reallocation' : 'JV Dealers · no reallocation')}</h3><button className="pl-export" disabled={busy || Boolean(dirty) || Boolean(exporting)} onClick={() => void download(which)}><ArrowDownToLine size={13} />{zh ? `下载${which === 'own' ? '直营' : 'JV'}清单` : `Download ${which === 'own' ? 'self-owned' : 'JV'} lists`}</button></div>
        <div className="da-table sf-totals"><table><thead><tr><th>Dealer</th><th>Ideal</th><th>{zh ? '上限' : 'Ceiling'}</th><th>{zh ? '国内生产延期' : 'China-stage delayed'}</th><th>{zh ? '延期合计' : 'All delayed'}</th><th>{zh ? '取消' : 'Cancel'}</th><th>{zh ? '库存池不生产' : 'Pool not built'}</th>{which === 'own' && <th>Reallocation</th>}<th>{zh ? '待分流/核对' : 'Review'}</th></tr></thead><tbody>
          {group.dealers.map(d => <tr key={d.slug}><td><b>{d.name}</b></td><td>{d.target}</td><td>{d.cap}</td><td>{d.stats.cnDelayed}</td><td>{d.stats.delayed}</td><td>{d.stats.canceled}</td><td>{d.stats.poolNotBuilt}</td>{which === 'own' && <td>{d.stats.reallocated}</td>}<td>{d.stats.pending}</td></tr>)}
          <tr className="total"><td>{zh ? '合计' : 'Total'}</td><td>{group.dealers.reduce((n, d) => n + d.target, 0)}</td><td>{group.dealers.reduce((n, d) => n + d.cap, 0)}</td><td>{group.summary.cnDelayed}</td><td>{group.summary.delayed}</td><td>{group.summary.canceled}</td><td>{group.summary.poolNotBuilt}</td>{which === 'own' && <td>{group.summary.reallocated}</td>}<td>{group.summary.pending}</td></tr>
        </tbody></table></div>
        <div className={`da-cards sf-cards ${data.months > 8 ? 'sf-long' : ''}`}>{group.dealers.map(d => <DealerCard key={d.slug} d={chartDealer(d)} zh={zh} />)}</div>
      </section>; })}
      <section className="sf-actions"><div className="da-subhead"><h3 className="da-sub">{zh ? '车架号调整明细' : 'Vehicle adjustment details'}</h3><div className="sf-scope">{(['own', 'jv'] as const).map(s => <button aria-pressed={s === scope} key={s} className={scope === s ? 'active' : ''} onClick={() => { setScope(s); if (s === 'jv' && filter === 'reallocate') setFilter('cancel'); setPage(0); }}>{s === 'own' ? (zh ? '直营店' : 'Self-owned') : 'JV Dealers'}</button>)}</div></div>
        <div className="sf-list-controls"><div className="sf-filters">{filters.map(([k, label, count]) => <button key={k} aria-pressed={filter === k} className={filter === k ? 'active' : ''} onClick={() => { setFilter(k); setPage(0); }}>{label} <b>{selected?.summary[count as keyof Summary]}</b></button>)}</div><label className="sf-search"><Search size={13} /><input aria-label={zh ? '搜索调整清单' : 'Search adjustment list'} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Chassis / Model / Dealer" /></label></div>
        <div className="da-table sf-detail"><table><thead><tr><th>Chassis</th><th>Model</th><th>{zh ? '阶段' : 'Stage'}</th><th>{zh ? '处理' : 'Action'}</th><th>{zh ? '原Dealer' : 'Original dealer'}</th><th>{zh ? '接收Dealer' : 'Receiving dealer'}</th><th>{zh ? '原AU完工' : 'Original AU finish'}</th><th>{zh ? '建议AU完工' : 'Proposed AU finish'}</th><th>{zh ? 'AU后移天数' : 'AU delay days'}</th><th>{zh ? '原到店' : 'Original arrival'}</th><th>{zh ? '建议到店' : 'Proposed arrival'}</th><th>{zh ? '到店变化天数' : 'Arrival change days'}</th><th>{zh ? '建议发车' : 'Proposed departure'}</th><th>{zh ? '推荐车型' : 'Recommended'}</th><th>{zh ? '原因' : 'Reason'}</th></tr></thead><tbody>
          {listed.slice(page * 50, (page + 1) * 50).map(a => <tr key={`${a.group}-${a.chassis}`}><td><b>{a.chassis}</b></td><td>{a.model}</td><td>{a.phase}</td><td>{actionLabel(a.action, zh)}{a.reallocated && a.delayed ? (zh ? '＋延期' : ' + delay') : ''}</td><td>{a.originalDealer}</td><td>{a.proposedDealer || '—'}</td><td>{fmt(a.originalAu)}</td><td>{fmt(a.plannedAu)}</td><td>{a.delayDays ?? '—'}</td><td>{fmt(a.originalArrival)}</td><td>{fmt(a.plannedArrival)}</td><td>{a.arrivalDelayDays ?? '—'}</td><td>{fmt(a.depart)}</td><td>{a.policy === 'check' ? (zh ? '待核对' : 'Review') : a.policy === 'display' ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}</td><td>{reasonLabel(a.reason, zh)}</td></tr>)}
          {!listed.length && <tr><td colSpan={15} className="sf-empty">{zh ? '没有符合条件的车辆' : 'No matching vehicles'}</td></tr>}
        </tbody></table></div>
        <div className="sf-pager"><span>{zh ? `共${listed.length}台` : `${listed.length} vehicles`}</span><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{page + 1} / {Math.max(1, Math.ceil(listed.length / 50))}</span><button disabled={(page + 1) * 50 >= listed.length} onClick={() => setPage(p => p + 1)}>{zh ? '下一页' : 'Next'}</button></div>
      </section>
      <details className="sf-rules"><summary>{zh ? '推荐车型与测算规则' : 'Recommended models and scenario rules'}</summary><p>{zh ? '25款常态Towable展车：' : '25 routine Towable display models: '}{DISPLAY_MODELS.join(', ')}</p><p>Not on yard: {NOT_ON_YARD.join(', ')}</p><p>{zh ? 'MY2027删除车型：SRT18、SRP18F 2 Bunks。未准确匹配的型号先核对。按国内→锁定→滚动顺序安排，考虑各店总量及同款缓冲。现货跨店运输为暂估，调拨候选须核实未售。不是全局最优或产能承诺。' : 'Deleted MY2027: SRT18, SRP18F 2 Bunks. Unknown models require review. Sequence: started China supply, locked, rolling, considering dealer and model limits. Yard-transfer transit is an allowance; verify unsold vehicles. This is a planning scenario, not a global optimum or a capacity commitment.'}</p>{data.warnings.length > 0 && <p>{zh ? `已按车架号去重${data.warnings.length}条重复来源记录。` : `${data.warnings.length} duplicate source rows deduplicated by chassis.`}</p>}</details>
    </>}
  </section>;
}
