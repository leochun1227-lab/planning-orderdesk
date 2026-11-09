// 产线: the Dealer Portal production board (same groups, plan / expected / MRP dates and delay as
// the Portal page), plus live facts per vehicle: Longtree node dates, AU factory station, SAP GR/GI.
// Data: /api/production-line (read-only).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, type ColDef, type ColGroupDef } from 'ag-grid-community';
import { Button } from '@/components/ui/button';
import { ArrowDownToLine, Factory, CalendarDays, Layers, Clock3, Search, X, ListFilter, RefreshCw, AlertTriangle } from 'lucide-react';

type Group = { id: string; band: 'execution' | 'scheduling' | 'preschedule' | 'later'; zh: string; en: string; note: string; phase?: 'au' | 'sea' | 'cn' };
type Live = { stage: string; since: string; days: number | null; inLongtree: boolean; orderAt: string; weldAt: string; furnitureAt: string; assemblyAt: string; finishedAt: string; shippedAt: string; etd: string; atd: string; eta: string; ata: string; notes: Record<string, string>;
  grAt: string; grSource: string; giAt: string; inProduction: boolean; location: string; station: string; flags: string[]; enteredAt: string; stationSince: string; daysAtStation: number | null; history: { stage: string; location: string; at: string }[] };
type View = { grText: string; grSub: string; giText: string; giSub: string; ltText: string; ltSub: string; prodText: string; prodSub: string; judge: string; judgeSub: string; judgeTone: string; differs: boolean };
type Row = {
  liveStageName?: string; liveTone?: string; v?: View;
  id: string; chassis: string; empty: boolean; line: string; source: string; group: string; status: string; dealer: string; model: string; range: string; customer: string; orderId: string;
  production: null | { status: string; stage: string; location: string };
  cnActual: string; cnStart: string; cnPlanStart: string; cnPlanEnd: string; auActual: string; auStart: string; auPlanStart: string; auPlanEnd: string;
  planStart: string; planEnd: string; expectedEnd: string; delay: number | null; cnMrp: string; auMrp: string; overdue: boolean; locked: boolean; warnings: string[]; live: Live | null;
};
type Payload = { today: string; counts: Record<string, number>; completed: number; averages: Record<string, { days: number | null; count: number }>; rows: Row[]; groups: Group[]; stages: { id: string; zh: string; en: string; group: string }[]; refreshing?: boolean; sources: Record<string, { at: string; error: string; count: number; configured: boolean }> };

const EXEC = ['au', 'sea', 'cn'];
const STAGE_TONE: Record<string, string> = { cn: '#b35c00', sea: '#1971c2', au: '#2b8a3e', done: '#5c677d' };
const FLAG_COLORS: Record<string, [string, string]> = { G: ['#2b8a3e', '#fff'], B: ['#1c7ed6', '#fff'], O: ['#f08c00', '#fff'], R: ['#e03131', '#fff'], Y: ['#fcc419', '#3d2c00'], M: ['#c2255c', '#fff'], P: ['#7048e8', '#fff'], D: ['#343a40', '#fff'] };
const CHIPS = [
  { id: 'delay', zh: '已延迟', en: 'Delayed', test: (r: Row) => (r.delay ?? 0) > 0 },
  { id: 'overdue', zh: '已过国内计划上线日', en: 'Past CN plan start', test: (r: Row) => r.overdue },
  { id: 'station', zh: '同一工位 >14 天', en: 'Same station >14d', test: (r: Row) => (r.live?.daysAtStation ?? 0) > 14 },
  { id: 'noGr', zh: '到港未 GR >14 天', en: 'Arrived, no GR >14d', test: (r: Row) => r.live?.stage === 'seaArrived' && (r.live.days ?? 0) > 14 },
  { id: 'differs', zh: '初步判断与 Portal 不同', en: 'Live differs from Portal', test: (r: Row) => Boolean(r.v?.differs) },
  { id: 'warn', zh: '有字段待补', en: 'Has warnings', test: (r: Row) => r.warnings.length > 0 },
] as const;

