// 产线 (production line): where every signed order is, Longtree → sea → AU factory → GI.
// Data from /api/production-line (read-only merge of Longtree, AU production API and Portal GR/GI).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, type ColDef, type ColGroupDef } from 'ag-grid-community';
import { Button } from '@/components/ui/button';
import { ArrowDownToLine, Factory, Ship, Warehouse, Search, X, ListFilter, RefreshCw, AlertTriangle, PackageCheck } from 'lucide-react';

type Stage = { id: string; group: 'cn' | 'sea' | 'au' | 'done'; zh: string; en: string };
type Row = {
  stageName?: string; stageGroup?: string;
  id: string; chassis: string; model: string; dealer: string; customer: string; stage: string; stageIndex: number; since: string; daysInStage: number | null;
  signedAt: string; forecastDate: string; grAt: string; giAt: string; grToToday: number | null;
  cn: null | { orderAt: string; weldAt: string; furnitureAt: string; assemblyAt: string; finishedAt: string; shippedAt: string; notes: Record<string, string> };
  sea: null | { etd: string; atd: string; eta: string; ata: string };
  au: null | { location: string; station: string; flags: string[]; enteredAt: string; stationSince: string; daysAtStation: number | null; forecastAt: string; history: { stage: string; location: string; at: string }[] };
};
type Payload = { today: string; counts: Record<string, number>; unsigned: number; rows: Row[]; stages: Stage[]; refreshing?: boolean; sources: Record<string, { at: string; error: string; count: number; configured: boolean }>; error?: string };

// Alerts: days a vehicle has been waiting. Thresholds are a starting point, to be tuned with Planning.
const ALERTS = [
  { id: 'cnIdle', zh: '国内完工未发运 >14 天', en: 'Finished, not shipped >14d', test: (r: Row) => r.stage === 'cnFinished' && (r.daysInStage ?? 0) > 14 },
  { id: 'portWait', zh: '等待离港 >21 天', en: 'At CN port >21d', test: (r: Row) => r.stage === 'seaPort' && (r.daysInStage ?? 0) > 21 },
  { id: 'noGr', zh: '到港未 GR >14 天', en: 'Arrived, no GR >14d', test: (r: Row) => r.stage === 'seaArrived' && (r.daysInStage ?? 0) > 14 },
  { id: 'station', zh: '同一工位 >14 天', en: 'Same station >14d', test: (r: Row) => r.stage === 'auFactory' && (r.au?.daysAtStation ?? 0) > 14 },
  { id: 'grLong', zh: 'GR 后 >60 天未 GI', en: 'GR >60d, no GI', test: (r: Row) => r.stage === 'auFactory' && (r.grToToday ?? 0) > 60 },
  { id: 'noAu', zh: '已 GR，生产系统无记录', en: 'GR but not in production system', test: (r: Row) => r.stage === 'auFactory' && !r.au },
] as const;
const LOCATIONS = ['received', 'pre-assembly', 'production', 'qc', 'transport'];
const LOCATION_ZH: Record<string, string> = { received: '已接收', 'pre-assembly': '预装', production: '生产', qc: '质检', transport: '待运输' };
const FLAG_COLORS: Record<string, [string, string]> = { G: ['#2b8a3e', '#fff'], B: ['#1c7ed6', '#fff'], O: ['#f08c00', '#fff'], R: ['#e03131', '#fff'], Y: ['#fcc419', '#3d2c00'], M: ['#c2255c', '#fff'], P: ['#7048e8', '#fff'], D: ['#343a40', '#fff'] };
const STAGE_COLORS: Record<string, string> = { cn: '#b35c00', sea: '#1971c2', au: '#2b8a3e', done: '#5c677d' };
const GROUPS = [
  { id: 'cn', zh: '国内 · Longtree', en: 'China · Longtree', Icon: Factory },
  { id: 'sea', zh: '海运', en: 'Shipping', Icon: Ship },
  { id: 'au', zh: '澳洲工厂', en: 'AU factory', Icon: Warehouse },
  { id: 'done', zh: '已 GI', en: 'GI', Icon: PackageCheck },
] as const;

