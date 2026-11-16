// Dealer 分析: our five dealerships (Dealer Portal "Self-owned") — stock, transit, handovers, target stock, how many stock
// vans each still needs, and the rolling line built from it. Data: /api/dealer-analysis (read-only). The server re-reads
// the Dealer Portal every 2 hours on its own; this page re-asks the server every 30 minutes while it is open.
import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, Store, ArrowDownToLine } from 'lucide-react';
import DealerLogisticsFlow, { type DealerLogistics } from './dealer-logistics-flow';

type HandoverMonth = { month: string; stock: number; customer: number; second: number };
type MonthRow = { month: string; stockIn: number; customerIn: number; stockOut: number; endStock: number };
export type DealerSummary = { slug: string; name: string; target: number; yard: { stock: number; customer: number; second: number; total: number }; transit: { stock: number; customer: number; second: number; total: number; pgiStock?: number; transportStock?: number };
  handover: { months: HandoverMonth[]; thisMonth: HandoverMonth; avgStock: number; avgCustomer: number; avgSecond: number }; months: number; deliveredBy: string; pipeline: Record<string, number>; pipelineStock: number; pipelineCustomer: number;
  travelDays: number | null; lead: number | null; paused?: boolean; arriving: number; transitArriving: number; sold: number; projected: number | null; need: number; stockPicked: number; stockAvailable: number; customerPicked: number; monthly: MonthRow[] };
export type DealerNow = { slug: string; name: string; own: boolean; target: number | null; yard: { stock: number; customer: number; second: number; total: number }; transit: { stock: number; customer: number; total: number; pgiStock?: number; transportStock?: number };
  handover: { months: HandoverMonth[]; thisMonth: HandoverMonth; avgStock: number; avgCustomer: number }; line: Record<string, number>; lineStock: number; lineCustomer: number; inSight: number; ordersOpen: { stock: number; customer: number }; monthsCover: number | null; yardVsTarget: number | null };
export type Dealership = { lockedLast: string; rollingEnd: string; size: number; picked: number; customers: number; dispatchDays: number; months: number; targetSource: string; dealers: DealerSummary[]; all?: DealerNow[] };
type Payload = { today: string; dealership: Dealership | null; logistics?: DealerLogistics | null; sources: Record<string, { at: string; error: string; count: number } | undefined>; refreshing?: boolean; error?: string };

const POLL_MS = 30 * 60 * 1000;
const time = (v?: string) => v ? new Date(v).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const GROUP_ZH: Record<string, string> = { transport: 'Transport', au: '澳洲生产', sea: '海运', cn: '国内生产', locked: '排产锁定线' };

