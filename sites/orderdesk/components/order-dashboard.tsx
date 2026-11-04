'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Clock3, FileSpreadsheet, History, LayoutDashboard, ListFilter, Mail, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Upload, X, AlertTriangle, Minus, PanelLeftClose } from 'lucide-react';
import { translate, gridChinese, type Language } from '@/lib/i18n';
import type { GridState } from 'ag-grid-community';
import { Button } from '@/components/ui/button';
import MailConnection, {mailLabel, type MailStatus} from '@/components/mail-connection';
import { dayInSydney, FIELD_LABELS, isOverdue, parseReportRows, waitingDays } from '@/lib/order-engine.mjs';
import { PRODUCTION_SHEETS, parseProductionSources } from '@/lib/production-rules.mjs';
ModuleRegistry.registerModules([AllCommunityModule]);
type Order = Record<string, any>;
type Event = Record<string, any>;
type Data = {
    orders: Order[];
    events: Event[];
    imports: any[];
    meta: any;
};
type View = 'overview' | 'orders' | 'history' | 'imports' | 'connection';
type Filter = 'active' | 'new' | 'changed' | 'cancelled' | 'overdue' | 'signed' | 'completed';
const fmt = (v: any) => !v ? '—' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : String(v);
const tone = (o: Order, today: string) => o.status === 'cancelled' ? 'muted' : o.status === 'completed' ? 'muted' : isOverdue(o, today) ? 'danger' : o.signedAt ? 'success' : o.specAt ? 'warning' : 'info';
const gridTheme = themeQuartz.withParams({ fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif', fontSize: 14, headerFontSize: 14, headerFontWeight: 600, foregroundColor: '#27364d', backgroundColor: '#ffffff', headerBackgroundColor: '#f7f9fc', borderColor: '#e7ebf1', rowBorder: { color: '#edf0f4', width: 1 }, wrapperBorder: false, wrapperBorderRadius: 0, cellHorizontalPadding: 8, selectedRowBackgroundColor: '#eef4ff', rowHoverColor: '#f5f8ff', accentColor: '#315fe9' });
export default function Dashboard() {
    const [language, setLanguage] = useState<Language>('zh');
    const [sidebarExpanded, setSidebarExpanded] = useState(false);
    const savedGridState = useRef<GridState | undefined>(undefined);
    const t = useCallback((text: string) => translate(text, language), [language]);
    useEffect(() => { try {
        const saved = localStorage.getItem('orderdesk-language');
        if (saved === 'en' || saved === 'zh')
            setLanguage(saved);
    }
    catch { } }, []);
    useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; }, [language]);
    function changeLanguage(next: Language) { if (next === language)
        return; savedGridState.current = grid.current?.api?.getState(); setLanguage(next); try {
        localStorage.setItem('orderdesk-language', next);
    }
    catch { } }
    const formatTime = (v: string) => v ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) : '—';
    const types: Record<string, string> = { new: t("新订单"), changed: t("订单变更"), cancelled: t("已取消") };
    const status = (o: Order, today: string) => o.status === 'cancelled' ? t("已取消") : o.status === 'completed' ? t("已完成") : isOverdue(o, today) ? t("签字逾期") : o.signedAt ? t("已签字") : o.specAt ? t("等待签字") : t("等待发图");
    const [mail, setMail] = useState<MailStatus|null>(null);
    useEffect(()=>{fetch('/api/mail-sync',{cache:'no-store'}).then(async r=>{if(r.ok)setMail(await r.json());}).catch(()=>{});},[]);
    const [data, setData] = useState<Data | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState<{
        duplicate: boolean;
        summary?: any;
    } | null>(null);
    const [view, setView] = useState<View>('overview'), [filter, setFilter] = useState<Filter>('active'), [date, setDate] = useState(dayInSydney()), [today, setToday] = useState(dayInSydney());
    const [query, setQuery] = useState(''), [dealer, setDealer] = useState(''), [selected, setSelected] = useState<Order | null>(null), [historyAll, setHistoryAll] = useState(false);
    const [pending, setPending] = useState<{
        records: any[];
        fileName: string;
        reportDate: string;
        productionSources?: Record<string, any[][]>;
    } | null>(null), [importing, setImporting] = useState(false), [exporting, setExporting] = useState(false);
    const input = useRef<HTMLInputElement>(null), dialogRef = useRef<HTMLDialogElement>(null), drawerRef = useRef<HTMLDialogElement>(null), grid = useRef<AgGridReact>(null);
    const load = useCallback(async () => { setBusy(true); setError(''); try {
        const r = await fetch('/api/orders', { cache: 'no-store' });
        const d: any = await r.json();
        if (!r.ok)
            throw new Error(d.error || '无法读取订单');
        setData(d);
        if(d.meta?.localTest && d.meta?.lastImport?.businessDate)setDate(d.meta.lastImport.businessDate);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "连接失败");
    }
    finally {
        setBusy(false);
    } }, []);
    useEffect(() => { void load(); const t = setInterval(() => setToday(dayInSydney()), 60000); return () => clearInterval(t); }, [load]);
    useEffect(() => { if (pending)
        dialogRef.current?.showModal();
    else
        dialogRef.current?.close(); }, [pending]);
    useEffect(() => { if (selected)
        drawerRef.current?.showModal();
    else
        drawerRef.current?.close(); }, [selected]);
    const dailyEvents = useMemo(() => data?.events.filter(e => e.date === date && !e.migration) || [], [data, date]);
    const eventIds = useMemo(() => ({ new: new Set(dailyEvents.filter(e => e.type === 'new').map(e => e.orderId)), changed: new Set(dailyEvents.filter(e => e.type === 'changed').map(e => e.orderId)), cancelled: new Set(dailyEvents.filter(e => e.type === 'cancelled').map(e => e.orderId)) }), [dailyEvents]);
    const counts = { new: eventIds.new.size, changed: eventIds.changed.size, cancelled: eventIds.cancelled.size, overdue: data?.orders.filter(o => isOverdue(o, today)).length || 0 };
    const dealers = useMemo(() => Array.from(new Set(data?.orders.map(o => o.dealer).filter(Boolean) || [])).sort() as string[], [data]);
    const matches = useCallback((o: Order) => { const q = query.toLowerCase().replace(/-/g, ''); return (!dealer || o.dealer === dealer) && (!q || [o.chassis, o.model, o.customer, o.dealer].some(v => String(v || '').toLowerCase().replace(/-/g, '').includes(q))); }, [dealer, query]);
    const rows = useMemo(() => { let orders = data?.orders || []; return orders.filter(o => { if (!matches(o))
        return false; if (filter === 'new' || filter === 'changed')
        return eventIds[filter].has(o.id); if (filter === 'cancelled')
        return view === 'overview' ? eventIds.cancelled.has(o.id) : o.status === 'cancelled'; if (filter === 'overdue')
        return isOverdue(o, today); if (filter === 'signed')
        return o.status === 'active' && !!o.signedAt; if (filter === 'completed')
        return o.status === 'completed'; return o.status === 'active'; }).sort((a, b) => Number(isOverdue(b, today)) - Number(isOverdue(a, today)) || (waitingDays(b, today) || 0) - (waitingDays(a, today) || 0) || a.chassis.localeCompare(b.chassis)); }, [data, matches, filter, eventIds, view, today]);
    const logs = useMemo(() => [...(data?.events || [])].filter(e => (historyAll || (!e.migration && e.date === date)) && matches(data?.orders.find(o => o.id === e.orderId) || e)).sort((a, b) => String(b.at).localeCompare(String(a.at))), [data, date, historyAll, matches]);
    const [logPage, setLogPage] = useState(1);
    useEffect(() => setLogPage(1), [date, historyAll, query, dealer]);
    const choose = (next: View) => { setView(next); setFilter('active'); setQuery(''); setDealer(''); };
    const metric = (next: Filter) => { setFilter(next); setView('overview'); };
    const columns = useMemo<ColDef[]>(() => [
        { field: 'chassis', headerName: t("Chassis"), pinned: 'left', width: 124, cellClass: 'chassis-cell', cellRenderer: (p: any) => <button className="chassis-link" onClick={() => setSelected(p.data)}>{p.value}<ArrowUpRight size={14}/></button> },
        { headerName: t("状态"), colId: 'orderStatus', width: language === 'en' ? 144 : 100, valueGetter: p => status(p.data, today), cellRenderer: (p: any) => <span className={`pill ${tone(p.data, today)}`}>{p.value}</span> },
        { field: 'dealer', headerName: t("Dealer"), width: 116 },
        { field: 'modelYear', headerName: t("Model Year"), width: 76 },
        { field: 'model', headerName: t("Model"), width: 112 },
        { field: 'customer', headerName: t("Customer"), width: 150, cellRenderer: (p: any) => <span className={p.value === 'Stock' ? 'stock' : ''}>{p.value || '—'}</span> },
        { field: 'requestDate', headerName: t("Request Date"), width: 108, valueFormatter: p => fmt(p.value) },
        { field: 'specAt', headerName: t("Plans Sent to Dealer"), width: 116, valueFormatter: p => fmt(p.value) },
        { field: 'signedAt', headerName: t("Signed Plans Received"), width: 116, valueFormatter: p => fmt(p.value) },
        { field: 'purchaseAt', headerName: t("Purchase Order Sent"), width: 116, valueFormatter: p => fmt(p.value) },
        { headerName: t("等待天数"), colId: 'waiting', width: 84, valueGetter: p => waitingDays(p.data, today), cellRenderer: (p: any) => <span className={isOverdue(p.data, today) ? 'text-danger' : ''}>{p.value === null ? '—' : `${p.value} ${t('天')}`}</span> },
        { field: 'forecastDate', headerName: t("Forecast Production"), width: 120, valueFormatter: p => fmt(p.value) },
        { field: 'receivedAt', headerName: t("Order Received"), width: 112, valueFormatter: p => fmt(p.value) },
        { field: 'sentLongtreeAt', headerName: t("Sent to Longtree"), width: 112, valueFormatter: p => fmt(p.value) },
        { field: 'shipment', headerName: t("Shipment"), width: 90 },
        { field: 'productionStatus', headerName: t("Production Status"), width: 120 },
        { field: 'priceVersion', headerName: t("Price Version"), width: 100 },
    ], [today, t]);
    async function readFile(file?: File) {
        if (!file)
            return;
        setImporting(true);
        setError('');
        setNotice(null);
        try {
            if (file.size > 10 * 1024 * 1024)
                throw new Error('Excel 文件不能超过 10 MB');
            if (!/\.xls[mx]$/i.test(file.name))
                throw new Error('请选择 .xlsx 或 .xlsm 文件');
            const ExcelJS = await import('exceljs');
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(await file.arrayBuffer());
            if (PRODUCTION_SHEETS.some(name => wb.getWorksheet(name))) {
                const sheets: Record<string, any[][]> = {};
                for (const name of PRODUCTION_SHEETS) {
                    const source = wb.getWorksheet(name);
                    if (!source) throw new Error(`生产数据缺少或无效: ${name}`);
                    const values: any[][] = [];
                    source.eachRow({includeEmpty:true},row => { values.push(Array.from({length:5},(_,i) => {
                        let value: any = row.getCell(i+1).value;
                        if(value && typeof value === 'object' && !(value instanceof Date))value='result' in value?value.result:value.richText?value.richText.map((x:any)=>x.text).join(''):value.text??'';
                        return value instanceof Date?value.toISOString():value??'';
                    })); });
                    sheets[name]=values;
                }
                setPending({records:[],productionSources:parseProductionSources(sheets) as Record<string, any[][]>,fileName:file.name,reportDate:''});
                return;
            }
            const sheet = wb.worksheets[0];
            if (!sheet)
                throw new Error('Excel 没有工作表');
            const matrix: any[][] = [];
            sheet.eachRow({ includeEmpty: true }, row => { const values: any[] = []; for (let i = 1; i <= Math.max(15, row.cellCount); i++) {
                let v: any = row.getCell(i).value;
                if (v && typeof v === 'object' && !(v instanceof Date)) {
                    v = 'result' in v ? v.result : 'richText' in v ? v.richText.map((x: any) => x.text).join('') : v.text || '';
                }
                values.push(v instanceof Date ? v.toISOString().slice(0, 10) : v);
            } matrix.push(values); });
            const records = parseReportRows(matrix);
            const text = sheet.name + ' ' + matrix.slice(0, 8).flat().join(' ');
            const detected = text.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || '';
            setPending({ records, fileName: file.name, reportDate: detected });
        }
        catch (e) {
            setError(e instanceof Error ? e.message : t("文件读取失败"));
        }
        finally {
            setImporting(false);
            if (input.current)
                input.current.value = '';
        }
    }
    async function confirmImport() { if (!pending || !pending.reportDate)
        return; setImporting(true); setError(''); try {
        const r = await fetch(pending.productionSources?'/api/production':'/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) });
        const result: any = await r.json();
        if (!r.ok)
            throw new Error(result.error || '导入失败');
        setNotice({ duplicate: result.duplicate, summary: result.summary });
        setPending(null);
        setDate(today);
        await load();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : t("导入失败"));
        setPending(null);
    }
    finally {
        setImporting(false);
    } }
    async function exportExcel() {
        setExporting(true);
        setError('');
        try {
            if(view !== 'history'){
                const visible: Order[] = [];
                grid.current?.api?.forEachNodeAfterFilterAndSort(n=>{if(n.data)visible.push(n.data);});
                const response=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:(grid.current?.api?visible:rows).map(o=>o.id)})});
                if(!response.ok){const result=await response.json() as {error?:string};throw new Error(result.error||'导出失败');}
                const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=`Planning-Orderlist-${date}.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);return;
            }
            const ExcelJS = await import('exceljs');
            const wb = new ExcelJS.Workbook();
            wb.creator = 'Regent Orderdesk';
            wb.created = new Date();
            const sheet = wb.addWorksheet(view === 'history' ? t("Change Log") : t("Orders"));
            if (view === 'history') {
                sheet.columns = [{ header: t("Date"), key: 'date', width: 16 }, { header: t("Chassis"), key: 'chassis', width: 20 }, { header: t("Dealer"), key: 'dealer', width: 22 }, { header: t("Type"), key: 'type', width: 18 }, { header: t("Field"), key: 'field', width: 28 }, { header: t("Before"), key: 'before', width: 30 }, { header: t("After"), key: 'after', width: 30 }, { header: t("Batch"), key: 'batch', width: 20 }];
                for (const e of logs) {
                    for (const c of e.changes.length ? e.changes : [{ field: t("Order"), before: null, after: t("Created") }])
                        sheet.addRow({ date: e.date, chassis: e.chassis, dealer: e.dealer, type: types[e.type], field: t((FIELD_LABELS as Record<string, string>)[c.field] || c.field), before: c.before ?? '', after: c.after ?? '', batch: e.migration ? t("Initial reconciliation") : t("Daily report") });
                }
            }
            else {
                const exportColumns = [['chassis', t("Chassis")], ['modelYear', t("Model Year")], ['model', t("Model")], ['dealer', t("Dealer")], ['customer', t("Customer")], ['requestDate', t("Request Date")], ['forecastDate', t("Forecast Production")], ['receivedAt', t("Order Received")], ['sentLongtreeAt', t("Order Sent to Longtree")], ['specAt', t("Plans Sent to Dealer")], ['signedAt', t("Signed Plans Received")], ['purchaseAt', t("Purchase Order Sent")], ['productionStatus', t("Production Status")], ['shipment', t("Shipment")], ['priceVersion', t("Price Version")], ['displayStatus', t("Status")], ['wait', t("Waiting Days")]];
                sheet.columns = exportColumns.map(([key, header]) => ({ header, key, width: Math.max(18, header.length + 3) }));
                const visible: Order[] = [];
                grid.current?.api?.forEachNodeAfterFilterAndSort(n => { if (n.data)
                    visible.push(n.data); });
                for (const o of grid.current?.api ? visible : rows) {
                    const row = sheet.addRow({ ...o, displayStatus: status(o, today), wait: waitingDays(o, today) });
                    for (const key of ['requestDate', 'forecastDate', 'receivedAt', 'sentLongtreeAt', 'specAt', 'signedAt', 'purchaseAt'])
                        if (/^\d{4}-\d{2}-\d{2}$/.test(o[key] || '')) {
                            row.getCell(key).value = new Date(o[key] + 'T00:00:00Z');
                            row.getCell(key).numFmt = 'dd/mm/yyyy';
                        }
                }
            }
            sheet.views = [{ state: 'frozen', ySplit: 1 }];
            sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
            sheet.getRow(1).height = 30;
            sheet.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17243D' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { vertical: 'middle' }; });
            const buffer = await wb.xlsx.writeBuffer();
            const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `Orderdesk-${view === 'history' ? 'Log' : filter}-${date}.xlsx`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : t("导出失败"));
        }
        finally {
            setExporting(false);
        }
    }
    const navigation: [
        View,
        any,
        string
    ][] = [['overview', LayoutDashboard, t("每日总览")], ['orders', FileSpreadsheet, t("全部订单")], ['history', History, t("变更日志")], ['imports', Upload, t("导入记录")]];
    const titles: Record<View, string> = { overview: t("订单总览"), orders: t("全部订单"), history: t("变更日志"), imports: t("导入记录"), connection: t("数据连接") };
    const filterTitles: Record<Filter, string> = { active: t("在排订单"), new: t("新订单"), changed: t("订单变更"), cancelled: t("取消订单"), overdue: t("逾期未签字"), signed: t("已签字订单"), completed: t("已完成订单") };
    return <div className={`app-shell compact ${sidebarExpanded ? 'nav-expanded' : ''}`}>
  <aside className="sidebar"><a href="/" className="brand"><span className="brand-mark">R<span /></span><div>REGENT RV<strong>Orderdesk</strong></div></a><div className="nav-label">{t("PLANNING")}</div><nav>{navigation.map(([id, Icon, label]) => <button key={id} title={label} aria-label={label} onClick={() => choose(id)} className={view === id ? 'nav-item selected' : 'nav-item'}><Icon size={20}/><span>{label}</span>{id === 'overview' && <span className="nav-dot"/>}</button>)}</nav><div className="sidebar-bottom"><button title={t("数据连接")} aria-label={t("数据连接")} className={view === 'connection' ? 'nav-item selected' : 'nav-item'} onClick={() => choose('connection')}><Settings2 size={20}/><span>{t("数据连接")}</span></button><div className="user-block"><span className="avatar">P</span><div>{t("Planning Team")}<span>Regent RV</span></div><ShieldCheck size={18}/></div></div></aside>
  <main className="main"><div className="topbar"><div className="topbar-leading"><button className="nav-toggle" title={t(sidebarExpanded?"收起导航":"展开导航")} aria-label={t(sidebarExpanded?"收起导航":"展开导航")} aria-expanded={sidebarExpanded} onClick={()=>setSidebarExpanded(v=>!v)}><PanelLeftClose size={19}/></button><div className="breadcrumb">{t("Planning ")}<ChevronRight size={16}/><span>{titles[view]}</span></div></div><div className="topbar-actions"><div className="language-switch" role="group" aria-label="Language / 语言"><button type="button" aria-pressed={language === 'zh'} onClick={() => changeLanguage('zh')}>中文</button><button type="button" aria-pressed={language === 'en'} onClick={() => changeLanguage('en')}>English</button></div><button className="sync-status" onClick={() => choose('connection')}><span className="status-dot amber"/>{mailLabel(mail,language === 'zh')}<ChevronRight size={16}/></button></div></div>
   <div className="workspace"><header className="page-header"><div><div className="eyebrow">{t("ORDER MANAGEMENT")}</div><h1>{titles[view]}</h1></div><div className="header-actions"><Button variant="outline" className="action" onClick={() => void exportExcel()} disabled={!data || exporting || view === 'connection' || view === 'imports'}><ArrowDownToLine size={18}/>{exporting ? t("正在导出") : t("导出 Excel")}</Button><Button className="action primary" onClick={() => input.current?.click()} disabled={importing}><Plus size={19}/>{importing ? t("正在读取") : t("导入报告")}</Button><input ref={input} type="file" accept=".xlsx,.xlsm" hidden onChange={e => void readFile(e.target.files?.[0])}/></div></header>
   {error && <div role="alert" className="message error"><AlertTriangle size={19}/><span>{t(error)}</span><button aria-label={t("关闭错误")} onClick={() => setError('')}><X size={18}/></button></div>}
   {notice && <div role="status" className="message success"><Check size={19}/><span>{notice.duplicate ? t('这份报告已经处理，无重复更新') : notice.summary.kind === 'production' ? `${t('生产状态已重新计算')} · ${notice.summary.changedCount} ${t('个变更')}` : language === 'zh' ? `导入成功 · ${notice.summary.newCount} 个新订单 · ${notice.summary.changedCount} 个变更 · ${notice.summary.cancelledCount} 个取消` : `Imported · ${notice.summary.newCount} new · ${notice.summary.changedCount} changed · ${notice.summary.cancelledCount} cancelled`}</span><button aria-label={t("关闭通知")} onClick={() => setNotice(null)}><X size={18}/></button></div>}
   {(view === 'overview' || view === 'history') && <div className="date-row"><div className="date-select"><Clock3 size={18}/><input aria-label={t("查看日期")} type="date" max={today} value={date} onChange={e => setDate(e.target.value || today)}/>{date === today && <span className="today-tag">{t("今天")}</span>}</div><div className="report-stamp">{t("报告日期 ")}<strong>{fmt(data?.meta.lastReportDate)}</strong><button aria-label={t("刷新订单")} className={busy ? 'icon-button spinning' : 'icon-button'} disabled={busy} onClick={() => void load()}><RefreshCw size={17}/></button></div></div>}
   {view === 'overview' && <div className="metrics">{[{ id: 'new', label: t("新订单"), icon: Plus, color: 'blue' }, { id: 'changed', label: t("订单变更"), icon: RefreshCw, color: 'violet' }, { id: 'cancelled', label: t("取消订单"), icon: Minus, color: 'slate' }, { id: 'overdue', label: t("当前签字逾期"), icon: Clock3, color: 'orange' }].map(({ id, label, icon: Icon, color }) => <button key={id} className={`metric ${color} ${filter === id ? 'chosen' : ''}`} onClick={() => metric(id as Filter)}><div className="metric-label"><span>{label}</span><span className="metric-icon"><Icon size={20}/></span></div><div className="metric-value">{data ? counts[id as keyof typeof counts].toLocaleString() : '—'}<ArrowUpRight size={23}/></div><div className="metric-bottom">{id === 'overdue' ? t("待跟进") : t("查看明细")}<ChevronRight size={16}/></div></button>)}</div>}
   {(view === 'overview' || view === 'orders') && <section className="table-panel"><div className="panel-heading"><div><h2>{filterTitles[filter]}</h2><span className="count-chip">{data ? rows.length.toLocaleString() : '—'}</span></div><div className="table-tabs">{([['active', t("在排")], ['signed', t("已签字")], ['completed', t("已完成")], ...(view === 'orders' ? [['cancelled', t("已取消")]] : [])] as [
            Filter,
            string
        ][]).map(([id, label]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    <div className="table-toolbar"><label className="search"><Search size={18}/><input placeholder={t("搜索 Chassis、客户、型号…")} aria-label={t("搜索订单")} value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label={t("清除搜索")} onClick={() => setQuery('')}><X size={16}/></button>}</label><label className="dealer-filter"><ListFilter size={18}/><select aria-label={t("筛选 Dealer")} value={dealer} onChange={e => setDealer(e.target.value)}><option value="">{t("全部 Dealer")}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label><button className="reset-filters" onClick={() => { setQuery(''); setDealer(''); grid.current?.api?.setFilterModel(null); grid.current?.api?.resetColumnState(); }}><SlidersHorizontal size={17}/><span>{t("重置")}</span></button></div>
    <div className="order-grid"><AgGridReact key={language} initialState={savedGridState.current} ref={grid} theme={gridTheme} rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 70, wrapHeaderText: true, autoHeaderHeight: true, tooltipValueGetter: p => p.value == null ? '' : String(p.value) }} getRowId={p => p.data.id} rowHeight={36} headerHeight={48} tooltipShowDelay={300} pagination paginationPageSize={50} paginationPageSizeSelector={[25, 50, 100]} loading={busy && !data} overlayNoRowsTemplate={`<span style='font-size:16px;color:#61718a'>${t('没有符合条件的订单')}</span>`} onRowDoubleClicked={e => setSelected(e.data)} localeText={language === 'zh' ? gridChinese : undefined}/></div>
   </section>}
   {view === 'history' && <section className="table-panel"><div className="panel-heading"><div><h2>{historyAll ? t("全部历史") : t("当日变更")}</h2><span className="count-chip">{logs.length.toLocaleString()}</span></div><div className="table-tabs"><button className={!historyAll ? 'active' : ''} onClick={() => setHistoryAll(false)}>{t("当日")}</button><button className={historyAll ? 'active' : ''} onClick={() => setHistoryAll(true)}>{t("全部历史")}</button></div></div><div className="table-toolbar"><label className="search"><Search size={18}/><input aria-label={t("搜索日志")} placeholder={t("搜索 Chassis、客户、Dealer…")} value={query} onChange={e => setQuery(e.target.value)}/></label><label className="dealer-filter"><ListFilter size={18}/><select aria-label={t("日志 Dealer")} value={dealer} onChange={e => setDealer(e.target.value)}><option value="">{t("全部 Dealer")}</option>{dealers.map(d => <option key={d}>{d}</option>)}</select></label></div><div className="log-list">{logs.slice((logPage - 1) * 30, logPage * 30).map(e => <button className="log-row" key={e.id} onClick={() => setSelected(data?.orders.find(o => o.id === e.orderId) || null)}><span className={`log-icon ${e.type}`}>{e.type === 'new' ? <Plus size={20}/> : e.type === 'cancelled' ? <Minus size={20}/> : <RefreshCw size={19}/>}</span><span className="log-body"><strong>{e.chassis}<span className="log-dealer">{e.dealer}</span></strong><span>{e.migration ? t("初始对账 · ") : ''}{types[e.type]}{e.changes.length > 0 ? ' · ' + e.changes.map((c: any) => t((FIELD_LABELS as Record<string, string>)[c.field] || c.field)).join(' / ') : ''}</span></span><span className="log-time">{formatTime(e.at)}</span><ChevronRight size={18}/></button>)}{!logs.length && <div className="empty-state"><History size={34}/><h3>{t("没有变更记录")}</h3></div>}</div>{logs.length > 30 && <div className="pager"><span>{logPage} / {Math.ceil(logs.length / 30)}</span><Button variant="outline" disabled={logPage <= 1} onClick={() => setLogPage(p => p - 1)}><ArrowLeft size={17}/>{t("上一页")}</Button><Button variant="outline" disabled={logPage >= Math.ceil(logs.length / 30)} onClick={() => setLogPage(p => p + 1)}>{t("下一页")}<ArrowRight size={17}/></Button></div>}</section>}
   {view === 'imports' && <section className="table-panel"><div className="panel-heading"><div><h2>{t("处理记录")}</h2><span className="count-chip">{data?.imports.length || 0}</span></div></div>{[...(data?.imports || [])].reverse().map(batch => <article key={batch.id} className="import-card"><div className="file-icon"><FileSpreadsheet size={25}/></div><div className="import-body"><h3>{batch.fileName}</h3><div className="import-meta"><span>{batch.kind === "production" ? t("生产数据") : batch.migration ? t("初始对账") : t("日报导入")}</span><span>{formatTime(batch.processedAt)}</span><span>{batch.rows.toLocaleString()} {t(" 条源记录")}</span></div><div className="import-counts"><span>{t("新增 ")}<b>{batch.newCount}</b></span><span>{t("变更 ")}<b>{batch.changedCount}</b></span><span>{t("已取消 ")}<b>{batch.cancelledCount}</b></span>{batch.reviewCount > 0 && <span className="text-danger">{t("待核对 ")}<b>{batch.reviewCount}</b></span>}</div></div><span className="pill success"><Check size={14}/>{t("已处理")}</span></article>)}{!data?.imports.length && <div className="empty-state"><Upload size={34}/><h3>{t("尚无导入记录")}</h3></div>}</section>}
   {view === 'connection' && <div className="connections"><section className="connection-card"><div className="connection-icon"><ShieldCheck size={26}/></div><h2>{t("订单数据库")}</h2><span className={`pill ${data ? 'success' : 'warning'}`}>{data ? t("已连接") : t("等待连接")}</span><dl><div><dt>{t("存储")}</dt><dd>{data?.meta.localTest ? (language === 'zh' ? '本地测试数据' : 'Local test data') : 'Firebase'}</dd></div><div><dt>{t("数据保护")}</dt><dd>{data?.meta.localTest ? (language === 'zh' ? '本机' : 'This computer') : t("加密存储 · 私人访问")}</dd></div><div><dt>{t("订单")}</dt><dd>{data?.orders.length.toLocaleString() || '—'}</dd></div><div><dt>{t("最新报告")}</dt><dd>{fmt(data?.meta.lastReportDate)}</dd></div></dl><Button variant="outline" className="action" disabled={busy} onClick={() => void load()}><RefreshCw size={17}/>{t("刷新数据")}</Button></section><MailConnection zh={language==='zh'} status={mail} onStatus={setMail} onImported={load} onUpload={()=>input.current?.click()}/></div>}
   <footer className="workspace-footer"><span><span className="status-dot"/>{data?.meta.localTest ? (language === 'zh' ? '本地测试数据' : 'Local test data') : data ? t("Firebase 已连接") : t("等待数据连接")}</span><span>SYDNEY · {fmt(today)}</span></footer>
   </div>
  </main>
  <dialog ref={dialogRef} className="import-dialog" onCancel={() => setPending(null)}><div className="dialog-head"><h2>{t(pending?.productionSources?"导入生产数据":"导入 CRM 报告")}</h2><button aria-label={t("关闭导入")} disabled={importing} onClick={() => setPending(null)}><X size={22}/></button></div>{pending && <><div className="upload-preview"><FileSpreadsheet size={34}/><strong>{pending.fileName}</strong><span>{(pending.productionSources?Object.values(pending.productionSources).reduce((n,rows)=>n+rows.length-1,0):pending.records.length).toLocaleString()} {t(" 条记录")}</span></div>{pending.productionSources && <p>{t("按 PGI、Dispatch Special、Regent 和 Longtree 原始记录自动计算生产状态；请填写这份数据的更新日期。")}</p>}<label className="date-field">{t("报告日期")}<input type="date" value={pending.reportDate} max={today} onChange={e => setPending({ ...pending, reportDate: e.target.value })}/></label><div className="dialog-actions"><Button variant="outline" disabled={importing} onClick={() => setPending(null)}>{t("取消")}</Button><Button className="primary" disabled={!pending.reportDate || importing} onClick={() => void confirmImport()}>{importing ? t("正在更新…") : t("确认导入")}</Button></div></>}</dialog>
  <dialog ref={drawerRef} className="order-drawer" onCancel={() => setSelected(null)}>{selected && <><div className="drawer-header"><div><span className="eyebrow">{t("ORDER DETAILS")}</span><h2>{selected.chassis}</h2></div><button aria-label={t("关闭明细")} onClick={() => setSelected(null)}><X size={24}/></button></div><div className="drawer-content"><div className="drawer-status"><span className={`pill ${tone(selected, today)}`}>{status(selected, today)}</span>{isOverdue(selected, today) && <strong className="text-danger">{t("等待签字 ")}{waitingDays(selected, today)} {t(" 天")}</strong>}</div><div className="detail-grid">{[['dealer', t("Dealer")], ['customer', t("Customer")], ['modelYear', t("Model Year")], ['model', t("Model")], ['requestDate', t("Request Date")], ['forecastDate', t("Forecast Production")]].map(([key, label]) => <div key={key}><span>{label}</span><strong>{fmt(selected[key])}</strong></div>)}</div><h3 className="section-title">{t("订单进度")}</h3><div className="milestones">{[['receivedAt', t("Order Received")], ['sentLongtreeAt', t("Sent to Longtree")], ['specAt', t("Plans Sent to Dealer")], ['signedAt', t("Signed Plans Received")], ['purchaseAt', t("Purchase Order Sent")]].map(([key, label]) => <div className={selected[key] ? 'milestone done' : 'milestone'} key={key}><span className="milestone-dot">{selected[key] ? <Check size={14}/> : <span />}</span><span>{label}</span><strong>{fmt(selected[key])}</strong></div>)}</div><h3 className="section-title">{t("变更历史")}</h3><div className="detail-history">{(data?.events || []).filter(e => e.orderId === selected.id).reverse().map(e => <article key={e.id}><div className="history-heading"><strong>{e.migration ? t("初始对账 · ") : ''}{types[e.type]}</strong><span>{formatTime(e.at)}</span></div>{e.changes.map((c: any, i: number) => <div className="field-change" key={i}><span>{t((FIELD_LABELS as Record<string, string>)[c.field] || c.field)}</span><div><del>{c.field === 'status' ? t(fmt(c.before)) : fmt(c.before)}</del><ArrowRight size={14}/><strong>{c.field === 'status' ? t(fmt(c.after)) : fmt(c.after)}</strong></div></div>)}</article>)}{!(data?.events || []).some(e => e.orderId === selected.id) && <p className="no-history">{t("初始排程订单")}</p>}</div></div></>}</dialog>
 </div>;
}
