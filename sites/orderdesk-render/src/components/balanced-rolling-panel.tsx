import { useEffect, useState } from 'react';
export type RollingRequest = { id: string; dealer: string; model: string; quantity: number; status: string; reason: string; requestedAu: string; auEnd: string; arrival: string; cnStart: string; week: string };
type Week = { week: string; fixedCustomer: number; fixedStock: number; customer: number; stock: number; newOrders: number; blocked: number; unknown: number; customerShare: number | null; plannedCustomerShare: number | null; ratioMet: boolean };
export type BalancedRolling = { status: string; quantity: number; inputToken: string; expectedId: string | null; opinionId: string | null; canGenerate: boolean;
  proposal: null | { quantity: number; scheduled: number; customerCount: number; stockCount: number; newOrders: number; inventoryBlocked: number; capacityGap: number; customerWaiting: number; earliest: string; latest: string; weeks: Week[]; requests: RollingRequest[] } };
async function readResponse(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`服务返回异常（HTTP ${response.status}），请刷新查看排产结果后重试。`); }
}
const pct = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
export default function BalancedRollingPanel({ data, zh, disabled, reload }: { data: BalancedRolling; zh: boolean; disabled: boolean; reload: () => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(data.quantity)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setQuantity(String(data.quantity)); }, [data.expectedId, data.quantity]);
  async function submit(clear = false) {
    setError('');
    const count = Number(quantity); if (!clear && (!quantity.trim() || !Number.isInteger(count) || count < 1 || count > 3000)) { setError(zh ? '请输入1–3000的整数。' : 'Enter an integer from 1 to 3000.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/rolling-plan${clear ? '/clear' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: count, background: !clear, inputToken: data.inputToken, expectedId: data.expectedId, opinionId: data.opinionId }) }), body = await readResponse(r);
      if (!r.ok) throw new Error(body.error);
      if (body.jobId) {
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          const poll = await fetch(`/api/rolling-plan/job?id=${encodeURIComponent(body.jobId)}`, { cache: 'no-store' }), job = await readResponse(poll);
          if (!poll.ok || job.status === 'failed') throw new Error(job.error || '排产失败');
          if (job.status === 'done') break;
        }
      }
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const p = data.proposal;
  return <section className="sf-rolling br-panel" aria-label={zh ? '按数量平衡排产' : 'Balanced rolling plan'}>
    <div className="sf-rolling-toolbar"><b>{zh ? '滚动排产数量' : 'Rolling quantity'}</b><input aria-label={zh ? '滚动排产数量' : 'Rolling quantity'} type="number" min={1} max={3000} value={quantity} disabled={busy || disabled} onChange={e => setQuantity(e.target.value)} />
      <button className="sf-calculate" disabled={busy || disabled || !data.canGenerate} onClick={() => void submit()}>{busy ? (zh ? '正在排产…' : 'Scheduling…') : (zh ? '按数量自动排产' : 'Generate and apply')}</button>
      {data.expectedId && <button className="pl-export" disabled={busy || disabled} onClick={() => void submit(true)}>{zh ? '撤回本次安排' : 'Clear this proposal'}</button>}
      <a href="#stock-forecast">{zh ? '库存调整预测 · 直营 / JV / Independent' : 'Stock forecast · self-owned / JV / independent'}</a></div>
    <p className="da-note">{zh ? '每周Towable澳洲下线目标：Customer 30%–40%，其余Stock。按接收窗口及产能先选库存池，保留前序固定产能；方案以已保存的取消、延期和调拨意见落实为前提。补单建议标明Dealer及车型，尚未建单或占用实际产能。比例无法达到时如实列出。' : 'Weekly Towable AU finish target: 30–40% customer, remainder stock. Prefers the pool within receiving windows and preserves fixed capacity. The proposal assumes saved cancellations, delays and transfers are implemented. New-order suggestions are not actual orders or booked production; unachievable ratios remain visible.'}</p>
    {!data.canGenerate && <p className="sf-warning">{zh ? '请先在库存调整预测中补齐必要设置并保存当前意见。' : 'Complete necessary settings and save the current stock opinion first.'}</p>}
    {data.status === 'stale' && <p className="sf-warning" role="status">{zh ? '来源或库存意见已变化，原排产暂缓；请重新生成。下方周表是原方案。' : 'Sources or inventory opinions changed. Regenerate the held proposal; the weekly table below is the previous proposal.'}</p>}
    {error && <p className="message error compact-msg" role="alert">{error}</p>}
    {p && <><div className="br-counts"><b>{zh ? `目标 ${p.quantity} · 实际订单 ${p.scheduled}（Customer ${p.customerCount} / Stock ${p.stockCount}）` : `Target ${p.quantity} · actual orders ${p.scheduled} (customer ${p.customerCount} / stock ${p.stockCount})`}</b>
      <span>{zh ? `待新建Stock ${p.newOrders} · 库存/设置受限 ${p.inventoryBlocked} · 接收及产能窗口缺口 ${p.capacityGap} · 待后续排产客户 ${p.customerWaiting}` : `New stock orders needed ${p.newOrders} · inventory/settings blocked ${p.inventoryBlocked} · window gap ${p.capacityGap} · customers waiting ${p.customerWaiting}`}</span></div>
      <details className="sf-rules" open><summary>{zh ? '每周澳洲下线 · 含前序固定产量' : 'Weekly AU finishes · includes fixed supply'}</summary><div className="da-table br-weeks"><table><thead><tr><th>{zh ? '周一' : 'Week commencing'}</th><th>Customer</th><th>Stock</th><th>{zh ? '待补Stock单' : 'Stock orders needed'}</th><th>{zh ? '受限缺口' : 'Blocked'}</th><th>{zh ? '实际订单客户比例' : 'Customer share of actual orders'}</th><th>{zh ? '补单落实后比例' : 'Share after new orders'}</th></tr></thead><tbody>{p.weeks.map(w => <tr key={w.week}><td>{w.week}</td><td title={`fixed ${w.fixedCustomer} + rolling ${w.customer}`}>{w.fixedCustomer + w.customer}</td><td title={`fixed ${w.fixedStock} + rolling ${w.stock}`}>{w.fixedStock + w.stock}</td><td>{w.newOrders}</td><td>{w.blocked}{w.unknown ? ` · ${w.unknown} ?` : ''}</td><td className={w.ratioMet ? 'br-ok' : 'br-gap'}>{pct(w.customerShare)}</td><td>{pct(w.plannedCustomerShare)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