/** Per dealership: yard, transit, last three months of handovers, vans arriving, the stock target and the stock still needed. */
export function DealerTable({ dl, zh }: { dl: Dealership; zh: boolean }) {
  const m = dl.dealers[0]?.handover.months.map(x => x.month.slice(5)) || [];
  return <div className="da-table"><table>
    <thead><tr>
      <th>Dealer</th><th>{zh ? '目标库存' : 'Target'}</th><th>{zh ? '店里 new stock' : 'Yard new stock'}</th><th title={zh ? '已 PGI 在路上的 + 在 Transport 的（已下线、正在运过来）' : 'PGI on the road + at Transport'}>{zh ? '在途 stock' : 'Transit stock'}</th>
      <th title={zh ? '交付按排产表客户名分 stock / customer，同 Dealer Portal YTD Handover' : 'As the Dealer Portal YTD Handover'}>{zh ? `近三月交付 stock（${m.join(' / ')} 月）` : `Stock handovers (${m.join(' / ')})`}</th><th>{zh ? '月均 stock 交付' : 'Avg stock handovers / month'}</th>
      <th title={zh ? '到店 = 澳洲预计下线（Transport 按今天）+ 3 天出车 + 路上天数' : 'At the dealer = AU finish (Transport: today) + 3 + travel days'}>{zh ? '到店天数' : 'Days to dealer'}</th>
      <th title={zh ? '澳洲生产、海运、国内生产、排产锁定线里这家的 stock 订单（Transport 已算在途）' : 'Stock orders of this dealer from AU production to the locked line'}>{zh ? '线上 stock' : 'Stock on the line'}</th>
      <th title={zh ? '滚动排产线最后一台澳洲下线 + 到店天数' : ''}>{zh ? '滚动线到店' : 'Rolling line at dealer'}</th>
      <th title={zh ? '线上 stock 里那天之前能到店的' : ''}>{zh ? '那天前到店 stock' : 'Stock arriving by then'}</th>
      <th title={zh ? '店里 + 那天前到店的在途 stock + 那天前到店的线上 stock − 月均 stock 交付 × 月数' : ''}>{zh ? '那天预计 stock' : 'Stock then'}</th><th>{zh ? '还缺' : 'Need'}</th><th>{zh ? '排进滚动 stock' : 'Stock on the rolling line'}</th>
    </tr></thead>
    <tbody>{dl.dealers.map(d => <tr key={d.slug} className={d.paused ? 'paused' : ''}>
      <td><b>{d.name}</b></td><td>{d.target}</td><td className={d.yard.stock > d.target ? 'over' : ''}><b>{d.yard.stock}</b></td><td title={zh ? `已 PGI ${d.transit.pgiStock ?? 0} + Transport ${d.transit.transportStock ?? 0}` : ''}>{d.transit.stock}</td>
      <td>{d.handover.months.map(x => x.stock).join(' / ')}<small> · {zh ? '本月' : 'MTD'} {d.handover.thisMonth.stock}</small></td><td>{d.handover.avgStock}</td>
      {d.paused ? <><td colSpan={1}>—</td><td title={Object.entries(d.pipeline).map(([g, n]) => `${zh ? GROUP_ZH[g] || g : g} ${n}`).join(' · ')}>{d.pipelineStock}</td><td colSpan={4} className="paused-note">{zh ? '暂不计算' : 'Not calculated for now'}</td></> : <>
        <td>{dl.dispatchDays} + {d.travelDays}</td>
        <td title={Object.entries(d.pipeline).map(([g, n]) => `${zh ? GROUP_ZH[g] || g : g} ${n}`).join(' · ')}>{d.pipelineStock}</td>
        <td>{d.deliveredBy}</td><td>{d.arriving}</td>
        <td title={`${d.yard.stock} + ${d.transitArriving} + ${d.arriving} − ${d.sold} (${d.handover.avgStock} × ${d.months})`} className={(d.projected ?? 0) < d.target ? 'short' : 'over'}>{d.projected}</td>
        <td className={d.need ? 'short' : ''}><b>{d.need}</b></td></>}
      <td>{d.stockPicked}{!d.paused && d.need > d.stockPicked ? <small className="short"> {zh ? `stock 订单只有 ${d.stockAvailable} 台，还差 ${d.need - d.stockPicked}` : `only ${d.stockAvailable} stock orders, ${d.need - d.stockPicked} short`}</small> : null}</td>
    </tr>)}</tbody>
  </table></div>;
}

