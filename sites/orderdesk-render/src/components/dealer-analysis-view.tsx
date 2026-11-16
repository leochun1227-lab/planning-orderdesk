// Dealer 分析: our five dealerships (Dealer Portal "Self-owned") — stock, transit, handovers, target stock, how many stock
// vans each still needs, and the rolling line built from it. Data: /api/dealer-analysis (read-only). The server re-reads
// the Dealer Portal every 2 hours on its own; this page re-asks the server every 30 minutes while it is open.
import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, Store } from 'lucide-react';

type HandoverMonth = { month: string; stock: number; customer: number; second: number };
type MonthRow = { month: string; stockIn: number; customerIn: number; stockOut: number; endStock: number };
export type DealerSummary = { slug: string; name: string; target: number; yard: { stock: number; customer: number; second: number; total: number }; transit: { stock: number; customer: number; second: number; total: number };
  handover: { months: HandoverMonth[]; thisMonth: HandoverMonth; avgStock: number; avgCustomer: number; avgSecond: number }; months: number; deliveredBy: string; pipeline: Record<string, number>; pipelineStock: number; pipelineCustomer: number;
  sold: number; projected: number; need: number; stockPicked: number; stockAvailable: number; customerPicked: number; monthly: MonthRow[] };
export type Dealership = { deliveredBy: string; lockedLast: string; size: number; picked: number; customers: number; offsetDays: number; months: number; targetSource: string; dealers: DealerSummary[] };
type Payload = { today: string; dealership: Dealership | null; sources: Record<string, { at: string; error: string; count: number } | undefined>; refreshing?: boolean; error?: string };

const POLL_MS = 30 * 60 * 1000;
const time = (v?: string) => v ? new Date(v).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const GROUP_ZH: Record<string, string> = { transport: 'Transport', au: '澳洲生产', sea: '海运', cn: '国内生产', locked: '排产锁定线' };

/** Per dealership: yard, transit, last three months of handovers, the stock target and how much stock is still needed. */
export function DealerTable({ dl, zh }: { dl: Dealership; zh: boolean }) {
  const m = dl.dealers[0]?.handover.months.map(x => x.month.slice(5)) || [];
  return <div className="da-table"><table>
    <thead><tr>
      <th>Dealer</th><th>{zh ? '目标库存' : 'Target'}</th><th>{zh ? '店里 new stock' : 'Yard new stock'}</th><th>{zh ? '店里 customer / 二手' : 'Yard customer / 2nd'}</th><th>{zh ? '在途 stock / customer' : 'Transit stock / customer'}</th>
      <th title={zh ? '交付按排产表客户名分 stock / customer，同 Dealer Portal YTD Handover' : 'As the Dealer Portal YTD Handover'}>{zh ? `近三月交付 stock（${m.join(' / ')} 月）` : `Stock handovers (${m.join(' / ')})`}</th><th>{zh ? '月均 stock / customer' : 'Avg / month stock / customer'}</th>
      <th title={zh ? 'Transport、澳洲生产、海运、国内生产、排产锁定线里这家的 stock 订单' : 'Stock orders of this dealer from Transport to the locked line'}>{zh ? '线上 stock' : 'Stock on the line'}</th>
      <th title={zh ? `店里 + 在途 + 线上 stock − 月均 stock 交付 × 到 ${dl.deliveredBy} 的月数` : ''}>{zh ? `${dl.deliveredBy} 预计 stock` : `Stock by ${dl.deliveredBy}`}</th><th>{zh ? '还缺' : 'Need'}</th><th>{zh ? '排进滚动 stock / customer' : 'Rolling stock / customer'}</th>
    </tr></thead>
    <tbody>{dl.dealers.map(d => <tr key={d.slug}>
      <td><b>{d.name}</b></td><td>{d.target}</td><td className={d.yard.stock > d.target ? 'over' : ''}><b>{d.yard.stock}</b></td><td>{d.yard.customer} / {d.yard.second}</td><td>{d.transit.stock} / {d.transit.customer}</td>
      <td>{d.handover.months.map(x => x.stock).join(' / ')}<small> · {zh ? '本月' : 'MTD'} {d.handover.thisMonth.stock}</small></td><td>{d.handover.avgStock} / {d.handover.avgCustomer}</td>
      <td title={Object.entries(d.pipeline).map(([g, n]) => `${zh ? GROUP_ZH[g] || g : g} ${n}`).join(' · ')}>{d.pipelineStock}</td>
      <td title={`${d.yard.stock} + ${d.transit.stock} + ${d.pipelineStock} − ${d.sold} (${d.handover.avgStock} × ${d.months})`} className={d.projected < d.target ? 'short' : 'over'}>{d.projected}</td>
      <td className={d.need ? 'short' : ''}><b>{d.need}</b></td>
      <td>{d.stockPicked} / {d.customerPicked}{d.need > d.stockPicked ? <small className="short"> {zh ? `stock 订单只有 ${d.stockAvailable} 台，还差 ${d.need - d.stockPicked}` : `only ${d.stockAvailable} stock orders, ${d.need - d.stockPicked} short`}</small> : null}</td>
    </tr>)}</tbody>
  </table></div>;
}

