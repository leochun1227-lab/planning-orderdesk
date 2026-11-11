// Excel-style column filter for AG Grid Community: tick the values to keep, search to narrow the list.
// The model is the list of kept values; no model = no filter. Blank cells are one value of their own.
import { useCallback, useMemo, useState } from 'react';
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react';

export type ValueFilterModel = { values: string[] } | null;
const BLANK = '\u0000blank';
export const filterKey = (v: unknown) => {
  if (v == null) return BLANK;
  const s = String(v).trim();
  return s === '' || s === '—' ? BLANK : s;
};

export default function ValueFilter(props: CustomFilterProps<any, any, ValueFilterModel> & { zh?: boolean }) {
  const { model, onModelChange, getValue, api, column, zh } = props;
  const [all, setAll] = useState<[string, number][]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [q, setQ] = useState('');

  const collect = useCallback(() => {
    const m = new Map<string, number>(), shown = new Map<string, string>();
    api.forEachNode(n => {
      if (!n.data) return;
      const k = filterKey(getValue(n)); m.set(k, (m.get(k) || 0) + 1);
      if (k !== BLANK && !shown.has(k)) { let f: unknown; try { f = api.getCellValue({ rowNode: n, colKey: column, useFormatter: true }); } catch { f = null; } shown.set(k, f != null && String(f).trim() ? String(f) : k); }
    });
    setNames(shown);
    const list = [...m.entries()];
    const numeric = list.every(([k]) => k === BLANK || (k !== '' && !Number.isNaN(Number(k))));
    list.sort(([a], [b]) => a === BLANK ? 1 : b === BLANK ? -1 : numeric ? Number(a) - Number(b) : a.localeCompare(b, 'zh-CN', { numeric: true }));
    setAll(list);
  }, [api, getValue, column]);

  const selected = useMemo(() => model ? new Set(model.values) : null, [model]);
  const doesFilterPass = useCallback(({ node }: { node: any }) => !selected || selected.has(filterKey(getValue(node))), [selected, getValue]);
  useGridFilter({ doesFilterPass, afterGuiAttached: () => collect() });

  const label = (k: string) => k === BLANK ? (zh ? '（空白）' : '(Blanks)') : names.get(k) ?? k;
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter(([k]) => label(k).toLowerCase().includes(needle) || k.toLowerCase().includes(needle)) : all;
  const checked = (k: string) => !selected || selected.has(k);
  const commit = (keep: Set<string>) => onModelChange(all.every(([k]) => keep.has(k)) ? null : { values: [...keep] });
  const current = () => new Set(selected ?? all.map(([k]) => k));
  const toggle = (k: string) => { const keep = current(); keep.has(k) ? keep.delete(k) : keep.add(k); commit(keep); };
  const allShownChecked = shown.length > 0 && shown.every(([k]) => checked(k));
  const toggleShown = () => { const keep = current(); for (const [k] of shown) allShownChecked ? keep.delete(k) : keep.add(k); commit(keep); };
  const onlyShown = () => commit(new Set(shown.map(([k]) => k)));

  return <div className="vf">
    <input className="vf-search" autoFocus placeholder={zh ? '搜索…' : 'Search…'} value={q} onChange={e => setQ(e.target.value)} />
    <label className="vf-row vf-all"><input type="checkbox" checked={allShownChecked} onChange={toggleShown} />{needle ? (zh ? '全选搜索结果' : 'Select all matches') : (zh ? '全选' : 'Select all')}<span>{shown.reduce((n, [, c]) => n + c, 0)}</span></label>
    <div className="vf-list">
      {shown.map(([k, c]) => <label key={k} className="vf-row" title={label(k)}><input type="checkbox" checked={checked(k)} onChange={() => toggle(k)} /><em>{label(k)}</em><span>{c}</span></label>)}
      {!shown.length && <p className="vf-empty">{zh ? '没有匹配的值' : 'No matching values'}</p>}
    </div>
    <div className="vf-actions">
      {needle && <button onClick={onlyShown} disabled={!shown.length}>{zh ? '只看搜索结果' : 'Only matches'}</button>}
      <button onClick={() => { setQ(''); onModelChange(null); }} disabled={!model}>{zh ? '清除筛选' : 'Clear'}</button>
    </div>
  </div>;
}
