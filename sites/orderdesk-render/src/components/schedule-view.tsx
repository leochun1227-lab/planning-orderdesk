import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, type ColDef, type CellStyle } from 'ag-grid-community';
import { ArrowDownToLine, Search, X, ListFilter, CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dealerColor } from '@/lib/schedule-colors.mjs';
import { ALERTS, type AlertKey, type ScheduleRow, type Order } from './schedule-model';

export type ScheduleFilter = { alert: AlertKey | 'due' | null; scope: 'open' | 'all' | 'slots'; dealer: string; query: string };
export const defaultScheduleFilter: ScheduleFilter = { alert: null, scope: 'open', dealer: '', query: '' };

const fmt = (v: any) => !v ? '' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : String(v);
const gridTheme = themeQuartz.withParams({
  fontFamily: '"Segoe UI", Inter, "Microsoft YaHei", sans-serif', fontSize: 12.5, headerFontSize: 12, headerFontWeight: 700,
  foregroundColor: '#1d2433', backgroundColor: '#fff', headerBackgroundColor: '#1f3352', headerTextColor: '#fff',
  borderColor: '#d9dee7', rowBorder: { color: '#e6e9ef', width: 1 }, columnBorder: { color: '#edf0f4', width: 1 },
  wrapperBorder: false, wrapperBorderRadius: 0, cellHorizontalPadding: 6, rowHoverColor: '#eef4ff', selectedRowBackgroundColor: '#e3edff', accentColor: '#2f5be0',
  headerColumnResizeHandleColor: '#5a7097',
});