function DealerCard({ d, zh }: { d: DealerSummary; zh: boolean }) {
  const max = Math.max(1, ...d.monthly.map(x => x.stockIn + x.customerIn), ...d.monthly.map(x => x.endStock), d.target);
  return <article className="da-card">
    <header><div><strong>{d.name}</strong><span>{zh ? `目标 ${d.target} · 店里 new stock ${d.yard.stock} · 在途 ${d.transit.total}` : `Target ${d.target} · yard ${d.yard.stock} · transit ${d.transit.total}`}</span></div>
      <b className={d.need ? 'short' : 'ok'}>{d.need ? (zh ? `还缺 ${d.need}` : `Need ${d.need}`) : (zh ? '不缺' : 'OK')}</b></header>
    <div className="da-bars" title={zh ? '每月预计到店（澳洲预计下线 + 21 天）：蓝 = stock，绿 = customer；线 = 月底 stock，虚线 = 目标' : ''}>
      {d.monthly.map(x => <div key={x.month} className="da-bar">
        <div className="da-stack" style={{ height: 96 }}>
          <i className="cust" style={{ height: `${(x.customerIn / max) * 96}px` }} /><i className="stock" style={{ height: `${(x.stockIn / max) * 96}px` }} />
          <em style={{ bottom: `${Math.max(0, Math.min(1, x.endStock / max)) * 96}px` }} className={x.endStock < d.target ? 'low' : ''} title={`${zh ? '月底 stock' : 'Stock at month end'} ${x.endStock}`} />
        </div>
        <span>{x.month.slice(2).replace('-', '/')}</span><small>{x.stockIn}/{x.customerIn}</small><small className={x.endStock < d.target ? 'short' : ''}>{x.endStock}</small>
      </div>)}
      <div className="da-target" style={{ bottom: `${(d.target / max) * 96 + 34}px` }} />
    </div>
    <table className="da-mini"><thead><tr><th>{zh ? '交付' : 'Handovers'}</th>{d.handover.months.map(x => <th key={x.month}>{x.month.slice(5)}{zh ? '月' : ''}</th>)}<th>{zh ? '本月' : 'MTD'}</th><th>{zh ? '月均' : 'Avg'}</th></tr></thead>
      <tbody>{([['stock', 'Stock', d.handover.avgStock], ['customer', 'Customer', d.handover.avgCustomer], ['second', zh ? '二手' : '2nd hand', d.handover.avgSecond]] as const).map(([k, l, a]) => <tr key={k}><td>{l}</td>{d.handover.months.map(x => <td key={x.month}>{x[k]}</td>)}<td>{d.handover.thisMonth[k]}</td><td><b>{a}</b></td></tr>)}</tbody></table>
  </article>;
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
      <div className="da-kpis">
        <div><span>{zh ? '店里 new stock / 目标合计' : 'Yard new stock / targets'}</span><strong>{sum(d => d.yard.stock)} <small>/ {sum(d => d.target)}</small></strong></div>
        <div><span>{zh ? '在途（stock / customer）' : 'In transit (stock / customer)'}</span><strong>{sum(d => d.transit.total)} <small>{sum(d => d.transit.stock)} / {sum(d => d.transit.customer)}</small></strong></div>
        <div><span>{zh ? `月均交付 stock / customer（近 ${dl.months} 个月）` : `Avg handovers / month`}</span><strong>{sum(d => d.handover.avgStock).toFixed(0)} <small>/ {sum(d => d.handover.avgCustomer).toFixed(0)}</small></strong></div>
        <div><span>{zh ? '还缺 stock' : 'Stock needed'}</span><strong className={sum(d => d.need) ? 'short' : ''}>{sum(d => d.need)}</strong></div>
        <div><span>{zh ? '滚动排产线' : 'Rolling line'}</span><strong>{dl.picked} <small>/ {dl.size} · customer {dl.customers} · stock {sum(d => d.stockPicked)}</small></strong></div>
      </div>
      <DealerTable dl={dl} zh={zh} />
      <p className="da-note">{zh ? `预计 stock 按滚动排产线到店的时间算：排产锁定线最后一台澳洲预计下线 ${dl.lockedLast} + ${dl.offsetDays} 天 = ${dl.deliveredBy}；月均交付取近 ${dl.months} 个完整月；还缺 = 目标 − 预计 stock。滚动排产线：五家的 customer 订单先排，再补还缺的 stock（用这家自己的 stock 订单），最多 ${dl.size} 台。目标库存：Andrew Crank 2026-10-27 邮件（Ideal Stock Qty）。` : `Stock by ${dl.deliveredBy} = last locked AU finish ${dl.lockedLast} + ${dl.offsetDays} days; average of the last ${dl.months} full months; targets from Andrew Crank's 2026-10-27 email.`}</p>
      <h3 className="da-sub">{zh ? '每月预计到店和月底 stock（到店 = 澳洲预计下线 + 21 天；每列下面：到店 stock/customer，月底 stock）' : 'Arrivals per month and stock at month end'}</h3>
      <div className="da-cards">{dl.dealers.map(d => <DealerCard key={d.slug} d={d} zh={zh} />)}</div>
    </>}
  </section>;
}