function DealerCard({ d, zh }: { d: DealerSummary; zh: boolean }) {
  if (d.paused || !d.monthly.length) return <article className="da-card"><header><div><strong>{d.name}</strong><span>{zh ? `目标 ${d.target} · 店里 new stock ${d.yard.stock} · 在途 stock ${d.transit.stock}` : `Target ${d.target} · yard ${d.yard.stock}`}</span></div><b className="paused">{zh ? '暂不计算' : 'Paused'}</b></header>
    <table className="da-mini"><thead><tr><th>{zh ? '近三月' : 'Last 3 months'}</th>{d.handover.months.map(x => <th key={x.month}>{x.month.slice(5)}{zh ? '月' : ''}</th>)}<th>{zh ? '本月' : 'MTD'}</th><th>{zh ? '月均' : 'Avg'}</th></tr></thead>
      <tbody>{([['stock', zh ? 'Stock 交付' : 'Stock handovers', d.handover.avgStock]] as const).map(([k, l, a]) => <tr key={k}><td>{l}</td>{d.handover.months.map(x => <td key={x.month}>{x[k]}</td>)}<td>{d.handover.thisMonth[k]}</td><td><b>{a}</b></td></tr>)}</tbody></table></article>;
  const max = Math.max(1, ...d.monthly.map(x => x.stockIn), ...d.monthly.map(x => x.endStock), d.target), H = 90, h = (n: number) => `${Math.max(0, Math.min(1, n / max)) * H}px`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = (k: string, i: number) => { const [y, mm] = k.split('-'); return <>{MON[Number(mm) - 1]}{i === 0 || mm === '01' ? <small> {y}</small> : null}</>; };
  return <article className="da-card">
    <header><div><strong>{d.name}</strong><span>{zh ? `目标 ${d.target} · 店里 new stock ${d.yard.stock} · 在途 stock ${d.transit.stock} · 下线 + ${(d.lead ?? 0)} 天到店` : `Target ${d.target} · yard ${d.yard.stock} · transit stock ${d.transit.stock} · AU finish + ${d.lead} days`}</span></div>
      <b className={d.need ? 'short' : 'ok'}>{d.need ? (zh ? `还缺 ${d.need}` : `Need ${d.need}`) : (zh ? '不缺' : 'OK')}</b></header>
    <table className="da-fc">
      <tbody>
        <tr className="bars"><th>{zh ? <><span className="lg"><i className="stock" />到店 stock</span><span className="lg"><i className="line" />月底 stock</span><span className="lg"><i className="dash" />目标</span></> : <><span className="lg"><i className="stock" />Stock in</span><span className="lg"><i className="line" />Month-end stock</span><span className="lg"><i className="dash" />Target</span></>}</th>
          {d.monthly.map(x => <td key={x.month}><div className="da-col" style={{ height: H }}>
            <div className="da-tgt" style={{ bottom: h(d.target) }} />
            <i className="stock" style={{ height: h(x.stockIn) }} />
            <em style={{ bottom: h(x.endStock) }} className={x.endStock < d.target ? 'low' : ''} />
          </div></td>)}</tr>
        <tr className="months"><th>{zh ? '月份' : 'Month'}</th>{d.monthly.map((x, i) => <td key={x.month}>{label(x.month, i)}</td>)}</tr>
        <tr><th>{zh ? '到店 stock' : 'Stock in'}</th>{d.monthly.map(x => <td key={x.month}>{x.stockIn}</td>)}</tr>
        <tr><th title={zh ? '按近三个月的月均 stock 交付；本月只算剩下的天数' : ''}>{zh ? '卖出 stock' : 'Stock sold'}</th>{d.monthly.map(x => <td key={x.month}>{Math.round(x.stockOut)}</td>)}</tr>
        <tr className="end"><th>{zh ? '月底 stock' : 'Stock at month end'}</th>{d.monthly.map(x => <td key={x.month} className={x.endStock < d.target ? 'short' : ''}>{x.endStock}</td>)}</tr>
      </tbody>
    </table>
    <table className="da-mini"><thead><tr><th>{zh ? '近三月' : 'Last 3 months'}</th>{d.handover.months.map(x => <th key={x.month}>{x.month.slice(5)}{zh ? '月' : ''}</th>)}<th>{zh ? '本月' : 'MTD'}</th><th>{zh ? '月均' : 'Avg'}</th></tr></thead>
      <tbody>{([['stock', zh ? 'Stock 交付' : 'Stock handovers', d.handover.avgStock]] as const).map(([k, l, a]) => <tr key={k}><td>{l}</td>{d.handover.months.map(x => <td key={x.month}>{x[k]}</td>)}<td>{d.handover.thisMonth[k]}</td><td><b>{a}</b></td></tr>)}</tbody></table>
  </article>;
}