const time = (v?: string) => v ? new Date(v).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const gridTheme = themeQuartz.withParams({
  fontFamily: '"Segoe UI", Inter, "Microsoft YaHei", sans-serif', fontSize: 12.5, headerFontSize: 12, headerFontWeight: 700,
  foregroundColor: '#1d2433', backgroundColor: '#fff', headerBackgroundColor: '#1f3352', headerTextColor: '#fff',
  borderColor: '#d9dee7', rowBorder: { color: '#e6e9ef', width: 1 }, columnBorder: { color: '#edf0f4', width: 1 },
  wrapperBorder: false, wrapperBorderRadius: 0, cellHorizontalPadding: 7, rowHoverColor: '#eef4ff', accentColor: '#2f5be0', headerColumnResizeHandleColor: '#5a7097',
});
const Two = ({ top, sub, strong }: { top: React.ReactNode; sub?: React.ReactNode; strong?: boolean }) => <div className="pl-two">{strong ? <strong>{top}</strong> : <span>{top}</span>}{sub ? <small>{sub}</small> : null}</div>;
function OnlineDate({ actual, expected, baseline, zh }: { actual: string; expected: string; baseline: string; zh: boolean }) {
  return <div className="pl-two" title={actual ? `${zh ? '源数据实际日期' : 'Actual'}：${actual}` : `${zh ? '预计日期；原计划' : 'Expected; baseline'}：${baseline || '—'}`}>
    <strong>{actual || expected || '—'}</strong>
    <small><span className={`pl-kind ${actual ? 'actual' : ''}`}>{actual ? (zh ? '实际' : 'Actual') : expected ? (zh ? '预计' : 'Expected') : (zh ? '待补日期' : 'No date')}</span>{!actual && baseline && baseline !== expected ? ` ${zh ? '原计划' : 'plan'} ${baseline}` : ''}</small></div>;
}

const LT_NODES: [keyof Live, string, string][] = [['ata', '实际到港', 'Arrived AU port'], ['atd', '实际离港', 'Left CN port'], ['shippedAt', '发运', 'Shipped'], ['finishedAt', '总装入库', 'Finished'], ['assemblyAt', '总装上线', 'Assembly'], ['furnitureAt', '家具上线', 'Furniture'], ['weldAt', '钣焊上线', 'Welding'], ['orderAt', '订单接收', 'Order received']];
const LOCATION_ZH: Record<string, string> = { received: '已接收', 'pre-assembly': '预装', production: '生产', qc: '质检', transport: '待运输' };
const LIVE_PHASE: Record<string, string> = { cnWaiting: 'plan', cnWelding: 'cn', cnAssembly: 'cn', cnFinished: 'cn', cnShipped: 'sea', seaPort: 'sea', seaOnWater: 'sea', seaArrived: 'sea', auFactory: 'au', gi: 'done' };
/** The four live facts as plain results, plus a first reading that does not change the Portal group. */
function viewOf(r: Row, zh: boolean, today: string, stageName: (id?: string) => string, groupName: (id: string) => string): View | undefined {
  const l = r.live; if (!l) return undefined;
  const node = LT_NODES.find(([f]) => { const d = l[f] as string; return d && d <= today; });
  const future = !node ? '' : '';
  const ltSub = !l.inLongtree ? '' : l.atd && !l.ata ? `${zh ? '预计到港' : 'ETA'} ${l.eta || '—'}` : l.shippedAt && !l.atd ? `${zh ? '预计离港' : 'ETD'} ${l.etd || '—'}` : Object.values(l.notes || {})[0] || future;
  const phase = LIVE_PHASE[l.stage], board = ['au', 'sea', 'cn'].includes(r.group) ? r.group : 'plan';
  const differs = phase !== board && !(phase === 'done' && board === 'au');
  return {
    grText: l.grAt ? (zh ? '已 GR' : 'GR done') : (zh ? '未 GR' : 'No GR'), grSub: l.grAt ? `${l.grAt} · ${l.grSource}` : '',
    giText: l.giAt ? (zh ? '已 GI' : 'GI done') : (zh ? '未 GI' : 'No GI'), giSub: l.giAt || '',
    ltText: !l.inLongtree ? (zh ? '飞书无此车' : 'Not in Longtree') : node ? `${zh ? node[1] : node[2]} · ${l[node[0]]}` : (zh ? '未开始' : 'Not started'), ltSub,
    prodText: l.inProduction ? `${zh ? LOCATION_ZH[l.location] || l.location : l.location} · ${l.station || '—'}` : (zh ? '生产系统无此车' : 'Not in production API'),
    prodSub: l.inProduction ? `${zh ? '工位' : 'Station'} ${l.daysAtStation ?? '—'} ${zh ? '天' : 'd'}${l.enteredAt ? ` · ${zh ? '进厂' : 'in'} ${l.enteredAt}` : ''}` : '',
    judge: stageName(l.stage), judgeSub: differs ? `Portal：${groupName(r.group)}` : (l.days != null ? `${l.days} ${zh ? '天' : 'd'}` : ''), judgeTone: '', differs,
  };
}

