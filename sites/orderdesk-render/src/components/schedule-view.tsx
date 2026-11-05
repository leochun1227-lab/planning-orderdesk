import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, type ColDef, type CellStyle } from 'ag-grid-community';
import { ArrowDownToLine, Search, X, ListFilter, CalendarRange, Clock3, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dealerColor } from '@/lib/schedule-colors.mjs';
import { FIELD_LABELS, isOverdue } from '@/lib/order-engine.mjs';
import { ALERTS, type AlertKey, type ScheduleRow, type Order } from './schedule-model';

type Chip = AlertKey | 'due' | 'overdue' | 'pending';
type Day = 'all' | 'new' | 'changed' | 'cancelled';
export type ScheduleFilter = { alert: Chip | null; scope: 'open' | 'all' | 'slots' | 'campervan'; dealer: string; query: string; day: Day | null };
export const defaultScheduleFilter: ScheduleFilter = { alert: null, scope: 'open', dealer: '', query: '', day: null };

const fmt = (v: any) => !v ? '' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : String(v);
const gridTheme = themeQuartz.withParams({
  fontFamily: '"Segoe UI", Inter, "Microsoft YaHei", sans-serif', fontSize: 12.5, headerFontSize: 12, headerFontWeight: 700,
  foregroundColor: '#1d2433', backgroundColor: '#fff', headerBackgroundColor: '#1f3352', headerTextColor: '#fff',
  borderColor: '#d9dee7', rowBorder: { color: '#e6e9ef', width: 1 }, columnBorder: { color: '#edf0f4', width: 1 },
  wrapperBorder: false, wrapperBorderRadius: 0, cellHorizontalPadding: 6, rowHoverColor: '#eef4ff', selectedRowBackgroundColor: '#e3edff', accentColor: '#2f5be0',
  headerColumnResizeHandleColor: '#5a7097',
});
const DATE_FIELDS = ['requestDate', 'receivedAt', 'sentLongtreeAt', 'specAt', 'signedAt', 'purchaseAt'];