export default function ScheduleView({ rows, zh, filter, setFilter, onOpen, counts }: {
  rows: ScheduleRow[]; zh: boolean; filter: ScheduleFilter; setFilter: (f: ScheduleFilter) => void; onOpen: (o: Order) => void; counts: Record<string, number>;
}) {
  const grid = useRef<AgGridReact<ScheduleRow>>(null);
  const [exporting, setExporting] = useState(false), [error, setError] = useState('');
  const dealers = useMemo(() => Array.from(new Set(rows.map(r => r.dealer).filter(Boolean))).sort() as string[], [rows]);
  const visible = useMemo(() => {
    const q = filter.query.toLowerCase().replace(/-/g, '');
    // "open" starts at the first row that is not Finished, like scrolling past the finished block in Excel.
    const firstOpen = rows.findIndex(r => !r.finished);
    return rows.filter((r, i) => {
      if (filter.scope === 'open' && (i < firstOpen || r.finished)) return false;
      if (filter.scope === 'slots' && r.order) return false;
      if (filter.dealer && r.dealer !== filter.dealer) return false;
      if (filter.alert === 'due' ? !r.due : filter.alert && r.alert !== filter.alert && !(filter.alert === 'grey' && r.alert === 'greyNoRequest')) return false;
      if (q) { const o = r.order; if (!o) return false; if (![o.chassis, o.customer, o.crmCustomer, o.model].some(v => String(v || '').toLowerCase().replace(/-/g, '').includes(q))) return false; }
      return true;
    });
  }, [rows, filter]);

  const dateCol = (field: string, header: string, width = 92, milestone = false): ColDef<ScheduleRow> => ({
    headerName: header, colId: field, width,
    valueGetter: p => { const o = p.data?.order; if (!o) return ''; const v = o[field]; return milestone && !v ? 'No' : v ?? ''; },
    valueFormatter: p => fmt(p.value),
    cellClass: p => (p.value === 'No' ? 'xl-no' : ''),
    cellStyle: p => (p.data?.due && ['requestDate', 'receivedAt', 'sentLongtreeAt', 'specAt', 'signedAt', 'purchaseAt'].includes(field) ? { background: '#FFFF00', fontWeight: 700 } : null) as CellStyle | null,
  });
  const columns = useMemo<ColDef<ScheduleRow>[]>(() => [
    { headerName: '#', field: 'excelRow', width: 62, pinned: 'left', cellClass: 'xl-rownum', sortable: false },
    { headerName: zh ? '预计生产' : 'Forecast Production Date', field: 'forecastDate', width: 98, pinned: 'left', valueFormatter: p => fmt(p.value),
      cellStyle: p => { const a = p.data?.alert ? ALERTS[p.data.alert] : null; return (a ? { background: a.bg, color: a.fg, fontWeight: 700 } : { fontWeight: 600 }) as CellStyle; },
      tooltipValueGetter: p => (p.data?.alert ? ALERTS[p.data.alert][zh ? 'zh' : 'en'] : '') },
    { headerName: zh ? '车架号' : 'Chassis', colId: 'chassis', width: 112, pinned: 'left', valueGetter: p => p.data?.order?.chassis || '',
      cellRenderer: (p: any) => p.data?.order ? <button className="xl-link" onClick={() => onOpen(p.data.order)}>{p.value}</button> : <span className="xl-slot">{zh ? '空位' : 'Empty slot'}</span> },
    { headerName: zh ? '经销商' : 'Dealer', field: 'dealer', width: 118, cellStyle: p => (dealerColor(p.value) || {}) as CellStyle },
    { headerName: zh ? '客户' : 'Customer', colId: 'customer', width: 190, valueGetter: p => p.data?.order?.customer || '',
      cellStyle: p => (p.data?.due ? { background: '#FFFF00', fontWeight: 700 } : null) as CellStyle | null,
      cellRenderer: (p: any) => { const o = p.data?.order; if (!o) return ''; const raw = o.crmCustomer; return o.customer === 'Stock' && raw ? <span className="xl-stock">Stock<small title={zh ? 'CRM 原始客户名' : 'Original CRM customer'}>{raw}</small></span> : (o.customer || ''); },
      tooltipValueGetter: p => p.data?.order?.crmCustomer ? `CRM: ${p.data.order.crmCustomer}` : '' },
    { headerName: zh ? '车型' : 'Model', colId: 'model', width: 82, valueGetter: p => p.data?.order?.model || '' },
    { headerName: zh ? '年款' : 'MY', colId: 'modelYear', width: 58, valueGetter: p => p.data?.order?.modelYear || '',
      cellStyle: p => (p.data?.due ? { background: '#FFFF00', fontWeight: 700 } : null) as CellStyle | null },
    { ...dateCol('requestDate', zh ? '需求交付' : 'Request Delivery', 96),
      cellStyle: p => (p.data?.mismatch ? { background: '#BD340F', color: '#fff' } : p.data?.due ? { background: '#FFFF00', fontWeight: 700 } : null) as CellStyle | null },
    { headerName: zh ? 'Regent 生产' : 'Regent Production', colId: 'productionStatus', width: 150, valueGetter: p => p.data?.order?.productionStatus || '', cellClass: p => (p.value === 'Finished' ? 'xl-finished' : '') },
    dateCol('receivedAt', zh ? '收到订单' : 'Order Received'),
    dateCol('sentLongtreeAt', zh ? '发 Longtree' : 'Sent to Longtree'),
    dateCol('specAt', zh ? '图纸发经销商' : 'Plans Sent', 96, true),
    dateCol('signedAt', zh ? '收到签字图' : 'Signed Plans', 96, true),
    dateCol('purchaseAt', zh ? 'PO 已发' : 'PO Sent', 92, true),
    { headerName: zh ? '船运' : 'Shipment', colId: 'shipment', width: 170, valueGetter: p => p.data?.order?.shipment || '' },
    { headerName: zh ? '排程状态' : 'Schedule Status', colId: 'vinNumber', width: 180, valueGetter: p => p.data?.order?.vinNumber || '' },
    { headerName: 'Price Date', colId: 'priceVersion', width: 78, valueGetter: p => p.data?.order?.priceVersion || '' },
    { headerName: zh ? '预计半成品到货' : 'Est. Semi Received', colId: 'estimatedSemiReceivedAt', width: 110, valueGetter: p => { const v = p.data?.order?.estimatedSemiReceivedAt; return v && v !== 'null' ? v : ''; } },
  ], [zh, onOpen]);

  async function exportExcel() {
    setExporting(true); setError('');
    try {
      const ids: string[] = []; grid.current?.api?.forEachNodeAfterFilterAndSort(n => { if (n.data) ids.push(n.data.id); });
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!r.ok) throw new Error(((await r.json()) as any).error || 'Export failed');
      const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = `Planning-Schedule-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); } finally { setExporting(false); }
  }

  const chips: [AlertKey | 'due', string, string, string][] = [
    ['red', ALERTS.red.bg, ALERTS.red.fg, zh ? '空位未填' : 'Empty slot'],
    ['yellow', ALERTS.yellow.bg, ALERTS.yellow.fg, zh ? '图纸未发' : 'Plans not sent'],
    ['lightBlue', ALERTS.lightBlue.bg, ALERTS.lightBlue.fg, zh ? '等签字' : 'Awaiting signature'],
    ['grey', ALERTS.grey.bg, ALERTS.grey.fg, zh ? '已签未发 PO' : 'Signed, no PO'],
    ['due', '#FFFF00', '#000', zh ? '110 天内未签字' : 'Due ≤110d, unsigned'],
  ];
  const set = (p: Partial<ScheduleFilter>) => setFilter({ ...filter, ...p });
  return <section className="table-panel schedule-panel">
    <div className="schedule-toolbar">
      <div className="seg" role="group">
        {([['open', zh ? '在排' : 'Open'], ['all', zh ? '全部行' : 'All rows'], ['slots', zh ? '仅空位' : 'Empty slots']] as const).map(([k, l]) => <button key={k} aria-pressed={filter.scope === k} onClick={() => set({ scope: k })}>{l}</button>)}
      </div>
      <div className="chips">
        {chips.map(([k, bg, fg, label]) => <button key={k} className={`chip ${filter.alert === k ? 'on' : ''}`} onClick={() => set({ alert: filter.alert === k ? null : k })} title={k === 'due' ? '' : ALERTS[k as AlertKey][zh ? 'zh' : 'en']}>
          <i style={{ background: bg, color: fg }}>{k === 'grey' ? (counts.grey || 0) + (counts.greyNoRequest || 0) : counts[k] ?? '·'}</i>{label}</button>)}
      </div>
      <label className="search"><Search size={16} /><input placeholder={zh ? '搜索车架号、客户、车型' : 'Search chassis, customer, model'} value={filter.query} onChange={e => set({ query: e.target.value })} />{filter.query && <button onClick={() => set({ query: '' })}><X size={14} /></button>}</label>
      <label className="dealer-filter"><ListFilter size={16} /><select value={filter.dealer} onChange={e => set({ dealer: e.target.value })}><option value="">{zh ? '全部经销商' : 'All dealers'}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label>
      <span className="count-chip"><CalendarRange size={14} /> {visible.length.toLocaleString()} {zh ? '行' : 'rows'}</span>
      <Button variant="outline" className="action slim" disabled={exporting} onClick={() => void exportExcel()}><ArrowDownToLine size={16} />{exporting ? (zh ? '导出中' : 'Exporting') : (zh ? '导出 Excel' : 'Export Excel')}</Button>
    </div>
    {error && <div className="message error compact-msg">{error}</div>}
    <div className="schedule-grid">
      <AgGridReact<ScheduleRow> ref={grid} theme={gridTheme} rowData={visible} columnDefs={columns} getRowId={p => p.data.id}
        defaultColDef={{ resizable: true, sortable: false, suppressMovable: true, wrapHeaderText: true, autoHeaderHeight: true }}
        rowHeight={26} headerHeight={34} tooltipShowDelay={250}
        getRowClass={p => [p.data?.weekStart ? 'week-start' : '', p.data?.order ? '' : 'slot-row', p.data?.finished ? 'finished-row' : ''].join(' ')}
        onRowDoubleClicked={e => e.data?.order && onOpen(e.data.order)}
        overlayNoRowsTemplate={`<span style="color:#61718a">${zh ? '没有符合条件的行' : 'No matching rows'}</span>`} />
    </div>
  </section>;
}