export default function ProductionLineView({ zh, onOpenOrder }: { zh: boolean; onOpenOrder: (id: string) => void }) {
  const [data, setData] = useState<Payload | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [group, setGroup] = useState('au'), [line, setLine] = useState('All'), [chip, setChip] = useState(''), [sort, setSort] = useState<'status' | 'date'>('status');
  const [query, setQuery] = useState(''), [dealer, setDealer] = useState(''), [detail, setDetail] = useState<Row | null>(null);
  const grid = useRef<AgGridReact<Row>>(null);
  async function load(refresh = false) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/production-line${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || (zh ? '产线数据读取失败' : 'Could not load production data'));
      setData(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  const groups = data?.groups || [];
  const groupOf = (id: string) => groups.find(g => g.id === id);
  const stageName = (id?: string) => { const s = data?.stages.find(x => x.id === id); return s ? (zh ? s.zh : s.en) : ''; };
  const stageTone = (id?: string) => STAGE_TONE[data?.stages.find(x => x.id === id)?.group || 'cn'];
  const groupName = (id: string) => { const x = groups.find(g => g.id === id); return x ? (zh ? x.zh : x.en) : id; };
  const rows = useMemo(() => (data?.rows || []).map(r => ({ ...r, liveStageName: r.live ? stageName(r.live.stage) : '', liveTone: r.live ? stageTone(r.live.stage) : '', v: viewOf(r, zh, data?.today || '', stageName, groupName) })), [data, zh]);
  const searching = query.trim().length > 0;
  const base = useMemo(() => rows.filter(r => (line === 'All' || r.line === line) && (!dealer || r.dealer === dealer)), [rows, line, dealer]);
  const counts = useMemo(() => Object.fromEntries(groups.map(g => [g.id, base.filter(r => r.group === g.id).length])), [base, groups]);
  const inGroup = useMemo(() => base.filter(r => r.group === group), [base, group]);
  const chipCounts = useMemo(() => Object.fromEntries(CHIPS.map(c => [c.id, inGroup.filter(c.test).length])), [inGroup]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[-\s]/g, '');
    let list = searching ? base.filter(r => [r.chassis, r.model, r.dealer, r.customer, r.live?.station].some(v => String(v || '').toLowerCase().replace(/[-\s]/g, '').includes(q))) : inGroup;
    const c = CHIPS.find(x => x.id === chip);
    if (c && !searching) list = list.filter(c.test);
    return sort === 'date' ? [...list].sort((a, b) => (a.cnStart || '9999').localeCompare(b.cnStart || '9999')) : list;
  }, [base, inGroup, query, chip, sort]);
  const dealers = useMemo(() => Array.from(new Set(rows.map(r => r.dealer).filter(Boolean))).sort(), [rows]);
  const exec = EXEC.includes(group) || searching;
  const g = groupOf(group);
  const band = (ids: string[]) => ids.reduce((n, id) => n + (counts[id] || 0), 0);

  const columns = useMemo<(ColDef<Row> | ColGroupDef<Row>)[]>(() => [
    { headerName: zh ? 'Portal · 上线 / 车辆' : 'Portal · start / vehicle', children: [
      { colId: 'cnStart', headerName: zh ? '国内上线时间' : 'CN start', pinned: 'left', width: 150, valueGetter: p => p.data?.cnActual || p.data?.cnStart || '', cellRenderer: (p: any) => p.data && <OnlineDate zh={zh} actual={p.data.cnActual} expected={p.data.cnStart} baseline={p.data.cnPlanStart} /> },
      { colId: 'auStart', headerName: zh ? '澳洲上线时间' : 'AU start', pinned: 'left', width: 150, valueGetter: p => p.data?.auActual || p.data?.auStart || '', cellRenderer: (p: any) => p.data && <OnlineDate zh={zh} actual={p.data.auActual} expected={p.data.auStart} baseline={p.data.auPlanStart} /> },
      { field: 'chassis', headerName: zh ? '车架号 / 订单' : 'Chassis / order', pinned: 'left', width: 150, cellRenderer: (p: any) => p.data && <div className="pl-two"><button className="chassis-link" onClick={() => setDetail(p.data)}>{p.data.empty ? 'Empty slot' : p.value}</button><small>{p.data.line} · {p.data.source}</small></div> },
    ] },
    { headerName: zh ? 'Dealer Portal 排产（与 Portal 一致）' : 'Dealer Portal board (same as Portal)', children: [
      { field: 'dealer', headerName: 'Dealer', width: 116, cellRenderer: (p: any) => p.value || <span className="pl-missing">{zh ? '待分配 Dealer' : 'No dealer'}</span> },
      { field: 'model', headerName: 'Model / Range', width: 118, cellRenderer: (p: any) => p.data && <Two strong top={p.data.model || (zh ? '未提供车型' : 'No model')} sub={p.data.range} /> },
      { colId: 'prodStatus', headerName: zh ? '生产状态' : 'Production status', width: 170, valueGetter: p => p.data ? (p.data.production?.status || p.data.production?.stage || (p.data.empty ? (zh ? '待补订单' : 'Awaiting order') : p.data.status)) : '',
        cellRenderer: (p: any) => p.data && <div className="pl-two"><span className={`pl-tag ${p.data.group}`}>{p.value}</span>{p.data.production && <small>{p.data.status}{p.data.production.stage ? ` · ${p.data.production.stage}` : ''}</small>}</div> },
      { colId: 'prodLocation', headerName: zh ? '生产库位' : 'Location', width: 92, valueGetter: p => p.data?.production?.location || '', cellRenderer: (p: any) => p.value || <span className="pl-missing">{zh ? '未提供' : '—'}</span> },
      { colId: 'planStart', headerName: exec ? (zh ? '计划开始' : 'Plan start') : (zh ? '国内计划完成' : 'CN plan end'), width: 96, valueGetter: p => (p.data ? (EXEC.includes(p.data.group) ? p.data.planStart : p.data.cnPlanEnd) : '') || '—' },
      { field: 'planEnd', headerName: exec ? (zh ? '计划完成' : 'Plan end') : (zh ? '澳洲计划完成' : 'AU plan end'), width: 96, valueFormatter: p => p.value || '—' },
      { field: 'expectedEnd', headerName: exec ? (zh ? '预计完成' : 'Expected end') : (zh ? '澳洲预计完成' : 'AU expected end'), width: 100, cellClass: 'pl-bold', valueFormatter: p => p.value || '—' },
      { field: 'delay', headerName: zh ? '延迟天数' : 'Delay', width: 74, cellRenderer: (p: any) => p.value == null ? '—' : <span className={p.value > 0 ? 'pl-delay' : 'pl-ontime'}>{p.value > 0 ? '+' : ''}{p.value} {zh ? '天' : 'd'}</span> },
      { field: 'cnMrp', headerName: zh ? '国内 MRP 日期' : 'CN MRP', width: 96, valueFormatter: p => p.value || '—' },
      { field: 'auMrp', headerName: zh ? '澳洲 MRP 日期' : 'AU MRP', width: 96, valueFormatter: p => p.value || '—' },
      ...(group === 'customers' && !searching ? [{ colId: 'orderType', headerName: zh ? '订单类型 / Customer' : 'Order type / customer', width: 160, valueGetter: (p: any) => p.data?.customer, cellRenderer: (p: any) => p.data && <Two top={/\/.*stock/i.test(p.data.customer) ? 'Transfer from stock' : 'Customer'} sub={p.data.customer} /> } as ColDef<Row>] : []),
      ...(!exec ? [{ colId: 'scheduleState', headerName: group === 'empty' || group === 'customers' ? (zh ? '订单进度' : 'Order progress') : (zh ? '排产状态' : 'Schedule state'), width: 150,
        valueGetter: (p: any) => !p.data ? '' : p.data.empty ? (p.data.dealer ? (zh ? '等待车架号' : 'Waiting for chassis') : (zh ? '待分配 Dealer / 车架号' : 'Needs dealer / chassis')) : group === 'customers' ? (zh ? '待匹配 slot' : 'Needs slot') : group === 'later' ? (p.data.cnPlanStart ? (zh ? '60 天以外' : 'Beyond 60 days') : (zh ? '计划日期待补' : 'Plan date missing')) : p.data.locked ? (zh ? '已确认锁定' : 'Locked') : (zh ? '待确认' : 'To confirm'),
        cellRenderer: (p: any) => p.data && <div className="pl-two"><span className={`pl-tag ${p.data.overdue ? 'overdue' : 'neutral'}`}>{p.value}</span>{p.data.overdue && <small className="pl-delay">{zh ? '已过国内计划上线日' : 'Past CN plan start'}</small>}</div> } as ColDef<Row>] : []),
    ] },
    { headerName: zh ? '实时 · 四个来源（只列结果，不改 Portal 分组）' : 'Live · four sources (results only)', children: [
      { colId: 'gr', headerName: 'GR', width: 150, valueGetter: p => p.data?.v?.grSub || p.data?.v?.grText || '', cellRenderer: (p: any) => p.data?.v && <div className="pl-two"><span className={`pl-yes ${p.data.live.grAt ? 'on' : ''}`}>{p.data.v.grText}</span><small>{p.data.v.grSub}</small></div> },
      { colId: 'gi', headerName: 'GI', width: 104, valueGetter: p => p.data?.v?.giSub || p.data?.v?.giText || '', cellRenderer: (p: any) => p.data?.v && <div className="pl-two"><span className={`pl-yes ${p.data.live.giAt ? 'on' : ''}`}>{p.data.v.giText}</span><small>{p.data.v.giSub}</small></div> },
      { colId: 'longtree', headerName: zh ? '飞书 Longtree' : 'Longtree (Feishu)', width: 176, valueGetter: p => p.data?.v?.ltText || '', tooltipValueGetter: p => p.data?.v?.ltSub || undefined, cellRenderer: (p: any) => p.data?.v && <Two top={p.data.v.ltText} sub={p.data.v.ltSub} /> },
      { colId: 'production', headerName: zh ? 'Production API（Rafael）' : 'Production API (Rafael)', width: 262, valueGetter: p => p.data?.v?.prodText || '',
        cellRenderer: (p: any) => p.data?.v && <div className="pl-two"><span>{p.data.v.prodText}</span><small>{p.data.v.prodSub}{(p.data.live.flags || []).length > 0 && <span className="pl-flags" style={{ marginLeft: 6 }}>{p.data.live.flags.map((f: string, i: number) => <i key={i} style={{ background: FLAG_COLORS[f]?.[0] || '#868e96', color: FLAG_COLORS[f]?.[1] || '#fff' }}>{f}</i>)}</span>}</small></div> },
      { colId: 'judge', headerName: zh ? '初步判断' : 'First reading', width: 140, valueGetter: p => p.data?.v?.judge || '',
        cellRenderer: (p: any) => p.data?.v && <div className="pl-two"><span className="pl-stage" style={{ background: p.data.liveTone, alignSelf: 'flex-start' }}>{p.data.v.judge}</span><small className={p.data.v.differs ? 'pl-delay' : ''}>{p.data.v.judgeSub}</small></div> },
    ] },
  ], [zh, group, exec, searching, data]);

  function exportCsv() { grid.current?.api.exportDataAsCsv({ fileName: `Production-line-${g?.id || 'search'}-${data?.today || ''}.csv` }); }
  const src = data?.sources || {};
  const srcLabel: Record<string, string> = { portal: 'Dealer Portal', longtree: 'Longtree', prod: zh ? '澳洲生产' : 'AU production' };
  const avg = g?.phase ? data?.averages?.[g.phase] : null;
  const card = (ids: string[], Icon: any, step: string, title: string, sub: string, target: string) =>
    <button className={`pl-band ${ids.includes(group) && !searching ? 'on' : ''}`} onClick={() => { setGroup(target); setChip(''); setQuery(''); }}><Icon size={20} /><div><span>{step}</span><strong>{band(ids).toLocaleString()} <small>{zh ? '辆' : ''}</small></strong><p>{sub}</p></div></button>;

  return <section className="table-panel schedule-panel pl-panel">
    <div className="pl-overview">
      {card(['au', 'sea', 'cn'], Factory, zh ? '01 · 产线执行' : '01 · Execution', '', `${zh ? '澳洲' : 'AU'} ${counts.au ?? 0} · ${zh ? '海运' : 'Sea'} ${counts.sea ?? 0} · ${zh ? '国内' : 'CN'} ${counts.cn ?? 0}`, 'au')}
      {card(['locked', 'rolling'], CalendarDays, zh ? '02 · 滚动 60 天' : '02 · Rolling 60 days', '', `${zh ? '已锁定' : 'Locked'} ${counts.locked ?? 0} · ${zh ? '待确认' : 'To confirm'} ${counts.rolling ?? 0}`, 'locked')}
      {card(['empty', 'customers'], Layers, zh ? '03 · 预排产' : '03 · Pre-schedule', '', `Empty slots ${counts.empty ?? 0} · Customer ${counts.customers ?? 0}`, 'empty')}
      {card(['later'], Clock3, zh ? '后续排产 / 日期待补' : 'Later / dates missing', '', zh ? '国内计划上线在 60 天之后' : 'CN plan start beyond 60 days', 'later')}
      <div className="pl-band static"><div><span>{zh ? '已排除已发运' : 'Dispatched (excluded)'}</span><strong>{(data?.completed ?? 0).toLocaleString()}</strong><p>{(rows.length).toLocaleString()} {zh ? '条未发运车辆 / slot' : 'open vehicles / slots'}</p></div></div>
    </div>
    <div className="pl-tabs" role="tablist">
      {groups.map(x => <button key={x.id} role="tab" aria-selected={group === x.id && !searching} className={`pl-tab ${x.id} ${group === x.id && !searching ? 'on' : ''}`} onClick={() => { setGroup(x.id); setChip(''); setQuery(''); }}>{zh ? x.zh : x.en}<b>{(counts[x.id] ?? 0).toLocaleString()}</b></button>)}
    </div>
    <div className="pl-section-head">
      <div><h3>{searching ? (zh ? `搜索「${query}」` : `Search "${query}"`) : (zh ? g?.zh : g?.en)} <span className="count-chip">{visible.length.toLocaleString()}</span></h3><p>{searching ? (zh ? '在所有分组里搜索' : 'Searching every group') : g?.note}</p></div>
      <div className="pl-head-right"><label className="pl-sort">{zh ? '排序' : 'Sort'}<select value={sort} onChange={e => setSort(e.target.value as 'status' | 'date')}><option value="status">{zh ? '生产状态 → 生产库位 → 国内上线' : 'Status → location → CN start'}</option><option value="date">{zh ? '国内上线日期' : 'CN start date'}</option></select></label>
      {avg && !searching && <div className="pl-average"><span>{zh ? '已完成节点平均用时' : 'Average completed stage'}</span><strong>{avg.days == null ? '—' : `${avg.days} ${zh ? '天' : 'd'}`}</strong><small>{avg.count} {zh ? '条有效样本' : 'samples'}</small></div>}</div>
    </div>
    <div className="schedule-toolbar">
      <div className="seg" role="group">{[['All', zh ? '全部' : 'All'], ['SRV', 'SRV'], ['SRM', 'SRM'], ['Towable', 'Towable']].map(([v, l]) => <button key={v} aria-pressed={line === v} onClick={() => setLine(v)}>{l}</button>)}</div>
      {!searching && <div className="chips">{CHIPS.map(c => <button key={c.id} className={`chip ${chip === c.id ? 'on' : ''}`} onClick={() => setChip(chip === c.id ? '' : c.id)}><i style={{ background: chipCounts[c.id] ? '#ffe3e3' : '#f1f3f5', color: chipCounts[c.id] ? '#c92a2a' : '#868e96' }}>{chipCounts[c.id] ?? 0}</i>{zh ? c.zh : c.en}</button>)}</div>}
      <label className="search"><Search size={16} /><input placeholder={zh ? '车架号、Dealer、车型或客户…' : 'Chassis, dealer, model or customer…'} value={query} onChange={e => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')}><X size={14} /></button>}</label>
      <label className="dealer-filter"><ListFilter size={16} /><select value={dealer} onChange={e => setDealer(e.target.value)}><option value="">{zh ? '全部经销商' : 'All dealers'}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label>
    </div>
    <div className="pl-sources">
      {Object.entries(srcLabel).map(([k, l]) => <span key={k} className={src[k]?.error ? 'bad' : 'ok'} title={src[k]?.error || ''}>{l} · {src[k]?.error === 'not configured' ? (zh ? '未配置' : 'not configured') : src[k]?.error ? (zh ? '读取失败，显示上次数据' : 'failed, showing last copy') : time(src[k]?.at)}</span>)}
      <span className="muted">{zh ? '只读 · 排产日期与 Dealer Portal 相同算法' : 'Read-only · board dates use the Dealer Portal code'}</span>
      <button className="pl-export" onClick={exportCsv} disabled={!visible.length}><ArrowDownToLine size={14} />{zh ? '导出 CSV' : 'Export CSV'}</button>
      <button aria-label={zh ? '刷新' : 'Refresh'} className={busy || data?.refreshing ? 'icon-button spinning' : 'icon-button'} disabled={busy} onClick={() => void load(true)}><RefreshCw size={15} /></button>
    </div>
    {error && <div className="message error compact-msg"><AlertTriangle size={16} />{error}</div>}
    {!data && !error && <div className="pl-loading">{zh ? '正在读取 Dealer Portal、Longtree 和澳洲生产系统…第一次大约需要 30–40 秒' : 'Loading Dealer Portal, Longtree and AU production… the first load takes ~30–40 s'}</div>}
    <div className="schedule-grid">
      <AgGridReact<Row> ref={grid} theme={gridTheme} rowData={visible} columnDefs={columns} getRowId={p => p.data.id}
        defaultColDef={{ resizable: true, sortable: true, suppressMovable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        rowHeight={42} headerHeight={34} groupHeaderHeight={24} tooltipShowDelay={250} enableCellTextSelection
        onRowDoubleClicked={e => e.data && setDetail(e.data)}
        overlayNoRowsTemplate={`<span style="color:#61718a">${zh ? '当前筛选下没有记录' : 'No matching records'}</span>`} />
    </div>
    {detail && <aside className="pl-detail" role="dialog" aria-label={detail.chassis || 'slot'}>
      <header><div><strong>{detail.empty ? 'Empty slot' : detail.chassis}</strong><span>{detail.model} · {detail.dealer || '—'} · {detail.customer || '—'}</span></div><button className="icon-button" aria-label={zh ? '关闭' : 'Close'} onClick={() => setDetail(null)}><X size={16} /></button></header>
      <div className="pl-plan">
        {([[zh ? '国内上线' : 'CN start', detail.cnActual || detail.cnStart, detail.cnActual ? (zh ? '实际' : 'actual') : (zh ? '预计' : 'expected')], [zh ? '澳洲上线' : 'AU start', detail.auActual || detail.auStart, detail.auActual ? (zh ? '实际' : 'actual') : (zh ? '预计' : 'expected')], [zh ? '计划完成' : 'Plan end', detail.planEnd, ''], [zh ? '预计完成' : 'Expected end', detail.expectedEnd, detail.delay ? `${detail.delay > 0 ? '+' : ''}${detail.delay} ${zh ? '天' : 'd'}` : ''], [zh ? '国内 MRP' : 'CN MRP', detail.cnMrp, ''], [zh ? '澳洲 MRP' : 'AU MRP', detail.auMrp, '']] as string[][])
          .map(([l, v, n]) => <div key={l}><span>{l}</span><b>{v || '—'}</b><em>{n}</em></div>)}
      </div>
      {detail.live && <ol className="pl-timeline">
        {([[zh ? '钣焊上线' : 'Welding', detail.live.weldAt], [zh ? '总装上线' : 'Assembly', detail.live.assemblyAt], [zh ? '总装入库' : 'Finished', detail.live.finishedAt], [zh ? '发运' : 'Shipped', detail.live.shippedAt], [zh ? '实际离港' : 'ATD', detail.live.atd], [zh ? '实际到港' : 'ATA', detail.live.ata], ['GR', detail.live.grAt], ['GI', detail.live.giAt]] as [string, string][])
          .map(([l, v]) => <li key={l} className={v ? 'done' : ''}><span>{l}</span><b>{v || '—'}</b></li>)}
      </ol>}
      {detail.live?.history?.length ? <><h4>{zh ? '澳洲工厂工位记录（实时）' : 'AU station history (live)'}</h4><ul className="pl-history">{detail.live.history.map((h, i) => <li key={i}><span>{time(h.at)}</span><b>{h.stage}</b><em>{h.location}</em></li>)}</ul></> : null}
      {detail.warnings.length > 0 && <p className="pl-notes">{detail.warnings.join('；')}</p>}
      {Object.keys(detail.live?.notes || {}).length > 0 && <p className="pl-notes">{Object.values(detail.live!.notes).join(' · ')}</p>}
      {detail.orderId && <Button variant="outline" className="action slim" onClick={() => onOpenOrder(detail.orderId)}>{zh ? '打开订单' : 'Open order'}</Button>}
    </aside>}
  </section>;
}