export default function ScheduleView({ rows, extras, zh, filter, setFilter, onOpen, counts, date, setDate, today, dayEvents, reportDate, busy, onRefresh, campervanSource }: {
  rows: ScheduleRow[]; extras: ScheduleRow[]; zh: boolean; filter: ScheduleFilter; setFilter: (f: ScheduleFilter) => void; onOpen: (o: Order) => void;
  counts: Record<string, number>; date: string; setDate: (d: string) => void; today: string; dayEvents: any[]; reportDate?: string; busy: boolean; onRefresh: () => void;
  campervanSource?: string | null;
}) {
  const grid = useRef<AgGridReact<ScheduleRow>>(null);
  const [exporting, setExporting] = useState(false), [error, setError] = useState('');
  const dealers = useMemo(() => Array.from(new Set([...rows, ...extras].map(r => r.dealer).filter(Boolean))).sort() as string[], [rows, extras]);

  // Changes on the selected day, per order (same events the old overview counted).
  const day = useMemo(() => {
    const by = new Map<string, any[]>(), ids: Record<Day, Set<string>> = { all: new Set(), new: new Set(), changed: new Set(), cancelled: new Set() };
    for (const e of dayEvents) { (by.get(e.orderId) ?? by.set(e.orderId, []).get(e.orderId)!).push(e); ids.all.add(e.orderId); ids[e.type as Day]?.add(e.orderId); }
    return { by, ids };
  }, [dayEvents]);
  const camperCount = useMemo(() => extras.filter(r => r.kind === 'campervan' && r.order?.status === 'active').length, [extras]);

  const visible = useMemo(() => {
    const q = filter.query.toLowerCase().replace(/-/g, '');
    const all = [...rows, ...extras];
    let list: ScheduleRow[];
    const matches = (r: ScheduleRow) => { const o = r.order; return !!o && [o.chassis, o.customer, o.crmCustomer, o.model].some(v => String(v || '').toLowerCase().replace(/-/g, '').includes(q)); };
    // A search always looks through every vehicle (Orderlist rows, campervans, not placed, cancelled).
    if (q) list = all.filter(matches);
    else if (filter.day) list = all.filter(r => r.order && day.ids[filter.day!].has(r.order.id));
    else if (filter.alert === 'overdue') list = all.filter(r => r.order && isOverdue(r.order, today));
    else if (filter.alert === 'pending') list = extras.filter(r => r.kind === 'pending');
    else if (filter.scope === 'campervan') list = extras.filter(r => r.kind === 'campervan' && r.order?.status === 'active');
    else {
      // "Open" starts at the first row that is not Finished, like scrolling past the finished block in Excel.
      const firstOpen = rows.findIndex(r => !r.finished);
      list = rows.filter((r, i) => filter.scope === 'all' || (filter.scope === 'slots' ? !r.order : i >= firstOpen && !r.finished));
      if (filter.alert) list = list.filter(r => filter.alert === 'due' ? r.due : r.alert === filter.alert || (filter.alert === 'grey' && r.alert === 'greyNoRequest'));
    }
    return list.filter(r => {
      if (filter.dealer && r.dealer !== filter.dealer) return false;
      return true;
    });
  }, [rows, extras, filter, day, today]);

  const dueStyle = (p: any, field?: string) => (p.data?.due && (!field || DATE_FIELDS.includes(field)) ? { background: '#FFFF00', fontWeight: 700 } : null) as CellStyle | null;
  const dateCol = (field: string, header: string, width = 92, milestone = false): ColDef<ScheduleRow> => ({
    headerName: header, colId: field, width,
    valueGetter: p => { const o = p.data?.order; if (!o) return ''; const v = o[field]; return milestone && !v ? 'No' : v ?? ''; },
    valueFormatter: p => fmt(p.value), cellClass: p => (p.value === 'No' ? 'xl-no' : ''), cellStyle: p => dueStyle(p, field),
  });
  const typeLabel = (t: string) => (zh ? { new: '新订单', changed: '变更', cancelled: '取消' } : { new: 'New', changed: 'Changed', cancelled: 'Cancelled' } as any)[t] || t;
  const kindLabel = (k?: string) => (zh ? { campervan: 'Campervan', pending: '待排位', cancelled: '已取消', other: '不在排产表' } : { campervan: 'Campervan', pending: 'Not placed', cancelled: 'Cancelled', other: 'Not in schedule' } as any)[k || ''] || '';
  const columns = useMemo<ColDef<ScheduleRow>[]>(() => [
    { headerName: '#', colId: 'row', width: 62, pinned: 'left', cellClass: 'xl-rownum', valueGetter: p => p.data?.excelRow || '',
      cellRenderer: (p: any) => p.data?.kind ? <span className={`row-kind ${p.data.kind}`}>{kindLabel(p.data.kind)}</span> : p.value },
    { headerName: zh ? '预计生产' : 'Forecast Production Date', field: 'forecastDate', width: 98, pinned: 'left', valueFormatter: p => p.value ? fmt(p.value) : (p.data?.kind === 'campervan' ? (zh ? 'Portal 待排' : 'Portal TBD') : ''),
      cellStyle: p => { const a = p.data?.alert ? ALERTS[p.data.alert] : null; return (a ? { background: a.bg, color: a.fg, fontWeight: 700 } : p.data?.kind === 'campervan' ? { color: '#5f3dc4', fontWeight: 700 } : { fontWeight: 600 }) as CellStyle; },
      tooltipValueGetter: p => (p.data?.alert ? ALERTS[p.data.alert][zh ? 'zh' : 'en'] : p.data?.kind === 'campervan' ? (zh ? 'Dealer Portal 澳洲计划上线（只读）' : 'Dealer Portal AU planned start (read-only)') : '') },
    { headerName: zh ? '车架号' : 'Chassis', colId: 'chassis', width: 118, pinned: 'left', valueGetter: p => p.data?.order?.chassis || '',
      cellRenderer: (p: any) => p.data?.order ? <button className={`xl-link ${p.data.order.status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => onOpen(p.data.order)}>{p.value}</button> : <span className="xl-slot">{zh ? '空位' : 'Empty slot'}</span> },
    { headerName: zh ? '当日变化' : 'Change', colId: 'change', width: 220, hide: !filter.day,
      valueGetter: p => { const es = p.data?.order ? day.by.get(p.data.order.id) || [] : []; return es.map(e => typeLabel(e.type) + (e.changes?.length && e.type === 'changed' ? ': ' + e.changes.map((c: any) => (FIELD_LABELS as any)[c.field] || c.field).join('、') : '')).join('；'); },
      cellClass: p => { const es = p.data?.order ? day.by.get(p.data.order.id) || [] : []; return es.some(e => e.type === 'cancelled') ? 'chg chg-cancelled' : es.some(e => e.type === 'new') ? 'chg chg-new' : 'chg chg-changed'; } },
    { headerName: zh ? '经销商' : 'Dealer', field: 'dealer', width: 118, cellStyle: p => (dealerColor(p.value) || {}) as CellStyle },
    { headerName: zh ? '客户' : 'Customer', colId: 'customer', width: 190, valueGetter: p => p.data?.order?.customer || '', cellStyle: p => dueStyle(p),
      cellRenderer: (p: any) => { const o = p.data?.order; if (!o) return ''; const raw = o.crmCustomer; return o.customer === 'Stock' && raw ? <span className="xl-stock">Stock<small title={zh ? 'CRM 原始客户名' : 'Original CRM customer'}>{raw}</small></span> : (o.customer || ''); },
      tooltipValueGetter: p => p.data?.order?.crmCustomer ? `CRM: ${p.data.order.crmCustomer}` : '' },
    { headerName: zh ? '车型' : 'Model', colId: 'model', width: 82, valueGetter: p => p.data?.order?.model || '' },
    { headerName: zh ? '年款' : 'MY', colId: 'modelYear', width: 58, valueGetter: p => p.data?.order?.modelYear || '', cellStyle: p => dueStyle(p) },
    { ...dateCol('requestDate', zh ? '需求交付' : 'Request Delivery', 96), cellStyle: p => (p.data?.mismatch ? { background: '#BD340F', color: '#fff' } : dueStyle(p, 'requestDate')) as CellStyle | null },
    { headerName: zh ? 'Regent 生产' : 'Regent Production', colId: 'productionStatus', width: 150, valueGetter: p => p.data?.order?.productionStatus || '', cellClass: p => (p.value === 'Finished' ? 'xl-finished' : '') },
    { headerName: zh ? '签字等待' : 'Waiting', colId: 'waiting', width: 78, valueGetter: p => { const o = p.data?.order; if (!o?.specAt || o.signedAt) return null; return Math.max(0, Math.round((Date.parse(today) - Date.parse(o.specAt)) / 86400000)); },
      valueFormatter: p => p.value == null ? '' : `${p.value} ${zh ? '天' : 'd'}`, cellStyle: p => (p.data?.order && isOverdue(p.data.order, today) ? { background: '#d9480f', color: '#fff', fontWeight: 700 } : null) as CellStyle | null },
    dateCol('receivedAt', zh ? '收到订单' : 'Order Received'),
    dateCol('sentLongtreeAt', zh ? '发 Longtree' : 'Sent to Longtree'),
    dateCol('specAt', zh ? '图纸发经销商' : 'Plans Sent', 96, true),
    dateCol('signedAt', zh ? '收到签字图' : 'Signed Plans', 96, true),
    dateCol('purchaseAt', zh ? 'PO 已发' : 'PO Sent', 92, true),
    { headerName: zh ? '船运' : 'Shipment', colId: 'shipment', width: 170, valueGetter: p => p.data?.order?.shipment || '' },
    { headerName: zh ? '排程状态' : 'Schedule Status', colId: 'vinNumber', width: 180, valueGetter: p => p.data?.order?.vinNumber || '' },
    { headerName: 'Price Date', colId: 'priceVersion', width: 78, valueGetter: p => p.data?.order?.priceVersion || '' },
    { headerName: zh ? '预计半成品到货' : 'Est. Semi Received', colId: 'estimatedSemiReceivedAt', width: 110, valueGetter: p => { const v = p.data?.order?.estimatedSemiReceivedAt; return v && v !== 'null' ? v : ''; } },
  ], [zh, onOpen, filter.day, day, today]);

  async function exportExcel() {
    setExporting(true); setError('');
    try {
      const ids: string[] = []; grid.current?.api?.forEachNodeAfterFilterAndSort(n => { if (n.data) ids.push(n.data.id); });
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!r.ok) throw new Error(((await r.json()) as any).error || 'Export failed');
      const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = `Planning-Schedule-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); } finally { setExporting(false); }
  }

  const chips: [Chip, string, string, string, string][] = [
    ['overdue', '#d9480f', '#fff', zh ? '签字逾期' : 'Signature overdue', zh ? '发图满 5 天未签字' : 'Plans sent ≥5 days, unsigned'],
    ['red', ALERTS.red.bg, ALERTS.red.fg, zh ? '空位未填' : 'Empty slot', ALERTS.red[zh ? 'zh' : 'en']],
    ['yellow', ALERTS.yellow.bg, ALERTS.yellow.fg, zh ? '图纸未发' : 'Plans not sent', ALERTS.yellow[zh ? 'zh' : 'en']],
    ['lightBlue', ALERTS.lightBlue.bg, ALERTS.lightBlue.fg, zh ? '等签字' : 'Awaiting signature', ALERTS.lightBlue[zh ? 'zh' : 'en']],
    ['grey', ALERTS.grey.bg, ALERTS.grey.fg, zh ? '已签未发 PO' : 'Signed, no PO', ALERTS.grey[zh ? 'zh' : 'en']],
    ['due', '#FFFF00', '#000', zh ? '110 天内未签字' : 'Due ≤110d, unsigned', zh ? '预计生产 110 天内、有交付日期、还没签字' : 'Production within 110 days, has request date, unsigned'],
    ['pending', '#5b4bd1', '#fff', zh ? '待排位' : 'Not placed', zh ? '经销商没有空位 / 不在排产表' : 'No dealer slot / not in schedule'],
  ];
  const chipCount = (k: Chip) => k === 'grey' ? (counts.grey || 0) + (counts.greyNoRequest || 0) : k === 'due' ? rows.filter(r => r.due).length : counts[k] ?? 0;
  const set = (p: Partial<ScheduleFilter>) => setFilter({ ...filter, ...p });
  const dayChips: [Day, string][] = [['all', zh ? '当日全部变化' : 'All changes'], ['new', zh ? '新订单' : 'New'], ['changed', zh ? '订单变化' : 'Changed'], ['cancelled', zh ? '取消' : 'Cancelled']];

  return <section className="table-panel schedule-panel">
    <div className="schedule-daybar">
      <label className="day-date"><Clock3 size={15} /><input type="date" max={today} value={date} onChange={e => setDate(e.target.value || today)} aria-label={zh ? '查看日期' : 'Date'} />{date === today && <span className="today-tag">{zh ? '今天' : 'Today'}</span>}</label>
      <div className="day-chips">{dayChips.map(([k, l]) => <button key={k} className={`day-chip ${k} ${filter.day === k ? 'on' : ''} ${day.ids[k].size ? '' : 'zero'}`} onClick={() => set({ day: filter.day === k ? null : k, alert: null })}><b>{day.ids[k].size}</b>{l}</button>)}</div>
      <span className="report-stamp small">{zh ? '最新报告' : 'Latest report'} <strong>{fmt(reportDate) || '—'}</strong><button aria-label={zh ? '刷新' : 'Refresh'} className={busy ? 'icon-button spinning' : 'icon-button'} disabled={busy} onClick={onRefresh}><RefreshCw size={15} /></button></span>
    </div>
    <div className="schedule-toolbar">
      <div className="seg" role="group">
        {([['open', zh ? '在排' : 'Open'], ['all', zh ? '全部行' : 'All rows'], ['slots', zh ? '仅空位' : 'Empty slots'], ['campervan', `Campervan ${camperCount}`]] as const).map(([k, l]) => <button key={k} aria-pressed={!filter.day && filter.alert !== 'overdue' && filter.alert !== 'pending' && filter.scope === k} onClick={() => set({ scope: k, day: null, alert: filter.alert === 'overdue' || filter.alert === 'pending' ? null : filter.alert })}>{l}</button>)}
      </div>
      <div className="chips">
        {chips.map(([k, bg, fg, label, tip]) => <button key={k} className={`chip ${filter.alert === k && !filter.day ? 'on' : ''}`} title={tip} onClick={() => set({ alert: filter.alert === k ? null : k, day: null })}>
          <i style={{ background: bg, color: fg }}>{chipCount(k)}</i>{label}</button>)}
      </div>
      <label className="search"><Search size={16} /><input placeholder={zh ? '搜索车架号、客户、车型' : 'Search chassis, customer, model'} value={filter.query} onChange={e => set({ query: e.target.value })} />{filter.query && <button onClick={() => set({ query: '' })}><X size={14} /></button>}</label>
      <label className="dealer-filter"><ListFilter size={16} /><select value={filter.dealer} onChange={e => set({ dealer: e.target.value })}><option value="">{zh ? '全部经销商' : 'All dealers'}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label>
      <span className="count-chip"><CalendarRange size={14} /> {visible.length.toLocaleString()} {zh ? '行' : 'rows'}</span>
      <Button variant="outline" className="action slim" disabled={exporting} onClick={() => void exportExcel()}><ArrowDownToLine size={16} />{exporting ? (zh ? '导出中' : 'Exporting') : (zh ? '导出 Excel' : 'Export Excel')}</Button>
    </div>
    {(filter.query || filter.day || filter.alert === 'overdue' || filter.alert === 'pending' || filter.scope === 'campervan') && <div className="filter-note">
      {filter.query ? (zh ? `在全部车里搜索「${filter.query}」：包括 Orderlist、Campervan、待排位和已取消的车。` : `Searching all vehicles for "${filter.query}" (Orderlist, campervans, not placed, cancelled).`)
        : filter.day ? (zh ? `${fmt(date)} 的变化，包括取消和 Campervan 订单。` : `Changes on ${fmt(date)}, including cancelled and campervan orders.`)
        : filter.scope === 'campervan' && !filter.alert ? (zh ? `SRV / SRM 不占 Orderlist 空位；预计生产为 Dealer Portal 的澳洲计划上线${campervanSource ? `（${campervanSource}）` : ''}。` : 'SRV / SRM do not use Orderlist slots; dates are the Dealer Portal AU planned start.')
        : filter.alert === 'overdue' ? (zh ? '所有发图满 5 天仍未签字的车（含 Campervan）。' : 'All orders with plans sent ≥5 days and unsigned (incl. campervans).')
        : (zh ? '经销商没有空位、或不在排产表里的在排订单。' : 'Active orders without a dealer slot / not in the schedule.')}
      <button onClick={() => set({ day: null, alert: null, scope: 'open', query: '' })}>{zh ? '回到在排' : 'Back to open'}</button></div>}
    {error && <div className="message error compact-msg">{error}</div>}
    <div className="schedule-grid">
      <AgGridReact<ScheduleRow> ref={grid} theme={gridTheme} rowData={visible} columnDefs={columns} getRowId={p => p.data.id}
        defaultColDef={{ resizable: true, sortable: false, suppressMovable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        rowHeight={26} headerHeight={34} tooltipShowDelay={250}
        getRowClass={p => [p.data?.weekStart && !filter.day ? 'week-start' : '', p.data?.order ? '' : 'slot-row', p.data?.finished ? 'finished-row' : '', p.data?.order?.status === 'cancelled' ? 'cancelled-row' : ''].join(' ')}
        onRowDoubleClicked={e => e.data?.order && onOpen(e.data.order)}
        overlayNoRowsTemplate={`<span style="color:#61718a">${zh ? '没有符合条件的行' : 'No matching rows'}</span>`} />
    </div>
  </section>;
}