const fmt = (v?: string) => !v ? '' : /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(2, 4)}` : v;
const time = (v?: string) => v ? new Date(v).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const gridTheme = themeQuartz.withParams({
  fontFamily: '"Segoe UI", Inter, "Microsoft YaHei", sans-serif', fontSize: 12.5, headerFontSize: 12, headerFontWeight: 700,
  foregroundColor: '#1d2433', backgroundColor: '#fff', headerBackgroundColor: '#1f3352', headerTextColor: '#fff',
  borderColor: '#d9dee7', rowBorder: { color: '#e6e9ef', width: 1 }, columnBorder: { color: '#edf0f4', width: 1 },
  wrapperBorder: false, wrapperBorderRadius: 0, cellHorizontalPadding: 6, rowHoverColor: '#eef4ff', accentColor: '#2f5be0', headerColumnResizeHandleColor: '#5a7097',
});

export default function ProductionLineView({ zh, onOpenOrder }: { zh: boolean; onOpenOrder: (id: string) => void }) {
  const [data, setData] = useState<Payload | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [stage, setStage] = useState<string>(''), [group, setGroup] = useState<string>(''), [location, setLocation] = useState(''), [alert, setAlert] = useState('');
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
  const stages = data?.stages || [];
  const stageName = (id: string) => { const s = stages.find(x => x.id === id); return s ? (zh ? s.zh : s.en) : id; };
  const stageGroup = (id: string) => stages.find(x => x.id === id)?.group || 'cn';
  const rows = useMemo(() => (data?.rows || []).map(r => ({ ...r, stageName: stageName(r.stage), stageGroup: stageGroup(r.stage) })), [data, zh]);
  const dealers = useMemo(() => Array.from(new Set(rows.map(r => r.dealer).filter(Boolean))).sort(), [rows]);
  const alertCounts = useMemo(() => Object.fromEntries(ALERTS.map(a => [a.id, rows.filter(a.test).length])), [rows]);
  const locationCounts = useMemo(() => Object.fromEntries(LOCATIONS.map(l => [l, rows.filter(r => r.stage === 'auFactory' && r.au?.location === l).length])), [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[-\s]/g, '');
    const a = ALERTS.find(x => x.id === alert);
    return rows.filter(r => {
      if (q) return [r.chassis, r.model, r.customer, r.dealer, r.au?.station].some(v => String(v || '').toLowerCase().replace(/[-\s]/g, '').includes(q));
      if (stage && r.stage !== stage) return false;
      if (!stage && !group && r.stage === 'gi') return false; // GI'd vehicles only when asked for
      if (group && r.stageGroup !== group) return false;
      if (location && r.au?.location !== location) return false;
      if (a && !a.test(r)) return false;
      return !dealer || r.dealer === dealer;
    });
  }, [rows, query, stage, group, location, alert, dealer]);
  const pick = (next: { stage?: string; group?: string; location?: string; alert?: string }) => { setStage(next.stage ?? ''); setGroup(next.group ?? ''); setLocation(next.location ?? ''); setAlert(next.alert ?? ''); };

  const date = (field: string, label: string, get: (r: Row) => string | undefined, note?: (r: Row) => string | undefined): ColDef<Row> => ({
    colId: field, headerName: label, width: 84, valueGetter: p => p.data ? get(p.data) || note?.(p.data) || '' : '',
    valueFormatter: p => fmt(p.value), cellClass: p => (p.data && !get(p.data) && note?.(p.data) ? 'pl-note' : ''), tooltipValueGetter: p => (p.data && note?.(p.data)) || undefined,
  });
  const columns = useMemo<(ColDef<Row> | ColGroupDef<Row>)[]>(() => [
    { headerName: zh ? '车辆' : 'Vehicle', children: [
      { field: 'chassis', headerName: 'Chassis', pinned: 'left', width: 112, cellClass: 'chassis-cell', cellRenderer: (p: any) => <button className="chassis-link" onClick={() => setDetail(p.data)}>{p.value}</button> },
      { field: 'stageName', headerName: zh ? '当前阶段' : 'Stage', pinned: 'left', width: 112,
        cellRenderer: (p: any) => p.data ? <span className="pl-stage" style={{ background: STAGE_COLORS[p.data.stageGroup] }}>{p.value}</span> : null },
      { field: 'daysInStage', headerName: zh ? '本阶段天数' : 'Days in stage', pinned: 'left', width: 72, type: 'numericColumn', cellClass: p => ALERTS.some(a => p.data && a.test(p.data)) ? 'pl-late' : '' },
    ] },
    { headerName: zh ? '订单' : 'Order', children: [
      { field: 'model', headerName: zh ? '车型' : 'Model', width: 104 },
      { field: 'dealer', headerName: 'Dealer', width: 110 },
      { field: 'customer', headerName: zh ? '客户' : 'Customer', width: 120 },
    ] },
    { headerName: zh ? '国内 Longtree' : 'China · Longtree', children: [
      date('orderAt', zh ? '订单接收' : 'Order', r => r.cn?.orderAt),
      date('weldAt', zh ? '钣焊上线' : 'Welding', r => r.cn?.weldAt, r => r.cn?.notes?.weldAt),
      date('furnitureAt', zh ? '家具上线' : 'Furniture', r => r.cn?.furnitureAt),
      date('assemblyAt', zh ? '总装上线' : 'Assembly', r => r.cn?.assemblyAt, r => r.cn?.notes?.assemblyAt),
      date('finishedAt', zh ? '总装入库' : 'Finished', r => r.cn?.finishedAt, r => r.cn?.notes?.finishedAt),
      date('shippedAt', zh ? '发运' : 'Shipped', r => r.cn?.shippedAt, r => r.cn?.notes?.shippedAt),
    ] },
    { headerName: zh ? '海运' : 'Shipping', children: [
      date('etd', zh ? '预计离港' : 'ETD', r => r.sea?.etd), date('atd', zh ? '实际离港' : 'ATD', r => r.sea?.atd),
      date('eta', zh ? '预计到港' : 'ETA', r => r.sea?.eta), date('ata', zh ? '实际到港' : 'ATA', r => r.sea?.ata),
    ] },
    { headerName: zh ? '澳洲工厂' : 'AU factory', children: [
      date('grAt', 'GR', r => r.grAt),
      { colId: 'location', headerName: zh ? '库位' : 'Location', width: 92, valueGetter: p => p.data?.au?.location ? (zh ? LOCATION_ZH[p.data.au.location] || p.data.au.location : p.data.au.location) : '' },
      { colId: 'station', headerName: zh ? '工位' : 'Station', width: 118, valueGetter: p => p.data?.au?.station || '' },
      { colId: 'daysAtStation', headerName: zh ? '工位天数' : 'Days at station', width: 66, type: 'numericColumn', valueGetter: p => p.data?.au?.daysAtStation ?? null },
      { colId: 'flags', headerName: zh ? '标记' : 'Flags', width: 76, valueGetter: p => (p.data?.au?.flags || []).join(' '),
        cellRenderer: (p: any) => <span className="pl-flags">{(p.data?.au?.flags || []).map((f: string, i: number) => <i key={i} style={{ background: FLAG_COLORS[f]?.[0] || '#868e96', color: FLAG_COLORS[f]?.[1] || '#fff' }}>{f}</i>)}</span> },
      date('auForecast', zh ? '计划完工' : 'Planned', r => r.au?.forecastAt),
      { field: 'grToToday', headerName: zh ? 'GR 至今' : 'Since GR', width: 64, type: 'numericColumn' },
      date('giAt', 'GI', r => r.giAt),
    ] },
  ], [zh, stages]);

  async function exportCsv() {
    grid.current?.api.exportDataAsCsv({ fileName: `Production-line-${data?.today || ''}.csv`, processCellCallback: p => p.column.getColId() === 'chassis' ? p.value : p.value ?? '' });
  }
  const src = data?.sources || {};
  const srcLabel: Record<string, string> = { longtree: 'Longtree', prod: zh ? '澳洲生产' : 'AU production', portal: 'GR / GI' };
  const groupTotal = (g: string) => stages.filter(s => s.group === g).reduce((n, s) => n + (data?.counts[s.id] || 0), 0);

  return <section className="table-panel schedule-panel pl-panel">
    <div className="pl-stagebar">
      {GROUPS.map(({ id, zh: gz, en, Icon }) => <div key={id} className={`pl-group ${id}`}>
        <button className={`pl-group-head ${group === id ? 'on' : ''}`} onClick={() => pick(group === id ? {} : { group: id })}><Icon size={15} />{zh ? gz : en}<b>{groupTotal(id).toLocaleString()}</b></button>
        <div className="pl-stages">{stages.filter(s => s.group === id).map(s => <button key={s.id} className={`pl-stage-card ${stage === s.id ? 'on' : ''}`} onClick={() => pick(stage === s.id ? {} : { stage: s.id })} title={s.id === 'gi' ? (zh ? '表格只列近 14 天 GI 的车' : 'Only vehicles GI’d in the last 14 days are listed') : ''}>
          <b>{(data?.counts[s.id] ?? 0).toLocaleString()}</b><span>{zh ? s.zh : s.en}</span></button>)}</div>
      </div>)}
    </div>
    <div className="schedule-toolbar">
      <div className="chips">
        {ALERTS.map(a => <button key={a.id} className={`chip ${alert === a.id ? 'on' : ''}`} onClick={() => pick(alert === a.id ? {} : { alert: a.id })}><i style={{ background: alertCounts[a.id] ? '#ffe3e3' : '#f1f3f5', color: alertCounts[a.id] ? '#c92a2a' : '#868e96' }}>{alertCounts[a.id] ?? 0}</i>{zh ? a.zh : a.en}</button>)}
      </div>
      <label className="search"><Search size={16} /><input placeholder={zh ? '搜索车架号、车型、客户、工位' : 'Search chassis, model, customer, station'} value={query} onChange={e => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')}><X size={14} /></button>}</label>
      <label className="dealer-filter"><ListFilter size={16} /><select value={dealer} onChange={e => setDealer(e.target.value)}><option value="">{zh ? '全部经销商' : 'All dealers'}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label>
      <span className="count-chip">{visible.length.toLocaleString()} {zh ? '台' : 'vehicles'}</span>
    </div>
    {(stage === 'auFactory' || group === 'au' || location) && <div className="pl-locations">
      <span>{zh ? '库位' : 'Location'}</span>
      {LOCATIONS.map(l => <button key={l} className={`day-chip ${location === l ? 'on' : ''}`} onClick={() => pick(location === l ? { stage: 'auFactory' } : { stage: 'auFactory', location: l })}><b>{locationCounts[l]}</b>{zh ? LOCATION_ZH[l] : l}</button>)}
    </div>}
    <div className="pl-sources">
      {Object.entries(srcLabel).map(([k, l]) => <span key={k} className={src[k]?.error ? 'bad' : 'ok'} title={src[k]?.error || ''}>{l} · {src[k]?.error === 'not configured' ? (zh ? '未配置' : 'not configured') : src[k]?.error ? (zh ? '读取失败，显示上次数据' : 'failed, showing last copy') : `${(src[k]?.count || 0).toLocaleString()} ${zh ? '台' : ''} · ${time(src[k]?.at)}`}</span>)}
      <span className="muted">{zh ? `未签字 ${data?.unsigned ?? 0} 台不在产线；只读，不修改任何来源` : `${data?.unsigned ?? 0} unsigned orders not shown; read-only`}</span>
      <button className="pl-export" onClick={() => void exportCsv()} disabled={!visible.length}><ArrowDownToLine size={14} />{zh ? '导出 CSV' : 'Export CSV'}</button>
      <button aria-label={zh ? '刷新' : 'Refresh'} className={busy || data?.refreshing ? 'icon-button spinning' : 'icon-button'} disabled={busy} onClick={() => void load(true)}><RefreshCw size={15} /></button>
    </div>
    {error && <div className="message error compact-msg"><AlertTriangle size={16} />{error}</div>}
    {!data && !error && <div className="pl-loading">{zh ? '正在读取 Longtree、澳洲生产系统和 GR/GI…第一次大约需要 30–40 秒' : 'Loading Longtree, AU production and GR/GI… the first load takes ~30–40 s'}</div>}
    <div className="schedule-grid">
      <AgGridReact<Row> ref={grid} theme={gridTheme} rowData={visible} columnDefs={columns} getRowId={p => p.data.id}
        defaultColDef={{ resizable: true, sortable: true, suppressMovable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        rowHeight={26} headerHeight={34} groupHeaderHeight={24} tooltipShowDelay={250} enableCellTextSelection
        onRowDoubleClicked={e => e.data && setDetail(e.data)}
        overlayNoRowsTemplate={`<span style="color:#61718a">${zh ? '没有符合条件的车' : 'No matching vehicles'}</span>`} />
    </div>
    {detail && <aside className="pl-detail" role="dialog" aria-label={detail.chassis}>
      <header><div><strong>{detail.chassis}</strong><span>{detail.model} · {detail.dealer} · {detail.customer}</span></div><button className="icon-button" aria-label={zh ? '关闭' : 'Close'} onClick={() => setDetail(null)}><X size={16} /></button></header>
      <ol className="pl-timeline">
        {([[zh ? '订单接收' : 'Order', detail.cn?.orderAt], [zh ? '钣焊上线' : 'Welding', detail.cn?.weldAt], [zh ? '家具上线' : 'Furniture', detail.cn?.furnitureAt], [zh ? '总装上线' : 'Assembly', detail.cn?.assemblyAt], [zh ? '总装入库' : 'Finished', detail.cn?.finishedAt], [zh ? '发运' : 'Shipped', detail.cn?.shippedAt], [zh ? '实际离港' : 'ATD', detail.sea?.atd], [zh ? '实际到港' : 'ATA', detail.sea?.ata], ['GR', detail.grAt], ['GI', detail.giAt]] as [string, string | undefined][])
          .map(([l, v]) => <li key={l} className={v ? 'done' : ''}><span>{l}</span><b>{fmt(v) || '—'}</b></li>)}
      </ol>
      {detail.au && <><h4>{zh ? '澳洲工厂工位记录' : 'AU station history'}</h4><ul className="pl-history">{detail.au.history.length ? detail.au.history.map((h, i) => <li key={i}><span>{time(h.at)}</span><b>{h.stage}</b><em>{h.location}</em></li>) : <li><b>{detail.au.station}</b><em>{detail.au.location}</em></li>}</ul></>}
      {Object.keys(detail.cn?.notes || {}).length > 0 && <p className="pl-notes">{Object.values(detail.cn!.notes).join(' · ')}</p>}
      <Button variant="outline" className="action slim" onClick={() => onOpenOrder(detail.id)}>{zh ? '打开订单' : 'Open order'}</Button>
    </aside>}
  </section>;
}
