import { useState } from 'react';

type Props = {
  zh: boolean; displayModels: string[]; notOnYardModels: string[]; disabled: boolean;
  reload: () => Promise<void>; onBusy: (busy: boolean) => void;
};
type Draft = { recommended: string; notRecommended: string; previous: string[]; previousNotOnYardModels: string[] };
const parse = (s: string) => s.split('\n').map(m => m.trim()).filter(Boolean);

export default function StockModelEditor({ zh, displayModels, notOnYardModels, disabled, reload, onBusy }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const locked = disabled || saving;
  const changedElsewhere = draft && (JSON.stringify(draft.previous) !== JSON.stringify(displayModels) || JSON.stringify(draft.previousNotOnYardModels) !== JSON.stringify(notOnYardModels));
  function edit(field: 'recommended' | 'notRecommended', text: string) {
    setDraft(previous => ({ ...(previous || { recommended: displayModels.join('\n'), notRecommended: notOnYardModels.join('\n'), previous: [...displayModels], previousNotOnYardModels: [...notOnYardModels] }), [field]: text }));
    setSaved(false); setError('');
  }
  async function save() {
    if (!draft) return;
    setSaving(true); onBusy(true); setError(''); setSaved(false);
    try {
      const r = await fetch('/api/stock-forecast/models', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: parse(draft.recommended), notOnYardModels: parse(draft.notRecommended), previous: draft.previous, previousNotOnYardModels: draft.previousNotOnYardModels }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Could not save model lists');
      await reload(); setDraft(null); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); onBusy(false); }
  }
  return <details className="sf-rules sf-model-editor">
    <summary>{zh ? `车型清单 · 推荐 ${displayModels.length} / 不推荐 ${notOnYardModels.length} · 编辑` : `Model lists · ${displayModels.length} recommended / ${notOnYardModels.length} not recommended · edit`}</summary>
    <div className="sf-model-inputs">
      <label htmlFor="sf-recommended-models">{zh ? '推荐车型' : 'Recommended models'}
        <textarea id="sf-recommended-models" rows={3} disabled={locked} value={draft?.recommended ?? displayModels.join('\n')} onChange={e => edit('recommended', e.target.value)} />
      </label>
      <label htmlFor="sf-not-recommended-models">{zh ? '不推荐车型 · Not on yard' : 'Not recommended · Not on yard'}
        <textarea id="sf-not-recommended-models" rows={3} disabled={locked} value={draft?.notRecommended ?? notOnYardModels.join('\n')} onChange={e => edit('notRecommended', e.target.value)} />
      </label>
    </div>
    <p className="da-note">{zh ? '每行一款，可增删修改；两份清单不能重复。保存后重算，并重新保存预测意见。' : 'One model per line; add, edit or delete. A model cannot appear in both lists. Save to recalculate, then save the forecast opinion again.'}</p>
    {changedElsewhere && <p className="sf-warning" role="status">{zh ? '清单已在其他地方更新，请放弃修改后重新编辑。' : 'The lists changed elsewhere. Discard these edits and start again.'}</p>}
    {error && <p className="message error compact-msg" role="alert">{error}</p>}
    {saved && <p role="status">{zh ? '车型设置已保存。' : 'Model lists saved.'}</p>}
    <div className="sf-rolling-buttons">
      <button className="sf-calculate" disabled={locked || !draft || Boolean(changedElsewhere)} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存车型设置' : 'Save model lists')}</button>
      <button className="pl-export" disabled={locked || !draft} onClick={() => { setDraft(null); setError(''); setSaved(false); }}>{zh ? '放弃修改' : 'Discard changes'}</button>
    </div>
  </details>;
}
