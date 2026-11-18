import { readApiResponse } from '../../lib/api-response.mjs';
import { useEffect, useMemo, useState } from 'react';
import { Save, Sparkles, ArrowRight, Check, X } from 'lucide-react';

export type AdjustmentSummary = { total: number; cancellations: number; delays: number; reallocations: number; poolExcluded: number };
export type PlanConfirmation = { status: 'unsaved' | 'unconfirmed' | 'confirmed' | 'stale'; inputToken: string; planId: string | null; id: string | null; reportToken: string; confirmedAt: string; confirmedBy: string; summary: AdjustmentSummary | null };
export type StockCandidate = { chassis: string; model: string; dealer: string; slug: string; group?: string; jv: boolean; signedAt: string; cnStart: string; auEnd: string; arrival: string; stockBefore: number; stockAfter: number; target: number; cap: number; reason: string; admitted: boolean };
export type StockRolling = { confirmation?: PlanConfirmation; balanced?: boolean; balancedActive?: boolean; requests?: unknown[]; status: string; planId: string | null; savedAt: string; savedBy: string; multiplier: number | null; months: number | null; items: StockCandidate[]; admitted: string[]; requested: string[]; held: Record<string, number>; token: string; aiConfigured: boolean;
  monthly: { slug: string; months: { month: string; basisArrivals?: import('./dealer-analysis-view').Arrival[]; basisIn?: number; beforeSold?: number; beforeUnmet?: number; before: number | null; after: number | null; confirmed: number | null; stockIn: number; confirmedIn: number; sold: number; unmet: number; confirmedSold: number; confirmedUnmet: number }[] }[];
  ai: null | { token: string; model: string; summary: string; notes: { chassis: string; note: string }[] } };
type Props = { zh: boolean; report: { multiplier: number; months: number; previewToken: string; expectedPlanId: string | null; canSave: boolean; rolling: StockRolling }; disabled: boolean; reload: () => Promise<void>; onBusy: (busy: boolean) => void };
const date = (d: string) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
const savedTime = (d: string) => d ? new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '';

