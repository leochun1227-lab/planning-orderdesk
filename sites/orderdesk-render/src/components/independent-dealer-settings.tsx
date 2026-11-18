import { useState } from 'react';
type Dealer = { slug: string; name: string; target: number | null; travelDays: number | null };
export default function IndependentDealerSettings({ dealers, token, zh, disabled, reload, onBusy }: { dealers: Dealer[]; token: string; zh: boolean; disabled: boolean; reload: () => Promise<void>; onBusy: (value: boolean) => void }) {
  const [draft, setDraft] = useState<Record<string, { target: string; travelDays: string }>>({}), [draftToken, setDraftToken] = useState<string | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  async function save() {
    setSaving(true); onBusy(true); setError('');
    try {
      const rows = dealers.map(d => ({ slug: d.slug, target: draft[d.slug] ? draft[d.slug].target.trim() ? Number(draft[d.slug].target) : null : d.target,
        travelDays: draft[d.slug] ? draft[d.slug].travelDays.trim() ? Number(draft[d.slug].travelDays) : null : d.travelDays }));
      if (rows.some(d => d.target !== null && (!Number.isInteger(d.target) || d.target < 1 || d.target > 10000) || d.travelDays !== null && (!Number.isInteger(d.travelDays) || d.travelDays < 0 || d.travelDays > 365))) throw new Error(zh ? 'Ideal须为正整数，路上天数为0–365；也可留空待核对。' : 'Ideal must be a positive integer and travel days 0–365; blanks remain pending.');
      const r = await fetch('/api/stock-forecast/dealers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealers: rows, previous: draftToken }) }), body = await r.json();
      if (!r.ok) throw new Error(body.error); setDraft({}); setDraftToken(null); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); onBusy(false); }
  }
  const update = (d: Dealer, field: 'target' | 'travelDays', value: string) => { setDraftToken(old => old ?? token); setDraft(old => ({ ...old, [d.slug]: { ...(old[d.slug] || { target: d.target == null ? '' : String(d.target), travelDays: d.travelDays == null ? '' : String(d.travelDays) }), [field]: value } })); };
  const missing = dealers.filter(d => d.target == null || d.travelDays == null).length;
  return <details className="sf-rules sf-independent-settings"><summary>{zh ? 'Independent Dealers · Ideal及运输设置' : 'Independent dealers · ideal stock and transit settings'}{missing ? <span className="sf-tag warn">{zh ? `${missing} 家待补` : `${missing} incomplete`}</span> : null}</summary>
    <p>{zh ? '路上天数另加3天出车。缺少Ideal或天数时，该店暂不自动补货；请补齐后重新保存预测意见。' : 'Road days are added to 3 dispatch days. Missing ideal stock or travel days holds replenishment; save the forecast opinion again after completing them.'}</p>
    <div className="da-table sf-settings-table"><table><thead><tr><th>Dealer</th><th>Ideal</th><th>{zh ? '路上天数' : 'Travel days'}</th></tr></thead><tbody>{dealers.map(d => <tr key={d.slug}><td>{d.name}</td><td><input aria-label={`${d.name} Ideal`} placeholder={zh ? "待补" : "needed"} className={(draft[d.slug]?.target ?? d.target ?? "") === "" ? "pending" : ""} type="number" min={1} max={10000} disabled={disabled || saving} value={draft[d.slug]?.target ?? d.target ?? ''} onChange={e => update(d, 'target', e.target.value)} /></td><td><input aria-label={`${d.name} travel days`} placeholder={zh ? "待补" : "needed"} className={(draft[d.slug]?.travelDays ?? d.travelDays ?? "") === "" ? "pending" : ""} type="number" min={0} max={365} disabled={disabled || saving} value={draft[d.slug]?.travelDays ?? d.travelDays ?? ''} onChange={e => update(d, 'travelDays', e.target.value)} /></td></tr>)}</tbody></table></div>
    {error && <p className="message error compact-msg" role="alert">{error}</p>}
    {draftToken && draftToken !== token && <p className="sf-warning">{zh ? '设置已变化，请放弃修改后重新编辑。' : 'Settings changed; discard edits and start again.'}</p>}
    <div className="sf-rolling-buttons"><button className="sf-calculate" disabled={disabled || saving || !Object.keys(draft).length || draftToken !== token} onClick={() => void save()}>{zh ? '保存Dealer设置' : 'Save dealer settings'}</button>
    <button className="pl-export" disabled={disabled || saving} onClick={() => { setDraft({}); setDraftToken(null); setError(''); }}>{zh ? '放弃修改' : 'Discard'}</button></div>
  </details>;
}
