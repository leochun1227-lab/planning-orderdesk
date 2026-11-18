import { readApiResponse } from '../../lib/api-response.mjs';
import { useEffect, useState } from 'react';
export type RollingRequest = { id: string; dealer: string; model: string; quantity: number; status: string; reason: string; requestedAu: string; auEnd: string; arrival: string; cnStart: string; week: string };
type Week = { week: string; target: number; fixedCustomer: number; fixedStock: number; customer: number; stock: number; newOrders: number; blocked: number; unknown: number; customerShare: number | null; plannedCustomerShare: number | null; ratioMet: boolean };
type Coverage = { group: string; customer: number; stock: number; actual: number | null; actualIdeal: number | null; stockMonths: number | null; plannedIdeal: number | null; plannedStockMonths: number | null; missing: number };
export type BalancedRolling = { customerPercent?: number; status: string; quantity: number; inputToken: string; expectedId: string | null; opinionId: string | null; canGenerate: boolean;
  proposal: null | { id: string; customerPercent?: number; quantityMet?: boolean; actualGap?: number; report?: { asOf: string; handoverMonths: number; groups: Coverage[] }; quantity: number; scheduled: number; customerCount: number; stockCount: number; newOrders: number; inventoryBlocked: number; capacityGap: number; customerWaiting: number; earliest: string; latest: string; weeks: Week[]; requests: RollingRequest[] } };