/** Every dealer now (stock only): yard, transit (incl. Transport), stock orders on the line, handovers, months of cover. */
function AllDealers({ list, zh, today }: { list: DealerNow[]; zh: boolean; today: string }) {
  const m = list[0]?.handover.months.map(x => x.month.slice(5)) || [];
  const total = (f: (d: DealerNow) => number) => list.reduce((n, d) => n + f(d), 0);
  async function exportExcel() {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(zh ? '全部经销商' : 'All dealers');
    const head = [zh ? 'Dealer' : 'Dealer', zh ? '直营' : 'Own', zh ? '目标库存' : 'Target', zh ? '店里 new stock' : 'Yard new stock', zh ? '店里 vs 目标' : 'Yard vs target', zh ? '在途 stock（PGI + Transport）' : 'Transit stock',
      zh ? '澳洲生产 stock' : 'AU production', zh ? '海运 stock' : 'Shipping', zh ? '国内生产 stock' : 'China production', zh ? '锁定线 stock' : 'Locked', zh ? '线上 stock 合计' : 'Stock on the line',
      zh ? '看得见的 stock（店里 + 在途 + 线上）' : 'Stock in sight', ...m.map(x => `${zh ? 'stock 交付 ' : 'Stock handovers '}${x}${zh ? '月' : ''}`), zh ? '本月 stock 交付' : 'Stock handovers MTD', zh ? '月均 stock 交付' : 'Avg stock handovers / month', zh ? '够卖几个月' : 'Months of cover',
      zh ? '月均 customer 交付' : 'Avg customer handovers / month', zh ? '线上 customer 车' : 'Customer vans on the line', zh ? '未排产 stock 订单' : 'Unscheduled stock orders', zh ? '未排产 customer 订单' : 'Unscheduled customer orders'];
    ws.addRow([zh ? `全部经销商 · stock 现状（${today}，Dealer Portal + Orderdesk 产线）` : `All dealers · stock now (${today})`]); ws.getRow(1).font = { bold: true, size: 13 };
    ws.addRow([]); ws.addRow(head); ws.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3352' } }; ws.getRow(3).alignment = { wrapText: true, vertical: 'middle' };
    list.forEach(d => ws.addRow([d.name, d.own ? (zh ? '是' : 'Yes') : '', d.target ?? '', d.yard.stock, d.yardVsTarget ?? '', d.transit.stock, d.line.au || 0, d.line.sea || 0, d.line.cn || 0, d.line.locked || 0, d.lineStock, d.inSight,
      ...d.handover.months.map(x => x.stock), d.handover.thisMonth.stock, d.handover.avgStock, d.monthsCover ?? '', d.handover.avgCustomer, d.lineCustomer, d.ordersOpen.stock, d.ordersOpen.customer]));
    const first = 4, last = 3 + list.length, cols = head.length;
    const sumRow = ws.addRow([zh ? '合计' : 'Total', '', ...Array.from({ length: cols - 2 }, (_, i) => { const col = ws.getColumn(i + 3).letter; return { formula: `SUM(${col}${first}:${col}${last})` }; })]);
    const avgCol = 12 + m.length + 2, coverCol = avgCol + 1, sightCol = 12; // Dealer, Own, Target, Yard, vs, Transit, AU, Sea, CN, Locked, Line, Sight, months…, MTD, Avg, Cover
    sumRow.getCell(coverCol).value = { formula: `IF(${ws.getColumn(avgCol).letter}${last + 1}>0,ROUND(${ws.getColumn(sightCol).letter}${last + 1}/${ws.getColumn(avgCol).letter}${last + 1},1),"")` };
    sumRow.font = { bold: true };
    ws.addRow([]);
    [zh ? '说明' : 'Notes',
      zh ? '店里 new stock：Dealer Portal 管理页的数（直营店看开票对象 Regent / Snowy River / United；其他经销商看客户名 / 类型）。' : 'Yard new stock: as the Dealer Portal admin page.',
      zh ? '在途 stock：已 PGI、100 天内、还没进店也没交付的 stock 车 + 在 Transport 的 stock 车。' : 'Transit: PGI within 100 days not in a yard or handed over, plus Transport.',
      zh ? '线上 stock：Orderdesk 产线里澳洲生产、海运、国内生产、排产锁定线中客户名以 Stock 结尾的订单。' : 'Stock on the line: orders whose customer ends with Stock, AU production → locked.',
      zh ? `stock 交付：Dealer Portal handover，按排产表客户名分 stock / customer（同 YTD Handover），月均取 ${m.join('、')} 月。` : 'Stock handovers: Dealer Portal handovers, average of the last 3 full months.',
      zh ? '够卖几个月 = 看得见的 stock ÷ 月均 stock 交付。目标库存：Andrew Crank 2026-10-27 邮件。' : 'Months of cover = stock in sight ÷ average stock handovers. Targets: Andrew Crank, 2026-10-27.'].forEach((t, i) => { const r = ws.addRow([t]); if (!i) r.font = { bold: true }; });
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 24 : 12; });
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
    ws.eachRow(r => r.eachCell(c => { c.font = { name: 'Arial', size: 10, ...(c.font || {}) }; }));
    const buf = await wb.xlsx.writeBuffer(), a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = `Dealer-stock-${today}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
  }
  return <>
    <div className="da-subhead"><h3 className="da-sub">{zh ? `全部经销商 · 现在（只看 stock，${list.length} 家）` : `All dealers · now (stock only, ${list.length})`}</h3>
      <button className="pl-export" onClick={() => void exportExcel()}><ArrowDownToLine size={13} />{zh ? '导出 Excel' : 'Export Excel'}</button></div>
    <div className="da-table"><table>
      <thead><tr><th>Dealer</th><th>{zh ? '目标库存' : 'Target'}</th><th>{zh ? '店里 new stock' : 'Yard new stock'}</th><th>{zh ? '店里 vs 目标' : 'vs target'}</th><th title={zh ? '已 PGI 在路上的 + 在 Transport 的' : ''}>{zh ? '在途 stock' : 'Transit stock'}</th>
        <th title={zh ? '澳洲生产 / 海运 / 国内生产 / 排产锁定线' : ''}>{zh ? '线上 stock（澳洲 / 海运 / 国内 / 锁定）' : 'Stock on the line (AU / sea / CN / locked)'}</th><th>{zh ? '看得见的 stock' : 'Stock in sight'}</th>
        <th>{zh ? `stock 交付（${m.join(' / ')} 月）` : `Stock handovers (${m.join(' / ')})`}</th><th>{zh ? '月均 stock 交付' : 'Avg / month'}</th><th title={zh ? '看得见的 stock ÷ 月均 stock 交付' : ''}>{zh ? '够卖几个月' : 'Months of cover'}</th><th>{zh ? '未排产 stock / customer 订单' : 'Unscheduled stock / customer orders'}</th></tr></thead>
      <tbody>{list.map(d => <tr key={d.slug} className={d.own ? 'own' : ''}>
        <td><b>{d.name}</b>{d.own ? <small> · {zh ? '直营' : 'own'}</small> : null}</td><td>{d.target ?? '—'}</td><td><b>{d.yard.stock}</b></td>
        <td className={d.yardVsTarget == null ? '' : d.yardVsTarget >= 0 ? 'over' : 'short'}>{d.yardVsTarget == null ? '—' : `${d.yardVsTarget > 0 ? '+' : ''}${d.yardVsTarget}`}</td>
        <td title={zh ? `已 PGI ${d.transit.pgiStock ?? 0} + Transport ${d.transit.transportStock ?? 0}` : ''}>{d.transit.stock}</td>
        <td>{d.lineStock}<small> · {d.line.au || 0} / {d.line.sea || 0} / {d.line.cn || 0} / {d.line.locked || 0}</small></td><td><b>{d.inSight}</b></td>
        <td>{d.handover.months.map(x => x.stock).join(' / ')}<small> · {zh ? '本月' : 'MTD'} {d.handover.thisMonth.stock}</small></td><td>{d.handover.avgStock}</td>
        <td className={d.monthsCover != null && d.monthsCover > 6 ? 'over' : d.monthsCover != null && d.monthsCover < 2 ? 'short' : ''}>{d.monthsCover ?? '—'}</td><td>{d.ordersOpen.stock} / {d.ordersOpen.customer}</td>
      </tr>)}
        <tr className="total"><td><b>{zh ? '合计' : 'Total'}</b></td><td>{total(d => d.target || 0)}</td><td><b>{total(d => d.yard.stock)}</b></td><td></td><td>{total(d => d.transit.stock)}</td><td>{total(d => d.lineStock)}</td><td><b>{total(d => d.inSight)}</b></td><td></td><td>{total(d => d.handover.avgStock).toFixed(1)}</td><td>{(total(d => d.inSight) / Math.max(1, total(d => d.handover.avgStock))).toFixed(1)}</td><td>{total(d => d.ordersOpen.stock)} / {total(d => d.ordersOpen.customer)}</td></tr>
      </tbody></table></div>
    <p className="da-note">{zh ? '店里 new stock 用 Dealer Portal 管理页的数；在途 = 已 PGI 在路上的 + Transport；线上 stock = 产线里客户名以 Stock 结尾的订单；够卖几个月 = 看得见的 stock ÷ 近三个月月均 stock 交付（绿 > 6 个月，红 < 2 个月）。目标库存只有 Andrew 邮件里列了的经销商有。' : ''}</p>
  </>;
}

export default function DealerAnalysisView({ zh }: { zh: boolean }) {
  const [data, setData] = useState<Payload | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load(refresh = false) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/dealer-analysis${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || (zh ? 'Dealer 分析读取失败' : 'Could not load the dealer analysis'));
      setData(body);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); const t = setInterval(() => void load(), POLL_MS); return () => clearInterval(t); }, []);
  const dl = data?.dealership, src = data?.sources || {};
  const sum = (f: (d: DealerSummary) => number) => (dl?.dealers || []).reduce((n, d) => n + f(d), 0);
  return <section className="table-panel da-panel">
    <div className="da-head">
      <div><h2><Store size={18} />{zh ? '五家直营店 · 库存、交付和滚动排产' : 'Our five dealerships · stock, handovers and the rolling line'}</h2>
        <p>{zh ? `Dealer Portal 数据 ${time(src.dealers?.at || src.portal?.at)} · 服务器每 2 小时自动重读，页面开着时每 30 分钟自动更新` : `Dealer Portal data ${time(src.dealers?.at || src.portal?.at)} · re-read every 2 hours automatically`}{src.plan?.at ? (zh ? ` · 月产量 ${time(src.plan.at)}` : ` · plan ${time(src.plan.at)}`) : ''}</p></div>
      <button aria-label={zh ? '刷新' : 'Refresh'} title={zh ? '马上重读' : 'Re-read now'} className={busy || data?.refreshing ? 'icon-button spinning' : 'icon-button'} disabled={busy} onClick={() => void load(true)}><RefreshCw size={15} /></button>
    </div>
    {error && <div className="message error compact-msg"><AlertTriangle size={16} />{error}</div>}
    {!data && !error && <div className="pl-loading">{zh ? '正在读取 Dealer Portal 和产线…第一次大约需要 30–40 秒' : 'Loading… the first load takes ~30–40 s'}</div>}
    {data && !dl && <div className="pl-loading">{zh ? 'Dealer Portal 的店铺数据还没读到' : 'Dealership data not available yet'}{src.dealers?.error ? `：${src.dealers.error}` : ''}</div>}
    {dl && <>
      {data?.logistics && <DealerLogisticsFlow data={data.logistics} zh={zh} />}
      <div className="da-kpis">
        <div><span>{zh ? '店里 new stock / 目标合计' : 'Yard new stock / targets'}</span><strong>{sum(d => d.yard.stock)} <small>/ {sum(d => d.target)}</small></strong></div>
        <div><span>{zh ? '在途 stock' : 'Stock in transit'}</span><strong>{sum(d => d.transit.stock)}</strong></div>
        <div><span>{zh ? `月均 stock 交付（近 ${dl.months} 个月）` : `Avg stock handovers / month`}</span><strong>{sum(d => d.handover.avgStock).toFixed(0)}</strong></div>
        <div><span>{zh ? '还缺 stock' : 'Stock needed'}</span><strong className={sum(d => d.need) ? 'short' : ''}>{sum(d => d.need)}</strong></div>
        <div><span>{zh ? '滚动排产线' : 'Rolling line'}</span><strong>{dl.picked} <small>/ {dl.size} · customer {dl.customers} · stock {sum(d => d.stockPicked)}</small></strong></div>
      </div>
      <DealerTable dl={dl} zh={zh} />
      <p className="da-note">{zh ? `到店 = 澳洲预计下线（Transport 按今天）+ ${dl.dispatchDays} 天出车 + 路上天数（Frankston、Geelong 1 天，St James、Launceston 20 天）；在途 = 已 PGI 在路上的 + 在 Transport 的：已 PGI 的按 PGI 日期 + 路上天数，Transport 的按今天 + 3 + 路上天数（已过了还没进店的按今天），只用来算车什么时候到店，不改澳洲下线日期。滚动排产线排在锁定线后面（锁定线最后一台 Towable ${dl.lockedLast}），按目标 ${dl.size} 台与全部 Customer 数量中较大者计算，到 ${dl.rollingEnd} 下线；到那天各店的 stock = 店里 + 在途 + 那天前到店的 stock − 月均 stock 交付（近 ${dl.months} 个完整月）× 月数，还缺 = 目标 − 这个数。滚动排产线纳入所有经销商的 Customer 订单（不受目标台数限制），再用剩余目标位置补直营店还缺的 Stock。Traralgon 暂不计算。目标库存：Andrew Crank 2026-10-27 邮件（Ideal Stock Qty）。` : `At the dealer = AU finish (Transport: today) + ${dl.dispatchDays} + travel days. Rolling line after the locked line (last Towable ${dl.lockedLast}); its last place ${dl.rollingEnd}.`}</p>
      <h3 className="da-sub">{zh ? '每月 stock：月底 stock = 上月底 + 到店 stock（含在途）− 卖出 stock；customer 车不算库存，这页只看 stock' : 'Stock per month: month end = previous + stock in (incl. transit) − stock sold; customer vans are not stock'}</h3>
      <div className="da-cards">{dl.dealers.map(d => <DealerCard key={d.slug} d={d} zh={zh} />)}</div>
      {dl.all?.length ? <AllDealers list={dl.all} zh={zh} today={data?.today || ''} /> : null}
    </>}
  </section>;
}