export default function StockRollingPanel({ zh, report, disabled, reload, onBusy }: Props) {
  const p = report.rolling;
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [review, setReview] = useState<'add' | 'remove' | ''>(''), [scope, setScope] = useState('all'), [page, setPage] = useState(0);
  useEffect(() => { setSelected([]); setReview(''); setPage(0); }, [p.token, p.planId]);
  const eligible = p.items.filter(a => !a.admitted), selectedRows = p.items.filter(a => selected.includes(a.chassis));
  const rows = useMemo(() => p.items.filter(a => scope === 'all' || (a.group || (a.jv ? 'jv' : 'own')) === scope), [p.items, scope]);
  const locked = disabled || Boolean(busy);
  const currentOpinion = p.multiplier === report.multiplier && p.months === report.months;
  async function run(action: 'save' | 'confirm' | 'ai-review' | 'admissions', mode?: 'add' | 'remove', ids = selected) {
    setBusy(action); onBusy(true); setError(''); setMessage('');
    try {
      const payload = action === 'save' ? { multiplier: report.multiplier, months: report.months, previewToken: report.previewToken, expectedPlanId: report.expectedPlanId }
        : action === 'confirm' ? { planId: p.planId, inputToken: p.confirmation?.inputToken, reportToken: p.confirmation?.reportToken, expectedConfirmationId: p.confirmation?.id || null, multiplier: report.multiplier, months: report.months }
        : action === 'admissions' ? { planId: p.planId, token: p.token, mode, chassis: ids } : { planId: p.planId, token: p.token };
      const response = await fetch(`/api/stock-forecast/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), body = await readApiResponse(response);
      if (!response.ok) throw new Error(body.error || 'Could not save');
      setReview(''); setSelected([]);
      setMessage(action === 'save' ? (zh ? '库存调整计划已保存。请确认作为排产前提后，再按数量自动排产。' : 'Inventory plan saved. Confirm it as the scheduling basis before generating by quantity.')
        : action === 'confirm' ? (zh ? '已确认这份库存调整计划作为排产前提，可以进行按数量自动排产。' : 'Inventory adjustments confirmed as the scheduling basis. Generate the rolling quantity next.')
        : action === 'admissions' ? (zh ? `已${mode === 'add' ? '确认加入' : '撤回'} ${body.changed} 台。` : `${body.changed} admissions ${mode === 'add' ? 'confirmed' : 'removed'}.`) : (zh ? 'AI核对已保存。' : 'AI review saved.'));
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); onBusy(false); }
  }
  const statusText = p.status === 'unsaved' ? (zh ? '先保存当前取消、延期及转配意见，再生成库存池补货建议。' : 'Save the adjustment opinion to generate pool replenishment recommendations.')
    : p.status === 'stale' ? (zh ? '订单、库存、产能或日期已变化。旧意见待更新，已确认的库存补货暂缓显示在滚动线；请重新计算并保存。' : 'Inputs have changed. Previous stock admissions are on hold until you recalculate and save the opinion.')
    : p.status === 'sources' ? (zh ? '部分来源未成功更新，补货建议暂缓，请刷新后重新保存。' : 'Source refresh failed; refresh and save before admitting stock.')
    : p.status === 'capacity' ? (zh ? '缺少有效AU产能，暂不能给出入线时间。' : 'AU capacity is unavailable; admission dates cannot be calculated.') : '';
  const heldLabels: Record<string, string> = zh ? { duplicate: '重复/已在店或在途', cancelled: '已取消/完成', progress: 'CRM已有生产进度待核对', motorhome: 'SRV/SRM', unsigned: '未签字', dealer: 'Dealer待核对', receiving: '暂停接收/运输待补', model: '非推荐展车型号', unresolved: '该店已有到货待核对', window: '窗口内无需补货或无合适库存/产能空间' } : { duplicate: 'Duplicate / physical stock', cancelled: 'Cancelled / completed', progress: 'CRM production progress needs review', motorhome: 'SRV/SRM', unsigned: 'Unsigned', dealer: 'Dealer review', receiving: 'Receiving paused / missing transit', model: 'Outside display lineup', unresolved: 'Existing arrivals unresolved', window: 'No feasible replenishment window' };
  return <section className="sf-rolling" aria-label={zh ? '保存并确认库存调整排产前提' : 'Save and confirm inventory scheduling basis'}>
    <div className="da-subhead"><div><h3 className="da-sub">{zh ? '保存调整计划 → 确认排产前提 → 按数量自动排产' : 'Save adjustments → confirm scheduling basis → generate quantity'}</h3><p className="da-note">{p.savedAt ? `${zh ? '已保存' : 'Saved'} ${savedTime(p.savedAt)} · ${p.savedBy} · Ideal ×${p.multiplier}` : (zh ? '当前尚未保存意见' : 'No saved opinion')}</p></div>
      <div className="sf-rolling-buttons"><button className="sf-calculate" disabled={locked || !report.canSave} onClick={() => void run('save')}><Save size={13} />{busy === 'save' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存库存调整计划' : 'Save inventory adjustments')}</button>
      <button className="sf-calculate" disabled={locked || p.status !== 'ready' || !currentOpinion || !p.confirmation || p.confirmation.status === 'confirmed'} onClick={() => void run('confirm')}><Check size={13} />{busy === 'confirm' ? (zh ? '确认中…' : 'Confirming…') : p.confirmation?.status === 'confirmed' ? (zh ? '已确认为排产前提' : 'Scheduling basis confirmed') : (zh ? '确认调整计划作为排产前提' : 'Confirm adjustments as scheduling basis')}</button>
      <button className="pl-export" disabled={locked || p.status !== 'ready' || !p.aiConfigured} onClick={() => void run('ai-review')}><Sparkles size={13} />{busy === 'ai-review' ? (zh ? 'AI核对中…' : 'Reviewing…') : (zh ? 'AI核对' : 'AI review')}</button></div></div>
    <p className="da-note">{zh ? '先保存直营 / JV / Independent 的全部延期、取消及Reallocation计划，再点击确认，按数量自动排产使用这份已确认快照。库存订单池暂不生产不算入确认动作，也不会把池内订单排除出自动排产。再次保存或来源变化后须重新确认；确认保存的是排产假设，实际订单变更仍须落实。' : 'Save all self-owned / JV / independent delays, cancellations and reallocations, then confirm the snapshot as the basis for quantity scheduling. Pool do-not-build rows are excluded from confirmed adjustments and remain eligible for scheduling. Saving again or changed sources requires confirmation again. Confirming stores planning assumptions; execute actual order changes separately.'}</p>
    {p.confirmation?.summary && <div className="sf-confirmation" role="status"><p className="da-note">{zh ? `本次确认范围：取消 ${p.confirmation.summary.cancellations} 台 · 延期 ${p.confirmation.summary.delays} 台 · Reallocation ${p.confirmation.summary.reallocations} 台 · 合计 ${p.confirmation.summary.total} 个车架号（复合动作不重复计总数）。库存池不生产 ${p.confirmation.summary.poolExcluded} 台不计入。` : `Confirmation scope: ${p.confirmation.summary.cancellations} cancellations · ${p.confirmation.summary.delays} delays · ${p.confirmation.summary.reallocations} reallocations · ${p.confirmation.summary.total} distinct chassis. ${p.confirmation.summary.poolExcluded} unplanned pool rows excluded.`}</p><p className={p.confirmation.status === 'confirmed' ? 'da-note' : 'sf-warning'}>{p.confirmation.status === 'confirmed' ? (zh ? `已确认：${savedTime(p.confirmation.confirmedAt)} · ${p.confirmation.confirmedBy}。自动排产将使用这份快照。` : `Confirmed ${savedTime(p.confirmation.confirmedAt)} by ${p.confirmation.confirmedBy}. Quantity scheduling uses this snapshot.`) : (zh ? '尚未确认当前版本；按数量自动排产暂不可用。' : 'Confirm this version to enable quantity scheduling.')}</p></div>}

    {statusText && <p className="message compact-msg sf-warning" role="status">{statusText}</p>}
    {p.balanced && <p className="sf-warning">{p.balancedActive ? (zh ? '已启用按数量平衡排产。下表沿用滚动线选定的AU完工日期；修改排产数量或补单建议请到滚动排产线。' : 'Balanced rolling is enabled. Dates below match the rolling proposal; change quantities on the rolling page.') : (zh ? '库存意见或来源已更新，请回滚动排产线按数量重新生成安排。' : 'The opinion or source has changed; regenerate the rolling proposal.')}</p>}
    {p.status === 'ready' && !currentOpinion && <p className="message compact-msg sf-warning" role="status">{zh ? '当前图表参数与已保存计划不同。请先保存当前计划，再确认作为排产前提。' : 'The chart settings differ from the saved plan. Save the current plan before confirming it as the scheduling basis.'}</p>}
    {!report.canSave && <p className="da-note">{zh ? '库存、产线和产能数据需更新成功后才能保存。' : 'Stock, production and capacity sources must be available before saving.'}</p>}
    {error && <p className="message error compact-msg" role="alert">{error}</p>}{message && <p className="message success compact-msg" role="status">{message}</p>}
    {p.status === 'ready' && <>
      <div className="sf-rolling-toolbar"><b>{zh ? `可推荐 ${eligible.length} 台 · 已确认入线 ${p.admitted.length} 台` : `${eligible.length} recommended · ${p.admitted.length} admitted`}</b><select aria-label={zh ? '补货Dealer范围' : 'Replenishment dealer scope'} value={scope} onChange={e => { setScope(e.target.value); setPage(0); }}><option value="all">{zh ? '全部Dealer' : 'All dealers'}</option><option value="own">{zh ? '直营' : 'Self-owned'}</option><option value="jv">JV</option><option value="independent">Independent</option></select>
        <button className="pl-export" disabled={locked || !eligible.length} onClick={() => { setSelected(eligible.slice(0, 500).map(a => a.chassis)); setReview(''); }}>{zh ? '选择推荐车辆' : 'Select recommendations'}</button>
        <button className="sf-calculate" disabled={locked || p.balanced || !selectedRows.some(a => !a.admitted) || selectedRows.some(a => a.admitted)} onClick={() => setReview('add')}><ArrowRight size={13} />{zh ? `核对入线（${selected.length}）` : `Review admission (${selected.length})`}</button>
        <button className="pl-export" disabled={locked || p.balanced || !selectedRows.length || selectedRows.some(a => !a.admitted)} onClick={() => setReview('remove')}>{zh ? '撤回所选入线' : 'Remove selected admissions'}</button>
      </div>
      <div className="da-table sf-detail"><table><thead><tr><th>{zh ? '选择' : 'Select'}</th><th>Chassis</th><th>Model</th><th>Dealer</th><th>{zh ? '状态 / 依据' : 'Status / reason'}</th><th>{zh ? '建议国内上线' : 'Proposed CN start'}</th><th>{zh ? '预计AU完工' : 'Expected AU finish'}</th><th>{zh ? '预计到店' : 'Expected arrival'}</th><th>{zh ? '入库前 → 后' : 'Before → after'}</th><th>Ideal / {zh ? '上限' : 'cap'}</th></tr></thead><tbody>
        {rows.slice(page * 50, (page + 1) * 50).map(a => <tr key={a.chassis}><td><input type="checkbox" aria-label={`${zh ? '选择' : 'Select'} ${a.chassis}`} checked={selected.includes(a.chassis)} disabled={locked} onChange={e => { setSelected(ids => e.target.checked ? [...ids, a.chassis] : ids.filter(id => id !== a.chassis)); setReview(''); }} /></td><td><b>{a.chassis}</b></td><td>{a.model}</td><td>{a.dealer}{a.jv ? ' · JV' : ''}</td><td><span className={`pl-tag ${a.admitted ? 'rolling' : 'neutral'}`}>{a.admitted ? (zh ? '已确认Stock入线' : 'Confirmed stock') : (zh ? '推荐入线' : 'Recommended')}</span><small className="sf-reason">{a.reason === 'displayGap' ? (zh ? '补齐展车型号' : 'Display model gap') : (zh ? '补充预计消耗' : 'Replenish expected sales')}</small></td><td>{date(a.cnStart)}</td><td>{date(a.auEnd)}</td><td>{date(a.arrival)}</td><td>{a.stockBefore} → {a.stockAfter}</td><td>{a.target} / {a.cap}</td></tr>)}
        {!rows.length && <tr><td colSpan={10} className="sf-empty">{zh ? '当前没有符合条件的补货车辆。' : 'No eligible replenishment vehicles.'}</td></tr>}
      </tbody></table></div>
      <div className="sf-pager"><span>{rows.length} {zh ? '台' : 'vehicles'}</span><button disabled={page === 0 || locked} onClick={() => setPage(n => n - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 50))}</span><button disabled={(page + 1) * 50 >= rows.length || locked} onClick={() => setPage(n => n + 1)}>{zh ? '下一页' : 'Next'}</button></div>
      <p className="da-note">{Object.entries(p.held).map(([k, n]) => `${heldLabels[k] || k} ${n}`).join(' · ')}</p>
      {p.ai && p.ai.token === p.token && <details className="sf-rules" open><summary>{zh ? 'AI核对意见' : 'AI review'}</summary><p>{p.ai.summary}</p>{p.ai.notes.map(n => <p key={n.chassis}><b>{n.chassis}</b> · {n.note}</p>)}</details>}
    </>}
    {p.status !== 'ready' && !p.balanced && p.requested.length > 0 && <button className="pl-export" disabled={locked} onClick={() => { setSelected(p.requested); setReview('remove'); }}>{zh ? `撤回暂缓中的入线（${p.requested.length}台）` : `Remove held admissions (${p.requested.length})`}</button>}
    {review && <div className="sf-admit-review" role="region" aria-label={zh ? '入线确认' : 'Admission confirmation'}><strong>{review === 'add' ? (zh ? `确认把以下 ${selected.length} 台Stock加入滚动线` : `Confirm ${selected.length} stock admissions`) : (zh ? `撤回以下 ${selected.length} 台入线安排` : `Remove ${selected.length} admissions`)}</strong><p>{selected.join(' · ')}</p><div className="sf-rolling-buttons"><button className="sf-calculate" disabled={locked} onClick={() => void run('admissions', review)}><Check size={13} />{zh ? '确认保存' : 'Confirm and save'}</button><button className="pl-export" disabled={locked} onClick={() => setReview('')}><X size={13} />{zh ? '返回核对' : 'Back'}</button></div></div>}
  </section>;
}