const times = (v: number | null) => v == null ? 'N/A' : v.toFixed(2);
const pct = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
export default function BalancedRollingPanel({ data, zh, disabled, reload }: { data: BalancedRolling; zh: boolean; disabled: boolean; reload: () => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(data.quantity)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [customerPercent, setCustomerPercent] = useState(String(data.customerPercent ?? 35)), [downloading, setDownloading] = useState(false);
  useEffect(() => { setQuantity(String(data.quantity)); setCustomerPercent(String(data.customerPercent ?? 35)); }, [data.expectedId, data.quantity, data.customerPercent]);
  async function submit(clear = false) {
    setError('');
    const count = Number(quantity); if (!clear && (!quantity.trim() || !Number.isInteger(count) || count < 1 || count > 3000)) { setError(zh ? '请输入1–3000的整数。' : 'Enter an integer from 1 to 3000.'); return; }
    if (!clear && (!customerPercent.trim() || !Number.isFinite(Number(customerPercent)) || Number(customerPercent) < 0 || Number(customerPercent) > 100)) { setError(zh ? '客户比例须为0–100%。' : 'Customer percentage must be between 0 and 100.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/rolling-plan${clear ? '/clear' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: count, customerPercent: Number(customerPercent), background: !clear, inputToken: data.inputToken, expectedId: data.expectedId, opinionId: data.opinionId }) }), body = await readApiResponse(r);
      if (!r.ok) throw new Error(body.error);
      if (body.jobId) {
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          const poll = await fetch(`/api/rolling-plan/job?id=${encodeURIComponent(body.jobId)}`, { cache: 'no-store' }), job = await readApiResponse(poll);
          if (!poll.ok || job.status === 'failed') throw new Error(job.error || '排产失败');
          if (job.status === 'done') break;
        }
      }
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function download() {
    if (!data.proposal) return;
    setDownloading(true); setError('');
    try {
      const r = await fetch(`/api/rolling-plan/report.pdf?id=${encodeURIComponent(data.proposal.id)}`, { cache: 'no-store' });
      if (!r.ok || !r.headers.get('content-type')?.includes('application/pdf')) { const body = await readApiResponse(r); throw new Error(body.error || 'Report download failed'); }
      const url = URL.createObjectURL(await r.blob()), link = document.createElement('a');
      link.href = url; link.download = 'Rolling_Production_Report.pdf'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setDownloading(false); }
  }
  const p = data.proposal;
  return <section className="sf-rolling br-panel" aria-label={zh ? '按数量平衡排产' : 'Balanced rolling plan'}>
    <div className="br-head"><h3>{zh ? '按数量平衡排产' : 'Balanced rolling plan'}</h3><a className="br-link" href="#stock-forecast">{zh ? '打开库存调整预测 →' : 'Open stock forecast →'}</a></div>
    <div className="sf-rolling-toolbar"><b>{zh ? '滚动排产数量' : 'Rolling quantity'}</b><input aria-label={zh ? '滚动排产数量' : 'Rolling quantity'} type="number" min={1} max={3000} value={quantity} disabled={busy || disabled} onChange={e => setQuantity(e.target.value)} />
      <label>{zh ? '每周 Customer % ' : 'Weekly Customer % '}<input aria-label="Weekly Customer percentage" type="number" min={0} max={100} step="0.1" value={customerPercent} disabled={busy || disabled} onChange={e => setCustomerPercent(e.target.value)} /></label><span>Stock {customerPercent.trim() && Number(customerPercent) >= 0 && Number(customerPercent) <= 100 ? `${+(100 - Number(customerPercent)).toFixed(1)}%` : '—'}</span>
      <button className="sf-calculate" disabled={busy || disabled || !data.canGenerate} onClick={() => void submit()}>{busy ? (zh ? '正在排产…' : 'Scheduling…') : (zh ? '按数量自动排产' : 'Generate and apply')}</button>
      {data.expectedId && <button className="pl-export" disabled={busy || disabled} onClick={() => void submit(true)}>{zh ? '撤回本次安排' : 'Clear this proposal'}</button>}
      {p?.report && <button className="pl-export" disabled={busy || downloading || disabled} onClick={() => void download()}>{downloading ? (zh ? '下载中…' : 'Downloading…') : (zh ? '下载排产报告 PDF' : 'Download production report PDF')}</button>}
    </div>
    <p className="da-note">{zh ? '数量优先，Customer / Stock 按每周目标比例穿插（整车取整）。已签字客户及Stock先留在订单池，生成后才选入；客户按收到签字图日期先后排序，需求交付日期 ≤ 澳洲下线日期。Stock按直营 → JV → Independent，同组优先补预计库存/Ideal最低的店。保留库存上限及前序固定产能。真实订单不足时单列待新建订单及缺口。' : 'Quantity first; spread the requested Customer / Stock mix across each week with whole-unit rounding. Signed orders stay in the pool until selected. Customers follow signed-plan receipt order; requested delivery <= AU finish. Stock priority: own → JV → independent, lowest projected Stock / Ideal first. Inventory ceilings and fixed capacity remain. Draft orders and gaps are separate.'}</p>
    {!data.canGenerate && <p className="sf-warning">{zh ? '请先在库存调整预测中补齐必要设置并保存当前意见。' : 'Complete necessary settings and save the current stock opinion first.'}</p>}
    {data.status === 'stale' && <p className="sf-warning" role="status">{zh ? '来源或库存意见已变化，原排产暂缓；请重新生成。下方数据及PDF为原方案快照。' : 'Sources or inventory opinions changed. Regenerate the held proposal; data and PDF below are the saved snapshot.'}</p>}
    {error && <p className="message error compact-msg" role="alert">{error}</p>}
    {p && <><p className={p.quantityMet ? 'da-note' : 'sf-warning'} role="status">{zh ? `本期目标 ${p.quantity} 台，真实订单已排 ${p.scheduled} 台，尚缺 ${p.actualGap ?? p.quantity - p.scheduled} 台。已保存每周客户目标 ${p.customerPercent ?? 35}%。` : `Target ${p.quantity}; ${p.scheduled} real orders scheduled; ${p.actualGap ?? p.quantity - p.scheduled} remaining. Saved weekly Customer target: ${p.customerPercent ?? 35}%.`}</p><div className="br-counts">
      {([
        ['', zh ? '目标' : 'Target', p.quantity], ['main', zh ? '真实订单已排' : 'Real orders', p.scheduled], ['cust', 'Customer', p.customerCount], ['stock', 'Stock', p.stockCount],
        ['warn', zh ? '待新建Stock' : 'New stock orders needed', p.newOrders], ['warn', zh ? '库存/设置受限' : 'Inventory/settings blocked', p.inventoryBlocked],
        ['warn', zh ? '接收及产能窗口缺口' : 'Window gap', p.capacityGap], ['', zh ? '待后续排产客户' : 'Customers waiting', p.customerWaiting],
      ] as [string, string, number][]).map(([tone, label, value]) => <span key={label} className={`br-chip ${tone} ${value ? '' : 'zero'}`}>{label}<b>{value}</b></span>)}
    </div>
      {p.report && <details className="sf-rules" open><summary>{zh ? `排产后库存覆盖 · ${p.report.asOf}` : `Stock coverage after scheduling · ${p.report.asOf}`}</summary><div className="da-table"><table><thead><tr><th>Dealer group</th><th>Customer</th><th>Stock</th><th>{zh ? '预计Stock' : 'Projected Stock'}</th><th>Stock / Ideal</th><th>{zh ? 'Stock / 平均月交付' : 'Stock / avg monthly handovers'}</th><th>{zh ? '补单后 / Ideal' : 'With drafts / Ideal'}</th><th>{zh ? '补单后覆盖月数' : 'With drafts: months'}</th></tr></thead><tbody>{p.report.groups.map(g => <tr key={g.group}><td>{g.group === 'own' ? (zh ? '直营' : 'Self-owned') : g.group === 'jv' ? 'JV' : 'Independent'}{g.missing ? ` (${g.missing} N/A)` : ''}</td><td>{g.customer}</td><td>{g.stock}</td><td>{times(g.actual)}</td><td>{times(g.actualIdeal)}×</td><td>{times(g.stockMonths)}</td><td>{times(g.plannedIdeal)}×</td><td>{times(g.plannedStockMonths)}</td></tr>)}</tbody></table></div><p className="da-note">{zh ? `按同一日期预计Towable Stock测算，已扣除预计Stock交付，含已保存调整及前序到货。分母为前${p.report.handoverMonths}个完整月的平均Stock交付量；库存/交付量表示覆盖月数。汇总采用总库存÷总Ideal或总平均交付。待新建订单单独计算，零分母显示N/A。PDF含各店、Model、Model range及订单明细。` : `Towable Stock projected at one date, after expected Stock handovers, saved adjustments and fixed inbound supply. Cover uses the previous ${p.report.handoverMonths} complete months' average Stock handovers. Group ratios divide summed inventory by summed denominators. Draft orders are separate; zero denominators show N/A. PDF includes dealer, model, range and order details.`}</p></details>}
      <details className="sf-rules" open><summary>{zh ? '每周澳洲下线 · 本次滚动排产比例' : 'Weekly AU finishes · this rolling proposal'}</summary><div className="da-table br-weeks"><table><thead><tr><th>{zh ? '周一' : 'Week commencing'}</th><th>Customer</th><th>Stock</th><th>{zh ? '待补Stock单' : 'Stock orders needed'}</th><th>{zh ? '受限缺口' : 'Blocked'}</th><th>{zh ? '实际订单客户比例' : 'Customer share of actual orders'}</th><th>{zh ? '补单落实后比例' : 'Share after new orders'}</th><th>{zh ? '前序固定 C / S' : 'Fixed C / S'}</th></tr></thead><tbody>{p.weeks.map(w => <tr key={w.week}><td>{w.week}</td><td title={`fixed ${w.fixedCustomer} + rolling ${w.customer}`}>{w.customer}</td><td title={`fixed ${w.fixedStock} + rolling ${w.stock}`}>{w.stock}</td><td>{w.newOrders}</td><td>{w.blocked}{w.unknown ? ` · ${w.unknown} ?` : ''}</td><td className={w.ratioMet ? 'br-ok' : 'br-gap'}>{pct(w.customerShare)}</td><td>{pct(w.plannedCustomerShare)}</td><td>{w.fixedCustomer} / {w.fixedStock}</td></tr>)}</tbody></table></div><p className="da-note">{zh ? '每周目标按整台取整；数量优先。就绪客户或安全库存不足时会偏离比例。' : 'Weekly targets round to whole vehicles; quantity comes first. Readiness or safe-stock constraints may cause mix deviations.'}</p></details>
    </>}
  </section>;
}
